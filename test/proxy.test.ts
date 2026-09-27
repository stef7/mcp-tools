/**
 * core/proxy.ts against scripts/mock-proxy.mjs: the HTTP parsing, and what the proxy's own
 * refusals turn into. The TLS-inside-CONNECT path needs a real site with a real certificate, so it
 * is not covered here; see the README for trying it by hand.
 */
import { connect } from "cloudflare:sockets";
import { inject } from "vitest";
import { beforeEach, describe, expect, it } from "vitest";
import { ProxyError, proxyFetch } from "../core/proxy";
import { egress, resetTunnel } from "../core/egress";

const port = () => inject("proxyPort");
const proxy = () => ({
  hostname: "127.0.0.1",
  port: port(),
  username: "groups-UNBLOCKER",
  password: "secret",
});

describe("proxyFetch over plain http", () => {
  it("returns the body and status", async () => {
    const res = await proxyFetch(proxy(), "http://site.test/plain");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("x-proxy-final-url")).toBe("http://site.test/plain");
  });

  it("undoes chunking and gzip", async () => {
    const res = await proxyFetch(proxy(), "http://site.test/chunked");
    const text = await res.text();
    expect(text.startsWith("<p>chunk chunk")).toBe(true);
    expect(text.length).toBe("<p>".length + "chunk ".length * 2000 + "</p>".length);
    expect(res.headers.has("content-encoding")).toBe(false);
  });

  it("follows redirects", async () => {
    const res = await proxyFetch(proxy(), "http://site.test/redirect");
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("x-proxy-final-url")).toBe("http://site.test/plain");
  });

  it("reports the proxy's own failure codes as ProxyError", async () => {
    const e = await proxyFetch(proxy(), "http://site.test/upstream").catch((e: unknown) => e);
    expect(e).toBeInstanceOf(ProxyError);
    expect((e as ProxyError).status).toBe(595);
  });

  it("reports a wrong password as a 407", async () => {
    const bad = { ...proxy(), password: "wrong" };
    const e = await proxyFetch(bad, "http://site.test/plain").catch((e: unknown) => e);
    expect((e as ProxyError).status).toBe(407);
  });

  it("gives up on a response past maxBytes", async () => {
    await expect(proxyFetch(proxy(), "http://site.test/chunked", { maxBytes: 50 })).rejects.toThrow(
      "larger than 50 bytes",
    );
  });
});

describe("proxyFetch over https", () => {
  it("fails when CONNECT is refused, before any TLS", async () => {
    const bad = { ...proxy(), password: "wrong" };
    const e = await proxyFetch(bad, "https://site.test/").catch((e: unknown) => e);
    expect((e as ProxyError).status).toBe(407);
    const e2 = await proxyFetch(proxy(), "https://site.test/").catch((e: unknown) => e);
    expect((e2 as ProxyError).status).toBe(595);
  });
});

describe("the unblocker route in the cascade", () => {
  beforeEach(resetTunnel);
  // Points the fixed Apify address at the mock; everything else is what production sends.
  const toMock: typeof connect = (_, opts) =>
    connect({ hostname: "127.0.0.1", port: port() }, opts);
  const site = (async () => new Response("from cloudflare")) as unknown as typeof fetch;

  it("gets the page through the proxy, as the Unblocker username", async () => {
    const got = await egress({ APIFY_PROXY_PASSWORD: "secret" }, "http://site.test/plain", {
      connect: toMock,
      fetch: site,
    });
    expect(got.via).toBe("unblocker");
    expect(await got.response.text()).toBe("hello");
  });

  it("falls back to Cloudflare when the proxy refuses", async () => {
    const got = await egress({ APIFY_PROXY_PASSWORD: "wrong" }, "http://site.test/plain", {
      connect: toMock,
      fetch: site,
    });
    expect(got.via).toBe("direct");
    expect(got.skipped).toEqual([
      "tunnel: not bound",
      "unblocker: refused (407): wrong password, or no paid plan or units left",
    ]);
  });

  it("falls back when the proxy cannot reach the site", async () => {
    const got = await egress({ APIFY_PROXY_PASSWORD: "secret" }, "http://site.test/upstream", {
      connect: toMock,
      fetch: site,
    });
    expect(got.via).toBe("direct");
    expect(got.skipped[1]).toBe("unblocker: 595 Connection Reset");
  });
});
