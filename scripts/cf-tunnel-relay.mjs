#!/usr/bin/env node
/**
 * The far end of the tunnel route in core/egress.ts. Runs on the Mac; cloudflared carries
 * mcp-fetch's requests to it through the VPC Service `wmac` (localhost:8811), and it fetches the
 * URL it is handed from this machine's own connection.
 *
 *   node scripts/cf-tunnel-relay.mjs [port]       default 8811
 *   node scripts/cf-tunnel-relay.mjs login [url]  Chrome in a window, to sign in or pass a check
 *
 *   ALLOW_DOMAINS=example.org,acnc.gov.au      optional: refuse every other domain
 *   BROWSER_ALLOW_DOMAINS=example.org          browser mode is off for every domain not listed
 *   CF_TUNNEL_RELAY_CLOUDFLARED=/path/to/cloudflared   also run the tunnel's connector (see THE
 *                                                      CONNECTOR below)
 *
 *   GET /fetch?url=<absolute url>               the site's answer: status, headers and body
 *   GET /fetch?url=<absolute url>&mode=browser  the same, as Chrome ended up with it
 *   GET /health                                 "ok", for checking by hand
 *
 * Listens on loopback only, so the one way in is through the tunnel, and from there only a
 * Worker holding the binding. It still refuses private and loopback addresses — including at each
 * redirect — so a URL typed into a tool cannot be used to look around the home network. The check
 * runs inside the socket's own DNS lookup, so the address checked is the address connected to: a
 * name that answers public for the check and private for the connection gets nowhere.
 *
 * `ALLOW_DOMAINS` narrows it further: a comma-separated list, each entry also covering its
 * subdomains, checked at every hop as well.
 *
 * BROWSER MODE loads the page in Brave on this Mac, with a profile of its own
 * (~/.cf-tunnel-relay/profile, or CF_TUNNEL_RELAY_PROFILE) that keeps cookies between loads: a
 * challenge passed or a sign-in made with `login` holds for later ones. The answer is the rendered
 * HTML, or the raw body of anything that is not HTML. Whoever can call mcp-fetch can read whatever
 * that profile can, so browser mode is refused for every domain not in `BROWSER_ALLOW_DOMAINS` (and
 * `ALLOW_DOMAINS`, when set), where the page starts and wherever it is sent; unset, it is off. What
 * the page loads along the way may come from anywhere public: every connection the browser makes goes
 * through a proxy inside the relay with the same connect-time check as plain mode. Needs
 * playwright-core (a devDependency of this repo, so `npm install` at its root; Node 20 or later),
 * and Brave in /Applications, or `CHROME_PATH` set to another Chromium browser's executable. The
 * browser closes after 5 idle minutes; `login` cannot open the profile while it is running.
 *
 * THE CONNECTOR: with CF_TUNNEL_RELAY_CLOUDFLARED set, which cf-tunnel-relay-agent.sh
 * does, the relay also runs `cloudflared tunnel run` for tunnel `WMac`, so one LaunchAgent keeps
 * both up and `cloudflared` needs no service of its own. The tunnel token comes from the login
 * Keychain (item `cf-tunnel-relay`) and reaches cloudflared in TUNNEL_TOKEN: never on a command
 * line, where `ps` would show it, nor in a file. cloudflared is started again whenever it stops,
 * after 5 seconds, doubling up to a minute while it keeps failing, and stopped with the relay. Its
 * metrics are on 127.0.0.1:8812, where `cloudflared_tunnel_ha_connections` counts its live
 * connections to Cloudflare.
 *
 * Everything the relay says itself carries `x-cf-tunnel-relay-error`; a response it passes on
 * carries `x-cf-tunnel-relay-status`. That is how the Worker tells "the site said 502" from "the
 * relay could not get there". Needs Node 18 or later; plain mode needs nothing from npm.
 */
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { lookup, promises as dns } from "node:dns";
import net, { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const PORT = Number(process.argv[2] ?? 8811);
const MAX_REDIRECTS = 10;
const TIMEOUT_MS = 30_000;
const BROWSER_TIMEOUT_MS = 30_000;
const IDLE_MS = 5 * 60_000;
/** Browser mode's browser, unless CHROME_PATH names another Chromium one. */
const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const PROFILE =
  process.env.CF_TUNNEL_RELAY_PROFILE || join(homedir(), ".cf-tunnel-relay", "profile");
/** Titles of the interstitials that clear themselves given a few seconds. */
const CHALLENGE = /just a moment|attention required|checking your browser/i;

const domains = (list) =>
  (list ?? "")
    .split(",")
    .map((d) =>
      d
        .trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, ""),
    )
    .filter(Boolean);
const ALLOW = domains(process.env.ALLOW_DOMAINS);
const BROWSER_ALLOW = domains(process.env.BROWSER_ALLOW_DOMAINS);
const listed = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));
const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

