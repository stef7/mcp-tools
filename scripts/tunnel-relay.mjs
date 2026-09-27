#!/usr/bin/env node
/**
 * The far end of the tunnel route in core/egress.ts. Runs on the Mac; cloudflared carries
 * mcp-fetch's requests to it through the VPC Service `wmac` (localhost:8811), and it fetches the
 * URL it is handed from this machine's own connection.
 *
 *   node scripts/tunnel-relay.mjs [port]      default 8811
 *   ALLOW_DOMAINS=example.org,acnc.gov.au     optional: refuse every other domain
 *
 *   GET /fetch?url=<absolute url>   the site's answer: status, headers and body as received
 *   GET /health                     "ok", for checking by hand
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
 * Everything the relay says itself carries `x-relay-error`; a response it passes on carries
 * `x-relay-status`. That is how the Worker tells "the site said 502" from "the relay could not
 * get there". Needs Node 18 or later, and nothing from npm.
 */
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns";
import { isIP } from "node:net";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const PORT = Number(process.argv[2] ?? 8811);
const MAX_REDIRECTS = 10;
const TIMEOUT_MS = 30_000;
const ALLOW = (process.env.ALLOW_DOMAINS ?? "")
  .split(",")
  .map((d) =>
    d
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, ""),
  )
  .filter(Boolean);

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
const checkUrl = (url) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refusing ${url.protocol} URLs`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // A literal address never goes through the lookup, so it is checked here instead.
  if (isIP(host) && isPrivate(host)) throw new Error(`refusing ${host}: a private address`);
  if (ALLOW.length && !ALLOW.some((d) => host === d || host.endsWith(`.${d}`))) {
    throw new Error(`refusing ${host}: not in ALLOW_DOMAINS`);
  }
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
    if (!next) return { res, finalUrl: url.href, ...(await readBody(res)) };
    // Drained, not read; an error on the way out must not take the process down with it.
    res.on("error", () => {}).resume();
    url = new URL(next, url);
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
};

const fail = (out, status, message) => {
  out.writeHead(status, { "content-type": "text/plain", "x-relay-error": message });
  out.end(message);
};

const server = async (req, out) => {
  const url = new URL(req.url ?? "/", "http://relay");
  if (url.pathname === "/health") return out.end("ok");
  if (url.pathname !== "/fetch" || req.method !== "GET") return fail(out, 404, "GET /fetch?url=");
  const target = url.searchParams.get("url");
  if (!target) return fail(out, 400, "missing ?url=");
  try {
    const { res, finalUrl, body, decoded } = await relay(target, req.headers);
    const headers = { "x-relay-status": String(res.statusCode), "x-relay-final-url": finalUrl };
    for (const [name, value] of Object.entries(res.headers)) {
      if (DROP.has(name) || name === "set-cookie") continue;
      if (decoded && name === "content-encoding") continue;
      headers[name] = value;
    }
    out.writeHead(res.statusCode, headers);
    out.end(body);
    console.log(`${res.statusCode} ${target}`);
  } catch (e) {
    const message = String(e?.cause?.message ?? e?.message ?? e).replace(/[\r\n]+/g, " ");
    console.log(`ERR ${target}: ${message}`);
    fail(out, 502, message);
  }
};

// The VPC Service points at `localhost`, which cloudflared may resolve to either family.
for (const host of ["127.0.0.1", "::1"]) {
  http
    .createServer(server)
    .on("error", (e) => console.log(`not listening on ${host}: ${e.message}`))
    .listen(PORT, host, () => console.log(`tunnel relay on ${host}:${PORT}`));
}
