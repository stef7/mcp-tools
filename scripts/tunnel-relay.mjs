#!/usr/bin/env node
/**
 * The far end of the tunnel route in core/egress.ts. Runs on the Mac; cloudflared carries
 * mcp-fetch's requests to it through the VPC Service `wmac` (localhost:8811), and it fetches the
 * URL it is handed from this machine's own connection.
 *
 *   node scripts/tunnel-relay.mjs [port]      default 8811
 *
 *   GET /fetch?url=<absolute url>   the site's answer: status, headers and body as received
 *   GET /health                     "ok", for checking by hand
 *
 * Listens on loopback only, so the one way in is through the tunnel, and from there only a
 * Worker holding the binding. It still refuses private and loopback addresses — including at each
 * redirect — so a URL typed into a tool cannot be used to look around the home network.
 *
 * Everything the relay says itself carries `x-relay-error`; a response it passes on carries
 * `x-relay-status`. That is how the Worker tells "the site said 502" from "the relay could not
 * get there". Needs Node 18 or later, and nothing from npm.
 */
import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const PORT = Number(process.argv[2] ?? 8811);
const MAX_REDIRECTS = 10;
const TIMEOUT_MS = 30_000;

/** What a caller may pass through to the site. Anything else stays behind. */
const FORWARD = ["user-agent", "accept", "accept-language", "referer"];
/** Undici decodes the body, so the encoding and length it arrived with no longer describe it. */
const DROP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
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
  if (v.startsWith("::ffff:")) return privateV4(v.slice(7));
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
};
const isPrivate = (ip) => (isIP(ip) === 4 ? privateV4(ip) : privateV6(ip));

/** Throws unless every address the host resolves to is public. */
const checkPublic = async (url) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refusing ${url.protocol} URLs`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  const bad = addrs.find((a) => isPrivate(a.address));
  if (bad) throw new Error(`refusing ${host}: ${bad.address} is a private address`);
};

const relay = async (target, incoming) => {
  const headers = { "accept-language": "en-AU,en;q=0.9" };
  for (const name of FORWARD) if (incoming[name]) headers[name] = incoming[name];
  let url = new URL(target);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await checkPublic(url);
    const res = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const next = res.status >= 300 && res.status < 400 && res.headers.get("location");
    if (!next) return { res, finalUrl: url.href };
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
    const { res, finalUrl } = await relay(target, req.headers);
    const headers = { "x-relay-status": String(res.status), "x-relay-final-url": finalUrl };
    res.headers.forEach((value, name) => {
      if (!DROP.has(name) && name !== "set-cookie") headers[name] = value;
    });
    out.writeHead(res.status, headers);
    out.end(Buffer.from(await res.arrayBuffer()));
    console.log(`${res.status} ${target}`);
  } catch (e) {
    const message = String(e?.cause?.message ?? e?.message ?? e).replace(/[\r\n]+/g, " ");
    console.log(`ERR ${target}: ${message}`);
    fail(out, 502, message);
  }
};

// The VPC Service points at `localhost`, which cloudflared may resolve to either family.
for (const host of ["127.0.0.1", "::1"]) {
  createServer(server)
    .on("error", (e) => console.log(`not listening on ${host}: ${e.message}`))
    .listen(PORT, host, () => console.log(`tunnel relay on ${host}:${PORT}`));
}