/** What a caller may pass through to the site. Anything else stays behind. */
const FORWARD = ["user-agent", "accept", "accept-language", "referer"];
/** Hop-by-hop headers, and the length, which no longer describes a body the relay decoded. */
const DROP = new Set(["content-length", "transfer-encoding", "connection", "keep-alive"]);
/** The encodings asked for, and how to undo each. Anything else is passed on still encoded. */
const DECODERS = new Map([
  ["gzip", createGunzip],
  ["x-gzip", createGunzip],
  ["br", createBrotliDecompress],
  ["deflate", createInflate],
]);

const privateV4 = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};
const privateV6 = (ip) => {
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isIP(v.slice(7)) === 4 ? privateV4(v.slice(7)) : true;
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
};
const isPrivate = (ip) => (isIP(ip) === 4 ? privateV4(ip) : privateV6(ip));

/**
 * The outgoing socket's DNS lookup: every address the name resolves to must be public, and the
 * socket connects to one of those same addresses.
 */
const publicLookup = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const bad = addrs.find((a) => isPrivate(a.address));
    if (bad)
      return callback(new Error(`refusing ${hostname}: ${bad.address} is a private address`));
    if (!addrs.length) return callback(new Error(`${hostname} has no address`));
    if (options.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
};

/** Scheme, address literal and allow-list, before anything is sent. */
const checkUrl = (url, { anyDomain = false } = {}) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refusing ${url.protocol} URLs`);
  }
  const host = hostOf(url);
  // A literal address never goes through the lookup, so it is checked here instead.
  if (isIP(host) && isPrivate(host)) throw new Error(`refusing ${host}: a private address`);
  if (!anyDomain && ALLOW.length && !listed(host, ALLOW)) {
    throw new Error(`refusing ${host}: not in ALLOW_DOMAINS`);
  }
};

/** The same, and browser mode's own list on top. */
const checkBrowserUrl = (url) => {
  checkUrl(url);
  if (!BROWSER_ALLOW.length)
    throw new Error("browser mode is off: BROWSER_ALLOW_DOMAINS is not set");
  const host = hostOf(url);
  if (!listed(host, BROWSER_ALLOW))
    throw new Error(`refusing ${host}: not in BROWSER_ALLOW_DOMAINS`);
};

/** Every address the host resolves to must be public, checked before Chrome connects. */
const checkPublic = async (url) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refusing ${url.protocol} URLs`);
  }
  const host = hostOf(url);
  const addrs = isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  const bad = addrs.find((a) => isPrivate(a.address));
  if (bad) throw new Error(`refusing ${host}: ${bad.address} is a private address`);
};

const get = (url, headers) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    client
      .request(
        url,
        { headers, lookup: publicLookup, signal: AbortSignal.timeout(TIMEOUT_MS) },
        resolve,
      )
      .on("error", reject)
      .end();
  });

/** The whole body, decoded when it came in an encoding the relay asked for. */
const readBody = async (res) => {
  const decoder = DECODERS.get(
    String(res.headers["content-encoding"] ?? "")
      .trim()
      .toLowerCase(),
  );
  const chunks = [];
  await pipeline(res, ...(decoder ? [decoder()] : []), async (source) => {
    for await (const chunk of source) chunks.push(chunk);
  });
  return { body: Buffer.concat(chunks), decoded: Boolean(decoder) };
};

const relay = async (target, incoming) => {
  const headers = { "accept-language": "en-AU,en;q=0.9", "accept-encoding": "gzip, deflate, br" };
  for (const name of FORWARD) if (incoming[name]) headers[name] = incoming[name];
  let url = new URL(target);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkUrl(url);
    const res = await get(url, headers);
    const next = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
    if (!next) {
      const { body, decoded } = await readBody(res);
      const passed = Object.entries(res.headers).filter(
        ([name]) => !(decoded && name === "content-encoding"),
      );
      return { status: res.statusCode, headers: passed, body, finalUrl: url.href };
    }
    // Drained, not read; an error on the way out must not take the process down with it.
    res.on("error", () => {}).resume();
    url = new URL(next, url);
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
};

// ─── browser mode ───────────────────────────────────────────────────────────────────────────────
let chrome;
let busy = 0;
let idle;

/**
 * Chrome's way out: every connection it makes, redirects and websockets included, goes through
 * this proxy, which resolves the name with the same connect-time check as plain mode. Playwright
 * does not show redirects to a route handler, so a check there would miss them.
 */
