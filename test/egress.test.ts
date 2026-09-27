/**
 * core/egress.ts. Nothing here touches the network: the tunnel and Apify are stand-ins, and what
 * is pinned down is which route answers and what the ones before it are recorded as saying.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { egress, resetTunnel } from "../core/egress";

const URL_ = "https://example.org/page";
const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

/** A tunnel that answers the way the relay does, or throws the way a dead tunnel does. */
const tunnel = (answer: () => Response) => {
  const seen: string[] = [];
  return {
    seen,
    async fetch(input: string) {
      seen.push(input);
      return answer();
    },
  };
};
const relayed = (body: string, status = 200) =>
  page(body, status, { "x-relay-status": String(status) });
const dead = tunnel(() => {
  throw new Error("Network connection lost.");
});

/** Stands in for the worker's fetch: Apify's API at its URL, the site everywhere else. */
const web = (apify: () => Response, site = () => page("from cloudflare")) => {
  const seen: string[] = [];
  const get = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    return url.startsWith("https://api.apify.com/") ? apify() : site();
  }) as typeof fetch;
  return { seen, get };
};
const apifyPage = (html: string, status = 200) =>
  Response.json([{ crawl: { httpStatusCode: status }, html }], { status: 201 });

beforeEach(resetTunnel);

describe("the cascade", () => {
  it("uses the tunnel when it answers, and asks the relay for the URL", async () => {
    const t = tunnel(() => relayed("from home"));
    const w = web(() => apifyPage("from apify"));
    const got = await egress({ TUNNEL: t, APIFY_TOKEN: "tok" }, URL_, { fetch: w.get });
    expect(got.via).toBe("tunnel");
    expect(await got.response.text()).toBe("from home");
    expect(got.skipped).toEqual([]);
    expect(t.seen).toEqual([`http://relay/fetch?url=${encodeURIComponent(URL_)}`]);
    expect(w.seen).toEqual([]);
  });

  it("passes the site's own error through rather than trying elsewhere", async () => {
    const t = tunnel(() => relayed("forbidden", 403));
    const got = await egress({ TUNNEL: t }, URL_, { fetch: web(() => apifyPage("x")).get });
    expect(got.via).toBe("tunnel");
    expect(got.response.status).toBe(403);
  });

  it("goes to Apify when the tunnel is down, and remembers it is down", async () => {
    const w = web(() => apifyPage("<p>from apify</p>"));
    const env = { TUNNEL: dead, APIFY_TOKEN: "tok" };
    const first = await egress(env, URL_, { fetch: w.get });
    expect(first.via).toBe("proxy");
    expect(await first.response.text()).toBe("<p>from apify</p>");
    expect(first.skipped).toEqual(["tunnel: Network connection lost."]);

    const up = tunnel(() => relayed("from home"));
    const second = await egress({ ...env, TUNNEL: up }, URL_, { fetch: w.get });
    expect(second.via).toBe("proxy");
    expect(second.skipped).toEqual(["tunnel: down in the last minute"]);
    expect(up.seen).toEqual([]);
  });

  it("treats a 5xx the relay did not mark as nothing listening", async () => {
    const t = tunnel(() => page("Bad Gateway", 502));
    const got = await egress({ TUNNEL: t }, URL_, { fetch: web(() => apifyPage("x")).get });
    expect(got.skipped[0]).toBe("tunnel: relay not answering (HTTP 502)");
    expect(got.via).toBe("direct");
  });

  it("moves on when the relay could not reach the site, without writing the tunnel off", async () => {
    const t = tunnel(() => page("ENOTFOUND", 502, { "x-relay-error": "getaddrinfo ENOTFOUND" }));
    const w = web(() => apifyPage("x"));
    await egress({ TUNNEL: t }, URL_, { fetch: w.get });
    await egress({ TUNNEL: t }, URL_, { fetch: w.get });
    expect(t.seen).toHaveLength(2);
  });

  it("falls back to Cloudflare when Apify is out of quota", async () => {
    const w = web(() => page('{"error":{"type":"not-enough-usage"}}', 402));
    const got = await egress({ TUNNEL: dead, APIFY_TOKEN: "tok" }, URL_, { fetch: w.get });
    expect(got.via).toBe("direct");
    expect(await got.response.text()).toBe("from cloudflare");
    expect(got.skipped).toEqual([
      "tunnel: Network connection lost.",
      "proxy: no quota left (HTTP 402)",
    ]);
  });

  it("asks Apify for the page through AU residential proxies", async () => {
    let body: Record<string, unknown> = {};
    const get = (async (_: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return apifyPage("<p>x</p>");
    }) as typeof fetch;
    await egress({ APIFY_TOKEN: "tok" }, URL_, { fetch: get });
    expect(body).toMatchObject({
      query: URL_,
      outputFormats: ["html"],
      proxyConfiguration: { apifyProxyGroups: ["RESIDENTIAL"], apifyProxyCountry: "AU" },
    });
  });

  it("does not pay Apify for a PDF", async () => {
    const w = web(() => apifyPage("x"));
    const got = await egress({ APIFY_TOKEN: "tok" }, "https://example.org/a.pdf", { fetch: w.get });
    expect(got.via).toBe("direct");
    expect(got.skipped).toContain("proxy: not an HTML page");
    expect(w.seen.some((u) => u.includes("apify"))).toBe(false);
  });

  it("moves on when the Actor could not load the page", async () => {
    const w = web(() => Response.json([], { status: 201 }));
    const got = await egress({ APIFY_TOKEN: "tok" }, URL_, { fetch: w.get });
    expect(got.via).toBe("direct");
    expect(got.skipped).toContain("proxy: the Actor returned no page");
  });

  it("says which routes were never configured", async () => {
    const got = await egress({}, URL_, { fetch: web(() => apifyPage("x")).get });
    expect(got.skipped).toEqual(["tunnel: not bound", "proxy: no APIFY_TOKEN"]);
  });
});

describe("naming a route", () => {
  it("uses only that route", async () => {
    const w = web(() => apifyPage("x"));
    const got = await egress({ TUNNEL: tunnel(() => relayed("home")) }, URL_, {
      via: "direct",
      fetch: w.get,
    });
    expect(got.via).toBe("direct");
  });

  it("fails rather than falling back", async () => {
    await expect(
      egress({ TUNNEL: dead }, URL_, { via: "tunnel", fetch: web(() => apifyPage("x")).get }),
    ).rejects.toThrow("No route could fetch https://example.org/page: tunnel: Network");
  });
});
