/**
 * The one place that talks to Printify: adds the token and the User-Agent, waits out a 429, and
 * turns every way a request can go wrong into a value. Nothing here throws, and nothing it
 * returns can contain the token.
 */
import { version } from "../package.json";

/** Printify rejects requests without a User-Agent, and a Worker sends none unless told to. */
export const UA = `mcp-printify/${version} (MCP server for the Printify API, on Cloudflare Workers)`;

/** Tries after the first, for a 429 only. */
const RETRIES = 3;
/** The longest single wait worth sitting through inside one tool call. */
const MAX_WAIT_S = 10;
const TIMEOUT_MS = 30_000;

export type Sent = {
  status: number;
  ok: boolean;
  /** Printify's answer: parsed JSON where it is JSON, otherwise the text. */
  data: unknown;
  /** How many times a 429 was waited out before this answer. */
  retried: number;
};
export type Failed = { problem: string };

/** Removes the token from anything about to leave the worker, should an upstream ever echo it. */
export const scrub = (text: string, env: Env) => {
  const token = env.PRINTIFY_TOKEN?.trim();
  return token ? text.replaceAll(token, "[PRINTIFY_TOKEN]") : text;
};
const scrubbed = (v: unknown, env: Env): unknown =>
  typeof v === "string"
    ? scrub(v, env)
    : v === undefined
      ? v
      : JSON.parse(scrub(JSON.stringify(v), env));

export const NO_TOKEN =
  "PRINTIFY_TOKEN is not set on this worker. Create a personal access token in Printify " +
  "(Account -> Connections), then: npx wrangler secret put PRINTIFY_TOKEN";

/** What a status code usually means here, said once so every tool words it the same way. */
const hint = (status: number) =>
  status === 401
    ? " Printify did not accept PRINTIFY_TOKEN: it is wrong, expired or revoked."
    : status === 403
      ? " The token lacks the scope for this, or the shop belongs to another account."
      : status === 404
        ? " Check the IDs: Printify answers 404 for a shop, product or order it cannot see."
        : "";

/** Printify's own words for an error, whatever shape it chose to put them in. */
export const explain = (r: Sent) => {
  const said = typeof r.data === "string" ? r.data.slice(0, 2000) : JSON.stringify(r.data);
  return `Printify answered HTTP ${r.status}.${hint(r.status)}${said ? ` It said: ${said}` : ""}`;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One request to Printify. `target` is a path with its query string, already validated.
 *
 * A 429 is waited out: for as long as Retry-After asks when that is at most ten seconds,
 * otherwise 1, 2 then 4 seconds. A longer Retry-After, or a fourth 429, comes back as a problem
 * that says how long to wait, since a tool call is no place to sleep for minutes. Retrying is
 * safe for writes too: a 429 means Printify did not act on the request.
 */
export const send = async (
  env: Env,
  server: string,
  method: string,
  target: string,
  body?: unknown,
): Promise<Sent | Failed> => {
  const token = env.PRINTIFY_TOKEN?.trim();
  if (!token) return { problem: NO_TOKEN };
  const base = (env.PRINTIFY_API_URL?.trim() || server).replace(/\/+$/, "");
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(base + target, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": UA,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json;charset=utf-8" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { problem: scrub(`Could not reach Printify (${method} ${target}): ${why}`, env) };
    }
    if (res.status === 429) {
      const asked = Number(res.headers.get("retry-after"));
      const wait = res.headers.has("retry-after") && asked >= 0 ? asked : 2 ** attempt;
      await res.body?.cancel();
      if (attempt >= RETRIES || wait > MAX_WAIT_S)
        return {
          problem:
            `Printify's rate limit was hit (HTTP 429 on ${method} ${target}` +
            (attempt ? `, ${attempt + 1} times over ${waited}s` : "") +
            `). Nothing was changed by this request. Wait ` +
            (wait > 0 ? `${wait} seconds` : "a minute") +
            " before trying again, and make fewer calls: Printify allows 600 requests a " +
            "minute overall, 100 a minute on the catalogue, and 200 publishes per 30 minutes.",
        };
      await sleep(wait * 1000);
      waited += wait;
      continue;
    }
    const text = await res.text().catch(() => "");
    let data: unknown = text;
    try {
      if (text) data = JSON.parse(text);
    } catch {
      // Not JSON (a gateway's HTML error page, say): the text itself is the answer.
    }
    return { status: res.status, ok: res.ok, data: scrubbed(data, env), retried: attempt };
  }
};