let proxyPort;
const startProxy = () =>
  (proxyPort ??= new Promise((resolve, reject) => {
    const proxy = http.createServer((req, res) => {
      // A plain-http request, by absolute URL.
      try {
        const url = new URL(req.url);
        checkUrl(url, { anyDomain: true });
        const headers = { ...req.headers };
        delete headers["proxy-connection"];
        const up = (url.protocol === "https:" ? https : http).request(
          url,
          { method: req.method, headers, lookup: publicLookup },
          (answer) => {
            res.writeHead(answer.statusCode, answer.headers);
            answer.pipe(res);
          },
        );
        up.on("error", () => res.destroy());
        req.pipe(up);
      } catch {
        res.writeHead(403).end();
      }
    });
    proxy.on("connect", (req, socket, head) => {
      socket.on("error", () => {});
      const { hostname, port } = new URL(`http://${req.url}`);
      const host = hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && isPrivate(host)) return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      let open = false;
      const up = net.connect({ host, port: Number(port) || 443, lookup: publicLookup }, () => {
        open = true;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) up.write(head);
        up.pipe(socket).on("error", () => {});
        socket.pipe(up);
      });
      up.on("error", () =>
        open ? socket.destroy() : socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"),
      );
      socket.on("close", () => up.destroy());
    });
    proxy.on("error", reject).listen(0, "127.0.0.1", () => resolve(proxy.address().port));
  }));

/** The one Chrome, opened on first use; `login` opens it in a window. */
const openChrome = ({ headless }) =>
  (chrome ??= (async () => {
    const { chromium } = await import("playwright-core").catch(() => {
      throw new Error("browser mode needs playwright-core: `npm install` at the root of the repo");
    });
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      executablePath: process.env.CHROME_PATH || BRAVE,
      headless,
      // `<-loopback>` sends localhost through the proxy too, where it is refused.
      proxy: { server: `http://127.0.0.1:${await startProxy()}` },
      args: ["--proxy-bypass-list=<-loopback>"],
      locale: "en-AU",
      timezoneId: "Australia/Melbourne",
      serviceWorkers: "block",
      acceptDownloads: false,
      // Playwright's own handlers close Chrome but leave this process running; see the end.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    ctx.on("close", () => (chrome = undefined));
    return ctx;
  })().catch((e) => {
    chrome = undefined;
    if (/ENOENT|is not found at|executable doesn't exist/i.test(e.message ?? "")) {
      throw new Error(
        `browser mode needs Brave at ${BRAVE}, or CHROME_PATH set to another Chromium ` +
          "browser's executable",
      );
    }
    throw e;
  }));

const browse = async (target) => {
  const url = new URL(target);
  checkBrowserUrl(url);
  await checkPublic(url);
  busy++;
  clearTimeout(idle);
  try {
    const page = await (await openChrome({ headless: true })).newPage();
    let main;
    let refused;
    // The page itself and every hop it is sent on are held to the lists; what it loads is not.
    page.on("request", (r) => {
      if (!r.isNavigationRequest() || r.frame() !== page.mainFrame()) return;
      try {
        checkBrowserUrl(new URL(r.url()));
      } catch (e) {
        refused ??= e;
        page.close().catch(() => {});
      }
    });
    page.on("response", (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) main = r;
    });
    try {
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: BROWSER_TIMEOUT_MS });
      // A challenge that clears itself moves on to the real page; give it the time to.
      for (let i = 0; i < 20 && CHALLENGE.test(await page.title().catch(() => "")); i++) {
        await page.waitForTimeout(1000);
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      if (!main) throw new Error("the browser got no answer");
      const headers = await main.allHeaders();
      const html = /html/i.test(headers["content-type"] ?? "text/html");
      const body = html ? Buffer.from(await page.content()) : await main.body();
      const passed = Object.entries(headers)
        .filter(([name]) => !name.startsWith(":") && name !== "content-encoding")
        .filter(([name]) => !(html && name === "content-type"))
        .map(([name, value]) => [name, value.replace(/\n/g, ", ")]);
      // page.content() is a string, so whatever charset the site named, this is UTF-8 now.
      if (html) passed.push(["content-type", "text/html; charset=utf-8"]);
      if (refused) throw refused;
      return { status: main.status(), headers: passed, body, finalUrl: page.url() };
    } catch (e) {
      throw refused ?? e;
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    busy--;
    idle = setTimeout(() => busy || chrome?.then((c) => c.close()).catch(() => {}), IDLE_MS);
  }
};

// ─── the server ─────────────────────────────────────────────────────────────────────────────────
const fail = (out, status, message) => {
  out.writeHead(status, { "content-type": "text/plain", "x-cf-tunnel-relay-error": message });
  out.end(message);
};

