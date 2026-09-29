#!/usr/bin/env node
/**
 * Which workers need shipping, decided by what would actually ship rather than by which files
 * changed. Run from the repo root by the ci workflow:
 *
 *   node core/ship.mjs plan [--all | --pr=<base sha>]
 *                                     build and fingerprint every worker; print the ones to ship
 *   node core/ship.mjs wrangler       the wrangler package to run, e.g. wrangler@4.143.0
 *   node core/ship.mjs previews       the folders of workers that get a Preview on a pull request
 *
 * `plan` builds each worker under workers/ exactly as `wrangler deploy` would (a dry run into
 * bundles/<name>/), and fingerprints the bundle together with the worker's wrangler.json. It
 * compares that with the tag on the version Cloudflare is serving, and prints, as JSON for a
 * GitHub Actions matrix, the workers whose fingerprint differs (every worker with --all). A deploy
 * stores the fingerprint as the new version's tag (`wrangler deploy --tag`), which is what the next
 * plan reads back. So a core/ change that a worker does not import leaves that worker's bundle,
 * its fingerprint and the worker alone, and a README edit ships nothing.
 *
 * On a pull request (--pr), a changed worker goes on only when Cloudflare has something to check:
 * its wrangler.json changed since the PR's base (a setting the plan refuses, a binding that does not
 * resolve, a missing secret all live there), or it gets a Preview. A code-only change is compiled
 * here and uploads nothing, so a PR does not push unmerged versions to the top of the worker's
 * version list.
 *
 * Building needs only wrangler: no worker has npm dependencies of its own.
 *
 * It lives in core/ so that stef7/watchdog's vendored copy keeps both repos' pipelines the same.
 *
 * Env: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to read what is live (without them, every
 * worker counts as changed); WRANGLER to pin the wrangler run (otherwise the lockfile's version).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const OUT = "bundles";

const wrangler = () => {
  if (process.env.WRANGLER) return process.env.WRANGLER;
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  return `wrangler@${lock.packages["node_modules/wrangler"].version}`;
};

const workers = () =>
  readdirSync("workers", { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join("workers", d.name, "wrangler.json")))
    .map((d) => {
      const dir = join("workers", d.name);
      return { dir, cfg: JSON.parse(readFileSync(join(dir, "wrangler.json"), "utf8")) };
    });

/** Only a worker you can open in a browser, and that says what a Preview binds, gets one. */
const previews = (cfg) => cfg.workers_dev === true && "previews" in cfg;

/**
 * Everything wrangler would upload, less the README it writes beside the bundle (which carries a
 * timestamp, so no two builds would ever match) and source maps (which are not uploaded).
 */
const uploaded = async (out) =>
  (await readdir(out, { recursive: true, withFileTypes: true }))
    .filter((f) => f.isFile() && f.name !== "README.md" && !f.name.endsWith(".map"))
    .map((f) => join(f.parentPath, f.name))
    .sort();

const fingerprint = async (dir, out) => {
  const hash = createHash("sha256");
  for (const file of [join(dir, "wrangler.json"), ...(await uploaded(out))]) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(file))
      .update("\0");
  }
  return hash.digest("hex").slice(0, 24);
};

