/**
 * `fetch` through an HTTP proxy, which the Workers `fetch` cannot do: a raw TCP socket to the
 * proxy, `CONNECT` to the site, then TLS to the site inside that tunnel. `startTls` takes the
 * site's hostname as `expectedServerHostname` — in the runtime's types, though not on the docs
 * page — so the certificate is checked against the site, not the proxy.
 *
 * Plain `http://` URLs skip the tunnel: the request goes to the proxy in absolute form.
 *
 * Deliberately small: GET, HTTP/1.1 with `Connection: close`, so a response ends when the socket
 * does. It handles chunked bodies, gzip and deflate, and redirects; nothing else.
 */
import { connect as tcp } from "cloudflare:sockets";

export type Proxy = { hostname: string; port: number; username: string; password: string };

export type ProxyFetchOptions = {
  headers?: Record<string, string>;
  /** Replaced in tests. */
  connect?: typeof tcp;
  timeoutMs?: number;
  /** Past this many bytes the response is abandoned. Residential traffic is billed by the GB. */
  maxBytes?: number;
};

/** The proxy said no. Its own status, not the site's, so the caller can try another route. */
export class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_REDIRECTS = 5;

const concat = (parts: Uint8Array[], total: number) => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Index of the blank line that ends a header block, or -1. */
const headEnd = (b: Uint8Array, from = 0) => {
  for (let i = Math.max(from, 3); i < b.length; i++)
    if (b[i] === 10 && b[i - 1] === 13 && b[i - 2] === 10 && b[i - 3] === 13) return i + 1;
  return -1;
};

type Head = { status: number; reason: string; headers: Headers };
const parseHead = (raw: string): Head => {
  const [line = "", ...rest] = raw.split("\r\n");
  const m = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(line);
  if (!m) throw new Error(`not an HTTP response: ${line.slice(0, 80)}`);
  const headers = new Headers();
  for (const h of rest) {
    const i = h.indexOf(":");
    if (i > 0) headers.append(h.slice(0, i).trim(), h.slice(i + 1).trim());
  }
  return { status: Number(m[1]), reason: m[2] ?? "", headers };
};

/** Reads only up to the end of the header block: what CONNECT answers, before TLS begins. */
const readHead = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("proxy closed the connection");
    parts.push(value);
    total += value.length;
    const all = concat(parts, total);
    const end = headEnd(all);
    if (end >= 0) return parseHead(dec.decode(all.subarray(0, end - 4)));
    if (total > 64 * 1024) throw new Error("proxy sent an oversized header");
  }
};

const readAll = async (readable: ReadableStream<Uint8Array>, max: number) => {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of readable) {
    parts.push(chunk);
    total += chunk.length;
    if (total > max) throw new Error(`response larger than ${max} bytes`);
  }
  return concat(parts, total);
};

const dechunk = (b: Uint8Array) => {
  const parts: Uint8Array[] = [];
  let total = 0;
  let at = 0;
  for (;;) {
    const eol = b.indexOf(13, at);
    if (eol < 0) break;
    const size = parseInt(dec.decode(b.subarray(at, eol)).split(";")[0]!, 16);
    if (!size) break;
    parts.push(b.subarray(eol + 2, eol + 2 + size));
    total += size;
    at = eol + 2 + size + 2;
  }
  return concat(parts, total);
};

const decode = async (body: Uint8Array, encoding: string | null): Promise<Uint8Array> => {
  const e = encoding?.trim().toLowerCase();
  if (e !== "gzip" && e !== "deflate") return body;
  const stream = new Blob([body as BufferSource]).stream().pipeThrough(new DecompressionStream(e));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const basic = (p: Proxy) => "Basic " + btoa(`${p.username}:${p.password}`);

/** One request, one connection, no redirects. */
const once = async (
  proxy: Proxy,
  url: URL,
  opts: Required<Omit<ProxyFetchOptions, "headers">> & ProxyFetchOptions,
) => {
  const secure = url.protocol === "https:";
  const socket = opts.connect(
    { hostname: proxy.hostname, port: proxy.port },
    { secureTransport: secure ? "starttls" : "off", allowHalfOpen: false },
  );
  const lines = [
    `Host: ${url.host}`,
    "Connection: close",
    "Accept-Encoding: gzip, deflate",
    ...Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
  ];
  let stream = socket;
  try {
    if (secure) {
      const w = socket.writable.getWriter();
      const r = socket.readable.getReader();
      const target = `${url.hostname}:${url.port || 443}`;
      await w.write(
        enc.encode(
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
            `Proxy-Authorization: ${basic(proxy)}\r\n\r\n`,
        ),
      );
      const head = await readHead(r);
      if (head.status !== 200)
        throw new ProxyError(head.status, `CONNECT ${head.status} ${head.reason}`);
      w.releaseLock();
      r.releaseLock();
      stream = socket.startTls({ expectedServerHostname: url.hostname });
      const tw = stream.writable.getWriter();
      await tw.write(
        enc.encode(`GET ${url.pathname}${url.search} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`),
      );
      tw.releaseLock();
    } else {
      const w = socket.writable.getWriter();
      await w.write(
        enc.encode(
          `GET ${url.href} HTTP/1.1\r\nProxy-Authorization: ${basic(proxy)}\r\n` +
            `${lines.join("\r\n")}\r\n\r\n`,
        ),
      );
      w.releaseLock();
    }
    const raw = await readAll(stream.readable, opts.maxBytes);
    const end = headEnd(raw);
    if (end < 0) throw new Error("connection closed before the response headers ended");
    const head = parseHead(dec.decode(raw.subarray(0, end - 4)));
    // A plain-http request is answered by the proxy itself when it fails; its codes are 59x.
    if (!secure && (head.status === 407 || head.status >= 590)) {
      throw new ProxyError(head.status, `${head.status} ${head.reason}`);
    }
    let body: Uint8Array = raw.subarray(end);
    if (head.headers.get("transfer-encoding")?.toLowerCase().includes("chunked"))
      body = dechunk(body);
    else {
      const len = Number(head.headers.get("content-length"));
      if (Number.isFinite(len) && len >= 0 && head.headers.has("content-length"))
        body = body.subarray(0, len);
    }
    body = await decode(body, head.headers.get("content-encoding"));
    head.headers.delete("content-encoding");
    head.headers.delete("content-length");
    head.headers.delete("transfer-encoding");
    return { ...head, body };
  } finally {
    await stream.close().catch(() => {});
  }
};

export const proxyFetch = async (proxy: Proxy, input: string, opts: ProxyFetchOptions = {}) => {
  const full = { connect: tcp, timeoutMs: 30_000, maxBytes: 25 * 1024 * 1024, ...opts };
  const run = async () => {
    let url = new URL(input);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error(`cannot proxy ${url.protocol} URLs`);
      const res = await once(proxy, url, full);
      const next = res.status >= 300 && res.status < 400 && res.headers.get("location");
      if (!next) {
        const out = new Response(res.status === 204 || res.status === 304 ? null : res.body, {
          status: res.status,
          statusText: res.reason,
          headers: res.headers,
        });
        out.headers.set("x-proxy-final-url", url.href);
        return out;
      }
      url = new URL(next, url);
    }
    throw new Error(`more than ${MAX_REDIRECTS} redirects`);
  };
  let timer: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${full.timeoutMs} ms`)),
      full.timeoutMs,
    );
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
};