const server = async (req, out) => {
  const url = new URL(req.url ?? "/", "http://cf-tunnel-relay");
  if (url.pathname === "/health") return out.end("ok");
  if (url.pathname !== "/fetch" || req.method !== "GET") return fail(out, 404, "GET /fetch?url=");
  const target = url.searchParams.get("url");
  if (!target) return fail(out, 400, "missing ?url=");
  const mode = url.searchParams.get("mode") ?? "plain";
  if (mode !== "plain" && mode !== "browser") return fail(out, 400, "mode is plain or browser");
  try {
    const got = mode === "browser" ? await browse(target) : await relay(target, req.headers);
    const headers = {};
    for (const [name, value] of got.headers) {
      if (!DROP.has(name) && name !== "set-cookie") headers[name] = value;
    }
    Object.assign(headers, {
      "x-cf-tunnel-relay-status": String(got.status),
      "x-cf-tunnel-relay-final-url": got.finalUrl,
      "x-cf-tunnel-relay-mode": mode,
    });
    out.writeHead(got.status, headers);
    out.end(got.body);
    console.log(`${got.status} ${mode} ${target}`);
  } catch (e) {
    const message = String(e?.cause?.message ?? e?.message ?? e).replace(/[\r\n]+/g, " ");
    console.log(`ERR ${target}: ${message}`);
    fail(out, 502, message);
  }
};

// ─── the connector ──────────────────────────────────────────────────────────────────────────────
const CLOUDFLARED = process.env.CF_TUNNEL_RELAY_CLOUDFLARED;
const KEYCHAIN_ITEM = "cf-tunnel-relay";
let connector;
let stopping = false;

/** The tunnel token, read fresh each start so a replaced one is picked up. */
const tunnelToken = () =>
  new Promise((resolve, reject) =>
    execFile("security", ["find-generic-password", "-s", KEYCHAIN_ITEM, "-w"], (err, out) =>
      err || !out.trim()
        ? reject(new Error(`no tunnel token in the Keychain item ${KEYCHAIN_ITEM}`))
        : resolve(out.trim()),
    ),
  );

const runConnector = async (wait = 5_000) => {
  if (stopping) return;
  const started = Date.now();
  // Once it has stayed up a minute, a later stop starts the backoff over.
  const again = () => {
    if (stopping) return;
    const next = Date.now() - started > 60_000 ? 5_000 : Math.min(wait * 2, 60_000);
    setTimeout(() => runConnector(next), wait);
  };
  let token;
  try {
    token = await tunnelToken();
  } catch (e) {
    console.error(`cloudflared not started: ${e.message}; trying again in ${wait / 1000}s`);
    return again();
  }
  const child = spawn(
    CLOUDFLARED,
    [
      "tunnel",
      "--no-autoupdate",
      "--loglevel",
      "warn",
      "--grace-period",
      "2s",
      // Shown in place of the Mac's hostname against this connector, as custom:cf-tunnel-relay.
      "--label",
      "cf-tunnel-relay",
      // Fixed, so cf-tunnel-relay-agent.sh knows where to ask whether it has connected.
      "--metrics",
      "127.0.0.1:8812",
      "run",
    ],
    { env: { ...process.env, TUNNEL_TOKEN: token }, stdio: ["ignore", "ignore", "inherit"] },
  );
  connector = child;
  let ended = false;
  const end = (why) => {
    if (ended) return;
    ended = true;
    connector = undefined;
    if (!stopping) console.error(`cloudflared ${why}; starting it again in ${wait / 1000}s`);
    again();
  };
  child.on("error", (e) => end(`could not run: ${e.message}`));
  child.on("exit", (code, signal) => end(`stopped (${signal ?? `exit ${code}`})`));
};

/** Resolves once cloudflared has gone, after asking it to; at once if it is not running. */
const stopConnector = () =>
  new Promise((done) => {
    stopping = true;
    if (!connector) return done();
    connector.once("exit", done);
    connector.kill("SIGTERM");
  });

// Ctrl+C, and launchd restarting it: stop cloudflared, close Chrome if it is open, then go.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    setTimeout(() => process.exit(0), 3000).unref();
    Promise.all([stopConnector(), (chrome ?? Promise.resolve()).then((c) => c?.close())])
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

if (process.argv[2] === "login") {
  const ctx = await openChrome({ headless: false }).catch((e) => {
    console.log(
      `${e.message}\nIf the relay has Chrome open, try again once it has been idle 5 minutes.`,
    );
    process.exit(1);
  });
  await (ctx.pages()[0] ?? (await ctx.newPage())).goto(process.argv[3] ?? "about:blank");
  console.log(
    "Sign in or pass the check in that window, then close it. The profile keeps the cookies.",
  );
  await new Promise((done) => ctx.on("close", done));
  process.exit(0);
} else {
  // The VPC Service points at `localhost`, which cloudflared may resolve to either family.
  for (const host of ["127.0.0.1", "::1"]) {
    http
      .createServer(server)
      .on("error", (e) => console.log(`not listening on ${host}: ${e.message}`))
      .listen(PORT, host, () => console.log(`cf-tunnel-relay on ${host}:${PORT}`));
  }
  if (CLOUDFLARED) runConnector();
}