const api = async (path) => {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}${path}`,
    { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } },
  );
  if (res.status === 404) return null;
  // Anything else going wrong is a failure: guessing "changed" would hide a broken token.
  if (!res.ok) throw new Error(`Cloudflare answered HTTP ${res.status} for ${path}`);
  return (await res.json()).result;
};

/** Whether the worker exists, and the tag of the one version serving all its traffic, if any. */
const live = async (name) => {
  const listed = await api(`/workers/scripts/${name}/deployments`);
  if (!listed) return { exists: false, tag: null };
  // The first deployment listed is the one serving traffic. A split between versions (a gradual
  // deployment) has no single fingerprint, so it counts as changed.
  const [only, ...rest] = listed.deployments?.[0]?.versions ?? [];
  if (!only || rest.length) return { exists: true, tag: null };
  const version = await api(`/workers/scripts/${name}/versions/${only.version_id}`);
  return { exists: true, tag: version?.annotations?.["workers/tag"] ?? null };
};

const build = async (w, dir, out) => {
  try {
    await run("npx", ["--yes", w, "deploy", "--dry-run", "--outdir", resolve(out)], {
      cwd: dir,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`${dir} did not build:\n${e.stderr || e.stdout || e.message}`);
  }
};

/** Whether a worker's wrangler.json differs from the PR's base. Needs the base in the clone. */
const configChanged = async (dir, base) => {
  try {
    await run("git", ["diff", "--quiet", `${base}...HEAD`, "--", join(dir, "wrangler.json")]);
    return false;
  } catch (e) {
    if (e.code === 1) return true;
    throw new Error(`git could not compare ${dir}/wrangler.json with ${base}:\n${e.stderr}`);
  }
};

const plan = async ({ all, pr }) => {
  const w = wrangler();
  // Installed once up front, so the parallel builds below do not race to install it.
  await run("npx", ["--yes", w, "--version"]);
  await rm(OUT, { recursive: true, force: true });
  const known = Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);
  const rows = await Promise.all(
    workers().map(async ({ dir, cfg }) => {
      const out = join(OUT, cfg.name);
      await build(w, dir, out);
      // The bundle is named after the entry point: src/index.ts becomes index.js.
      const entry = basename(cfg.main).replace(/\.[cm]?[jt]sx?$/, ".js");
      if (!existsSync(join(out, entry))) throw new Error(`${dir} built no ${entry}`);
      const print = await fingerprint(dir, out);
      const { exists, tag } = known ? await live(cfg.name) : { exists: true, tag: null };
      return {
        dir,
        name: cfg.name,
        entry,
        fingerprint: print,
        exists,
        live: tag,
        preview: previews(cfg),
        config: pr ? await configChanged(dir, pr) : true,
      };
    }),
  );
  const changed = (r) => all || r.fingerprint !== r.live;
  const ship = rows.filter((r) => changed(r) && (r.config || r.preview));
  const why = (r) =>
    all
      ? "all"
      : !r.exists
        ? "new"
        : r.live === null
          ? "live has no fingerprint"
          : pr && r.config
            ? "config changed"
            : "changed";
  const verdict = (r) =>
    !changed(r)
      ? "unchanged"
      : ship.includes(r)
        ? `${pr ? (r.preview ? "preview" : "upload") : "ship"} (${why(r)})`
        : "code only: compiled, not uploaded";
  const heading = pr
    ? `${ship.length} of ${rows.length} workers to check on Cloudflare`
    : `${ship.length} of ${rows.length} workers to ship${all ? " (all, by hand)" : ""}`;
  // The log gets a table of its own, on stderr: stdout carries the JSON the workflow reads.
  const log = new console.Console(process.stderr);
  log.log(heading);
  log.table(
    Object.fromEntries(
      rows.map((r) => [r.name, { Built: r.fingerprint, Live: r.live ?? "—", Ship: verdict(r) }]),
    ),
  );
  // The run's summary page renders markdown, so it keeps a markdown table.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = rows.map(
      (r) => `| \`${r.name}\` | \`${r.fingerprint}\` | \`${r.live ?? "—"}\` | ${verdict(r)} |`,
    );
    const table = ["| Worker | Built | Live | |", "| --- | --- | --- | --- |", ...md];
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [`### ${heading}`, "", ...table, ""].join("\n"),
    );
  }
  console.log(JSON.stringify(ship.map(({ live: _, config: __, ...r }) => r)));
};

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "plan") {
  const pr = args.find((a) => a.startsWith("--pr="))?.slice("--pr=".length);
  await plan({ all: args.includes("--all"), pr });
} else if (cmd === "wrangler") console.log(wrangler());
else if (cmd === "previews") {
  for (const { dir, cfg } of workers()) if (previews(cfg)) console.log(dir);
} else {
  console.error("usage: node core/ship.mjs plan [--all | --pr=<base sha>] | wrangler | previews");
  process.exit(2);
}
