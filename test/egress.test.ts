/**
 * core/egress.ts: which route answers, and what the ones before it are recorded as saying. The
 * tunnel and the site are stand-ins; the unblocker's own behaviour is in proxy.test.ts, so here
 * it is either unconfigured or a proxy that cannot be reached.
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

/** The worker's own fetch, answering as the site. */
const site = () => {
  const seen: string[] = [];
  const get = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return page("from cloudflare");
  }) as typeof fetch;
  return { seen, get };
};

/** An unblocker whose proxy cannot be reached at all. */
const unreachable = { APIFY_PROXY_PASSWORD: "secret" };
const noSocket = (() => {
  throw new Error("proxy request failed, cannot connect to the specified address");
}) as never;

beforeEach(resetTunnel);

describe("the cascade", () => {
  it("uses the tunnel when it answers, and asks the relay for the URL", async () => {
    const t = tunnel(() => relayed("from home"));
    const s = site();
    const got = await egress({ TUNNEL: t, ...unreachable }, URL_, {
      fetch: s.get,
      connect: noSocket,
    });
    expect(got.via).toBe("tunnel");
    expect(await got.response.text()).toBe("from home");
    expect(got.skipped).toEqual([]);
    expect(t.seen).toEqual([`http://relay/fetch?url=${encodeURIComponent(URL_)}`]);
    expect(s.seen).toEqual([]);
  });

  it("passes the site's own error through rather than trying elsewhere", async () => {
    const t = tunnel(() => relayed("forbidden", 403));
    const got = await egress({ TUNNEL: t }, URL_, { fetch: site().get });
    expect(got.via).toBe("tunnel");
    expect(got.response.status).toBe(403);
  });

  it("moves on when the tunnel is down, and remembers it is down", async () => {
    const s = site();
    const first = await egress({ TUNNEL: dead }, URL_, { fetch: s.get });
    expect(first.via).toBe("direct");
    expect(first.skipped[0]).toBe("tunnel: Network connection lost.");

    const up = tunnel(() => relayed("from home"));
    const second = await egress({ TUNNEL: up }, URL_, { fetch: s.get });
    expect(second.skipped[0]).toBe("tunnel: down in the last minute");
    expect(up.seen).toEqual([]);
  });

  it("treats a 5xx the relay did not mark as nothing listening", async () => {
    const t = tunnel(() => page("Bad Gateway", 502));
    const got = await egress({ TUNNEL: t }, URL_, { fetch: site().get });
    expect(got.skipped[0]).toBe("tunnel: relay not answering (HTTP 502)");
    expect(got.via).toBe("direct");
  });

  it("moves on when the relay could not reach the site, without writing the tunnel off", async () => {
    const t = tunnel(() => page("ENOTFOUND", 502, { "x-relay-error": "getaddrinfo ENOTFOUND" }));
    await egress({ TUNNEL: t }, URL_, { fetch: site().get });
    await egress({ TUNNEL: t }, URL_, { fetch: site().get });
    expect(t.seen).toHaveLength(2);
  });

  it("falls back to Cloudflare when the unblocker cannot be reached", async () => {
    const got = await egress({ TUNNEL: dead, ...unreachable }, URL_, {
      fetch: site().get,
      connect: noSocket,
    });
    expect(got.via).toBe("direct");
    expect(await got.response.text()).toBe("from cloudflare");
    expect(got.skipped).toEqual([
      "tunnel: Network connection lost.",
      "unblocker: proxy request failed, cannot connect to the specified address",
    ]);
  });

  it("says which routes were never configured", async () => {
    const got = await egress({}, URL_, { fetch: site().get });
    expect(got.skipped).toEqual(["tunnel: not bound", "unblocker: no APIFY_PROXY_PASSWORD"]);
  });
});

describe("naming a route", () => {
  it("uses only that route", async () => {
    const got = await egress({ TUNNEL: tunnel(() => relayed("home")) }, URL_, {
      via: "direct",
      fetch: site().get,
    });
    expect(got.via).toBe("direct");
  });

  it("fails rather than falling back", async () => {
    await expect(
      egress({ TUNNEL: dead }, URL_, { via: "tunnel", fetch: site().get }),
    ).rejects.toThrow("No route could fetch https://example.org/page: tunnel: Network");
  });
});
