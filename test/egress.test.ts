/**
 * core/egress.ts: which route answers, and what the ones before it are recorded as saying. The
 * tunnel and the site (the fallback) are stand-ins; the smart route's own behaviour is in
 * proxy.test.ts, so here it is either unconfigured or a proxy that cannot be reached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { egress, resetTunnel } from "../core/egress";

const URL_ = "https://example.org/page";
const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

/**
 * A tunnel that answers the way the relay does, or throws the way a dead tunnel does. `/health`
 * answers "ok" unless told otherwise; `seen` holds the pages asked for, `checks` the health checks.
 */
type Answer = (signal?: AbortSignal, input?: string) => Response | Promise<Response>;
const tunnel = (answer: Answer, health: Answer = () => page("ok")) => {
  const seen: string[] = [];
  let checks = 0;
  return {
    seen,
    get checks() {
      return checks;
    },
    async fetch(input: string, init?: RequestInit) {
      const signal = init?.signal ?? undefined;
      if (input.endsWith("/health")) {
        checks++;
        return health(signal);
      }
      seen.push(input);
      return answer(signal, input);
    },
  };
};
const relayed = (body: string, status = 200, headers: Record<string, string> = {}) =>
  page(body, status, { "x-cf-tunnel-relay-status": String(status), ...headers });
const lost = () => {
  throw new Error("Network connection lost.");
};
const dead = tunnel(lost, lost);
const timedOut = () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};
/** A page still loading: it answers only by failing, once it is dropped. */
const loading: Answer = (signal) =>
  new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

/** The fallback: the worker's own fetch, answering as the site. */
const site = () => {
  const seen: string[] = [];
  const get = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return page("from cloudflare");
  }) as typeof fetch;
  return { seen, get };
};

/** A smart route whose proxy cannot be reached at all. */
const unreachable = { APIFY_PROXY_PASSWORD: "secret" };
const noSocket = (() => {
  throw new Error("proxy request failed, cannot connect to the specified address");
}) as never;

beforeEach(resetTunnel);

const NO_SMART = "smart: no APIFY_PROXY_PASSWORD";
const NO_PROXY = "smart: proxy request failed, cannot connect to the specified address";

/** The fallback, answering with this status. */
const siteSays = (status: number) => {
  const seen: string[] = [];
  const get = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return page(`cloudflare got ${status}`, status);
  }) as typeof fetch;
  return { seen, get };
};

/** A fallback that cannot connect at all. */
const broken = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

describe("by default", () => {
  it("tries the smart route, then the fallback, and never the tunnel", async () => {
    const t = tunnel(() => relayed("from home"));
    const got = await egress({ TUNNEL: t, ...unreachable }, URL_, {
      fetch: site().get,
      connect: noSocket,
    });
    expect(got.via).toBe("fallback");
    expect(await got.response.text()).toBe("from cloudflare");
    expect(got.skipped).toEqual([NO_PROXY]);
    expect(t.seen).toEqual([]);
  });

  it("goes straight to the fallback without APIFY_PROXY_PASSWORD", async () => {
    const got = await egress({}, URL_, { fetch: site().get });
    expect(got.via).toBe("fallback");
    expect(got.skipped).toEqual([NO_SMART]);
  });
});

