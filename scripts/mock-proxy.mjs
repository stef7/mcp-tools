#!/usr/bin/env node
/**
 * A stand-in for Apify Proxy, for test/proxy.test.ts. Speaks just enough of the HTTP proxy
 * protocol to exercise core/proxy.ts: Basic auth on every request, absolute-form GET for http://
 * URLs, and CONNECT. It answers plain-http requests itself from a few canned paths, so the tests
 * need no network:
 *
 *   /plain      200 "hello"
 *   /chunked    200, gzip, chunked
 *   /redirect   302 -> /plain
 *   /upstream   595, the way Apify reports a site it could not reach
 *   /flaky?id=  502 the first time for each id, then 200 "hello after <n>"
 *   /missing?id= 404 "missing <n>" every time, n counting the requests for that id
 *
 * CONNECT to tls.test or other.test does what Unblocker does: TLS ends here, with a certificate for
 * tls.test signed by a test CA (test/fixtures/mock-*.pem), and the same canned paths are served
 * inside it. Any other CONNECT is refused unless UPSTREAM_PROXY is set (an http://host:port proxy
 * to chain through), which is only for trying a real https site by hand.
 *
 *   node scripts/mock-proxy.mjs [port] [user:password]
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { TLSSocket, createSecureContext } from "node:tls";
import { gzipSync } from "node:zlib";

const PORT = Number(process.argv[2] ?? 8797);
const AUTH = "Basic " + Buffer.from(process.argv[3] ?? "user:secret").toString("base64");
const UPSTREAM = process.env.UPSTREAM_PROXY ? new URL(process.env.UPSTREAM_PROXY) : null;
const fixture = (name) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url));
// What subtls asks for, and nothing older, so a test passing means the real thing can.
const SITE = createSecureContext({
  key: fixture("mock-site.key"),
  cert: fixture("mock-site.pem"),
  minVersion: "TLSv1.3",
});
const TLS_HOSTS = new Set(["tls.test:443", "other.test:443"]);
const hits = new Map();
const hit = (url) => {
  const key = url.pathname + url.searchParams.get("id");
  hits.set(key, (hits.get(key) ?? 0) + 1);
  return hits.get(key);
};

const server = createServer((req, res) => {
  // Requests inside a tunnel are the site's, and carry no proxy credentials.
  if (!req.socket.tunnelled && req.headers["proxy-authorization"] !== AUTH) {
    res.writeHead(407, { "proxy-authenticate": 'Basic realm="mock"' });
    return res.end("auth");
  }
  const url = new URL(req.url ?? "/", "http://site.test");
  if (url.pathname === "/plain") {
    res.writeHead(200, { "content-type": "text/plain", "content-length": "5" });
    return res.end("hello");
  }
  if (url.pathname === "/chunked") {
    res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
    const body = gzipSync("<p>" + "chunk ".repeat(2000) + "</p>");
    res.write(body.subarray(0, 100));
    return res.end(body.subarray(100)); // Node sends these as two chunks
  }
  if (url.pathname === "/flaky") {
    const n = hit(url);
    if (n === 1) {
      res.writeHead(502, { "content-length": "0" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(`hello after ${n}`);
  }
  if (url.pathname === "/missing") {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end(`missing ${hit(url)}`);
  }
  if (url.pathname === "/redirect") {
    res.writeHead(302, { location: "/plain" });
    return res.end();
  }
  res.writeHead(595, "Connection Reset");
  res.end();
});

server.on("connect", (req, client, head) => {
  if (req.headers["proxy-authorization"] !== AUTH) {
    return client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
  }
  if (TLS_HOSTS.has(req.url)) {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tls = new TLSSocket(client, { isServer: true, secureContext: SITE });
    tls.tunnelled = true;
    tls.on("error", () => client.destroy());
    return server.emit("connection", tls);
  }
  if (!UPSTREAM) return client.end("HTTP/1.1 595 Connection Reset\r\n\r\n");
  const up = connect(Number(UPSTREAM.port), UPSTREAM.hostname, () => {
    up.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`);
    up.once("data", (answer) => {
      if (!answer.toString().startsWith("HTTP/1.1 200")) return client.end(answer);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client).pipe(up);
    });
  });
  up.on("error", () => client.destroy());
  client.on("error", () => up.destroy());
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock proxy on 127.0.0.1:${PORT}`));
