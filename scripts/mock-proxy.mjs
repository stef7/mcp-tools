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
 *
 * CONNECT is refused unless UPSTREAM_PROXY is set (an http://host:port proxy to chain through),
 * which is only for trying a real https site by hand.
 *
 *   node scripts/mock-proxy.mjs [port] [user:password]
 */
import { createServer } from "node:http";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";

const PORT = Number(process.argv[2] ?? 8797);
const AUTH = "Basic " + Buffer.from(process.argv[3] ?? "user:secret").toString("base64");
const UPSTREAM = process.env.UPSTREAM_PROXY ? new URL(process.env.UPSTREAM_PROXY) : null;

const server = createServer((req, res) => {
  if (req.headers["proxy-authorization"] !== AUTH) {
    res.writeHead(407, { "proxy-authenticate": 'Basic realm="mock"' });
    return res.end("auth");
  }
  const url = new URL(req.url ?? "/");
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