describe("the fallback", () => {
  it.each([200, 301, 401, 403, 404, 429, 500, 503])(
    "stands, whatever it answers (HTTP %i)",
    async (status) => {
      const got = await egress(unreachable, URL_, {
        fetch: siteSays(status).get,
        connect: noSocket,
      });
      expect(got.via).toBe("fallback");
      expect(got.response.status).toBe(status);
      expect(got.skipped).toEqual([NO_PROXY]);
    },
  );

  it("is not asked when a named route answers", async () => {
    const s = site();
    const got = await egress({ TUNNEL: tunnel(() => relayed("from home")) }, URL_, {
      via: ["tunnel"],
      fetch: s.get,
    });
    expect(got.via).toBe("tunnel");
    expect(s.seen).toEqual([]);
  });

  it("is asked after a blocked answer, and its own answer stands, blocked or not", async () => {
    const t = tunnel(() => relayed("home got 429", 429));
    const got = await egress({ TUNNEL: t }, URL_, { via: ["tunnel"], fetch: siteSays(403).get });
    expect(got.via).toBe("fallback");
    expect(got.response.status).toBe(403);
    expect(got.skipped).toEqual(["tunnel: blocked (HTTP 429)"]);
  });

  it("cannot connect: the last blocked answer comes back instead", async () => {
    const t = tunnel(() => relayed("home got 429", 429));
    const got = await egress({ TUNNEL: t }, URL_, { via: ["tunnel"], fetch: broken });
    expect(got.via).toBe("tunnel");
    expect(got.response.status).toBe(429);
    expect(await got.response.text()).toBe("home got 429");
    expect(got.skipped).toEqual(["fallback: fetch failed"]);
  });

  it("cannot connect, and nothing else answered: an error naming every route", async () => {
    await expect(egress(unreachable, URL_, { fetch: broken, connect: noSocket })).rejects.toThrow(
      `No route could fetch https://example.org/page: ${NO_PROXY}; fallback: fetch failed`,
    );
  });
});

describe("a blocked answer", () => {
  const challenged = (status: number, headers: Record<string, string>) =>
    tunnel(() => relayed("challenge", status, headers));

  it.each([
    [200, { "cf-mitigated": "challenge" }, "Cloudflare challenge (HTTP 200)"],
    [202, { "x-amzn-waf-action": "challenge" }, "AWS WAF challenge (HTTP 202)"],
    [405, { "x-amzn-waf-action": "captcha" }, "AWS WAF captcha (HTTP 405)"],
  ])("is spotted from headers alone: %i %o", async (status, headers, note) => {
    const got = await egress({ TUNNEL: challenged(status, headers) }, URL_, {
      via: ["tunnel"],
      fetch: site().get,
    });
    expect(got.via).toBe("fallback");
    expect(got.skipped).toEqual([`tunnel: ${note}`]);
  });

  it("is not read to be spotted, so a good answer's body is still unread", async () => {
    const got = await egress({ TUNNEL: tunnel(() => relayed("from home")) }, URL_, {
      via: ["tunnel"],
      fetch: site().get,
    });
    expect(got.response.bodyUsed).toBe(false);
  });

  it("ignores other values of those headers", async () => {
    const got = await egress({ TUNNEL: challenged(200, { "x-amzn-waf-action": "allow" }) }, URL_, {
      via: ["tunnel"],
      fetch: site().get,
    });
    expect(got.via).toBe("tunnel");
  });

  it("gives way to the next route named, and is recorded as skipped", async () => {
    const t = tunnel((_, input) =>
      input?.includes("mode=browser") ? relayed("rendered") : relayed("blocked", 403),
    );
    const got = await egress({ TUNNEL: t }, URL_, {
      via: ["tunnel", "browser"],
      fetch: site().get,
    });
    expect(got.via).toBe("browser");
    expect(await got.response.text()).toBe("rendered");
    expect(got.skipped).toEqual(["tunnel: blocked (HTTP 403)"]);
  });
});

describe("the tunnel", () => {
  const alone = { via: ["tunnel"] } as const;

  it("is used first when named first, and asks the relay for the URL", async () => {
    const t = tunnel(() => relayed("from home"));
    const s = site();
    const got = await egress({ TUNNEL: t, ...unreachable }, URL_, {
      via: ["tunnel", "smart"],
      fetch: s.get,
      connect: noSocket,
    });
    expect(got.via).toBe("tunnel");
    expect(await got.response.text()).toBe("from home");
    expect(got.skipped).toEqual([]);
    expect(t.seen).toEqual([`http://cf-tunnel-relay/fetch?url=${encodeURIComponent(URL_)}`]);
    expect(s.seen).toEqual([]);
  });

  it("passes the site's own answer through", async () => {
    const t = tunnel(() => relayed("not found", 404));
    const got = await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    expect(got.via).toBe("tunnel");
    expect(got.response.status).toBe(404);
  });

  it("offline, gives way to the fallback, and remembers it is down", async () => {
    const s = site();
    const first = await egress({ TUNNEL: dead }, URL_, { ...alone, fetch: s.get });
    expect(first.via).toBe("fallback");
    expect(first.skipped).toEqual(["tunnel: Network connection lost."]);
    const up = tunnel(() => relayed("from home"));
    const second = await egress({ TUNNEL: up }, URL_, { ...alone, fetch: s.get });
    expect(second.skipped).toEqual(["tunnel: down in the last minute"]);
    expect(up.seen).toEqual([]);
    expect(s.seen).toHaveLength(2);
  });

  it("offline, hands over to the next route named, then the fallback", async () => {
    const got = await egress({ TUNNEL: dead, ...unreachable }, URL_, {
      via: ["tunnel", "smart"],
      fetch: site().get,
      connect: noSocket,
    });
    expect(got.via).toBe("fallback");
    expect(got.skipped).toEqual(["tunnel: Network connection lost.", NO_PROXY]);
  });

  it.each([502, 404])(
    "counts an answer the relay did not mark (HTTP %i) as the relay not answering",
    async (status) => {
      const t = tunnel(() => page("not the relay", status));
      const got = await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
      expect(got.skipped).toEqual([`tunnel: cf-tunnel-relay not answering (HTTP ${status})`]);
    },
  );

  it("is not written off when only the site was unreachable", async () => {
    const t = tunnel(() =>
      page("ENOTFOUND", 502, { "x-cf-tunnel-relay-error": "getaddrinfo ENOTFOUND" }),
    );
    const get = site().get;
    const first = await egress({ TUNNEL: t }, URL_, { ...alone, fetch: get });
    expect(first.skipped).toEqual(["tunnel: getaddrinfo ENOTFOUND"]);
    await egress({ TUNNEL: t }, URL_, { ...alone, fetch: get });
    expect(t.seen).toHaveLength(2);
  });

  it("checks /health with the page, and only once in 30 seconds", async () => {
    const t = tunnel(() => relayed("from home"));
    await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    expect(t.checks).toBe(1);
    expect(t.seen).toHaveLength(2);
    const later = Date.now() + 31_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
      expect(t.checks).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("asks for /health alongside the page, and drops the page when /health does not answer", async () => {
    let dropped = false;
    const t = tunnel((signal) => {
      signal?.addEventListener("abort", () => (dropped = true));
      return loading(signal);
    }, timedOut);
    const got = await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    expect(got.via).toBe("fallback");
    expect(got.skipped).toEqual(["tunnel: cf-tunnel-relay did not answer /health within 2s"]);
    expect(t.seen).toHaveLength(1);
    expect(t.checks).toBe(1);
    expect(dropped).toBe(true);
  });

  it("drops /health when the page answers first, and counts the Mac as there", async () => {
    let dropped = false;
    const t = tunnel(
      () => relayed("from home"),
      (signal) => {
        signal?.addEventListener("abort", () => (dropped = true));
        return loading(signal);
      },
    );
    const got = await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    expect(got.via).toBe("tunnel");
    expect(dropped).toBe(true);
    await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    expect(t.checks).toBe(1);
  });

  it("passes on Cloudflare's own word when it knows the tunnel is down", async () => {
    const t = tunnel(loading, () => {
      throw new Error("destination_unavailable");
    });
    const first = await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    expect(first.skipped).toEqual(["tunnel: destination_unavailable"]);
    const second = await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    expect(second.skipped).toEqual(["tunnel: down in the last minute"]);
    expect(t.checks).toBe(1);
  });

  it("counts a /health that is not the relay's as the relay not answering", async () => {
    const t = tunnel(loading, () => page("File not found", 404));
    const got = await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    expect(got.skipped).toEqual(["tunnel: cf-tunnel-relay not answering (HTTP 404)"]);
  });

  it("is not written off when only the page was slow, but checks /health again", async () => {
    let slow = true;
    const t = tunnel(() => (slow ? timedOut() : relayed("from home")));
    const got = await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    expect(got.via).toBe("fallback");
    expect(got.skipped).toEqual(["tunnel: no answer within 35s"]);
    slow = false;
    const next = await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    expect(next.via).toBe("tunnel");
    expect(t.checks).toBe(2);
  });

  it("says so when it is not bound", async () => {
    const got = await egress({}, URL_, { ...alone, fetch: site().get });
    expect(got.via).toBe("fallback");
    expect(got.skipped).toEqual(["tunnel: not bound"]);
  });
});

describe("the browser", () => {
  it("asks the same relay for the page loaded in Chrome", async () => {
    const t = tunnel(() => relayed("rendered"));
    const got = await egress({ TUNNEL: t }, URL_, { via: ["browser"], fetch: site().get });
    expect(got.via).toBe("browser");
    expect(await got.response.text()).toBe("rendered");
    expect(t.seen).toEqual([
      `http://cf-tunnel-relay/fetch?url=${encodeURIComponent(URL_)}&mode=browser`,
    ]);
  });

  it("moves on when the relay will not open that domain", async () => {
    const no = "refusing example.org: not in BROWSER_ALLOW_DOMAINS";
    const t = tunnel(() => page(no, 502, { "x-cf-tunnel-relay-error": no }));
    const got = await egress({ TUNNEL: t }, URL_, { via: "browser", fetch: site().get });
    expect(got.via).toBe("fallback");
    expect(got.skipped).toEqual([`browser: ${no}`]);
  });
});

describe("via", () => {
  it("takes a comma-separated string as well as a list", async () => {
    const t = tunnel(() => relayed("from home"));
    const got = await egress({ TUNNEL: t }, URL_, { via: " Tunnel , smart", fetch: site().get });
    expect(got.via).toBe("tunnel");
  });

  it("is always followed by the fallback, even after a single route", async () => {
    const got = await egress({}, URL_, { via: "smart", fetch: site().get });
    expect(got.via).toBe("fallback");
    expect(got.skipped).toEqual([NO_SMART]);
  });

  it("tries a route named twice only once", async () => {
    const t = tunnel(() => page("Bad Gateway", 502));
    await egress({ TUNNEL: t }, URL_, { via: ["tunnel", "tunnel"], fetch: site().get });
    expect(t.seen).toHaveLength(1);
  });

  it("refuses a name it does not know rather than skipping it", async () => {
    await expect(egress({}, URL_, { via: ["tunel"], fetch: site().get })).rejects.toThrow(
      "Unknown route tunel; use smart, tunnel, browser.",
    );
  });

  it.each(["direct", "unblocker"])("no longer knows %s", async (name) => {
    await expect(egress({}, URL_, { via: [name], fetch: site().get })).rejects.toThrow(
      `Unknown route ${name}`,
    );
  });

  it("falls back to the worker's EGRESS_VIA, then to smart", async () => {
    const t = tunnel(() => relayed("from home"));
    const set = await egress({ TUNNEL: t, EGRESS_VIA: "tunnel" }, URL_, { fetch: site().get });
    expect(set.via).toBe("tunnel");
    const unset = await egress({ TUNNEL: t }, URL_, { fetch: site().get });
    expect(unset.via).toBe("fallback");
    expect(unset.skipped).toEqual([NO_SMART]);
  });

  it("from the call wins over EGRESS_VIA", async () => {
    const t = tunnel(() => relayed("rendered"));
    const got = await egress({ TUNNEL: t, EGRESS_VIA: "tunnel" }, URL_, {
      via: ["browser"],
      fetch: site().get,
    });
    expect(got.via).toBe("browser");
  });
});
