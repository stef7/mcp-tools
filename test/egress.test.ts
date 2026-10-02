/**
 * core/egress.ts: which route answers, and what the ones before it are recorded as saying. The
 * tunnel and the site are stand-ins; the unblocker's own behaviour is in proxy.test.ts, so here
 * it is either unconfigured or a proxy that cannot be reached.
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
type Answer = (signal?: AbortSignal) => Response | Promise<Response>;
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
      return answer(signal);
    },
  };
};
const relayed = (body: string, status = 200) =>
  page(body, status, { "x-cf-tunnel-relay-status": String(status) });
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

const NO_UNBLOCKER = "unblocker: no APIFY_PROXY_PASSWORD";

/** The worker's own fetch, answering with this status. */
const siteSays = (status: number) => {
  const seen: string[] = [];
  const get = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return page(`cloudflare got ${status}`, status);
  }) as typeof fetch;
  return { seen, get };
};

describe("by default", () => {
  it("fetches directly, and never touches the tunnel or the unblocker", async () => {
    const t = tunnel(() => relayed("from home"));
    const got = await egress({ TUNNEL: t, ...unreachable }, URL_, {
      fetch: site().get,
      connect: noSocket,
    });
    expect(got.via).toBe("direct");
    expect(await got.response.text()).toBe("from cloudflare");
    expect(got.skipped).toEqual([]);
    expect(t.seen).toEqual([]);
  });

  it.each([403, 429, 451, 503])("tries the unblocker when the site answers %i", async (status) => {
    let asked = false;
    const got = await egress(unreachable, URL_, {
      fetch: siteSays(status).get,
      connect: (() => {
        asked = true;
        throw new Error("no proxy here");
      }) as never,
    });
    expect(asked).toBe(true);
    // The unblocker failed too, so the site's own answer comes back rather than an error.
    expect(got.via).toBe("direct");
    expect(got.response.status).toBe(status);
    expect(got.skipped).toEqual(["unblocker: no proxy here"]);
  });

  it.each([200, 301, 401, 404, 500])(
    "keeps a %i without paying for the unblocker",
    async (status) => {
      let asked = false;
      const got = await egress(unreachable, URL_, {
        fetch: siteSays(status).get,
        connect: (() => {
          asked = true;
          throw new Error("no proxy here");
        }) as never,
      });
      expect(asked).toBe(false);
      expect(got.response.status).toBe(status);
    },
  );

  it("tries the unblocker when the direct fetch cannot connect at all", async () => {
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(egress(unreachable, URL_, { fetch: broken, connect: noSocket })).rejects.toThrow(
      "No route could fetch https://example.org/page: direct: fetch failed; unblocker: proxy request failed",
    );
  });
});

describe("a blocked answer", () => {
  const says = (status: number, headers: Record<string, string>) =>
    (async () => page("challenge", status, headers)) as unknown as typeof fetch;
  const home = () => tunnel(() => relayed("from home"));

  it.each([
    [200, { "cf-mitigated": "challenge" }, "Cloudflare challenge (HTTP 200)"],
    [202, { "x-amzn-waf-action": "challenge" }, "AWS WAF challenge (HTTP 202)"],
    [405, { "x-amzn-waf-action": "captcha" }, "AWS WAF captcha (HTTP 405)"],
  ])("is spotted from headers alone: %i %o", async (status, headers, note) => {
    const got = await egress({ TUNNEL: home() }, URL_, {
      via: ["direct", "tunnel"],
      fetch: says(status, headers),
    });
    expect(got.via).toBe("tunnel");
    expect(got.skipped).toEqual([`direct: ${note}`]);
  });

  it("is not read to be spotted, so a good answer's body is still unread", async () => {
    const got = await egress({}, URL_, { via: ["direct"], fetch: site().get });
    expect(got.response.bodyUsed).toBe(false);
  });

  it("ignores other values of those headers", async () => {
    const got = await egress({ TUNNEL: home() }, URL_, {
      via: ["direct", "tunnel"],
      fetch: says(200, { "x-amzn-waf-action": "allow" }),
    });
    expect(got.via).toBe("direct");
  });

  it("gives way to the next route's answer, and is recorded as skipped", async () => {
    const t = tunnel(() => relayed("from home"));
    const got = await egress({ TUNNEL: t }, URL_, {
      via: ["direct", "tunnel"],
      fetch: siteSays(403).get,
    });
    expect(got.via).toBe("tunnel");
    expect(await got.response.text()).toBe("from home");
    expect(got.skipped).toEqual(["direct: blocked (HTTP 403)"]);
  });

  it("is returned when every route is blocked: the last one's, with the earlier ones skipped", async () => {
    const t = tunnel(() => relayed("home got 429", 429));
    const got = await egress({ TUNNEL: t }, URL_, {
      via: ["direct", "tunnel"],
      fetch: siteSays(403).get,
    });
    expect(got.via).toBe("tunnel");
    expect(got.response.status).toBe(429);
    expect(await got.response.text()).toBe("home got 429");
    expect(got.skipped).toEqual(["direct: blocked (HTTP 403)"]);
  });
});

describe("the tunnel", () => {
  const alone = { via: ["tunnel"] } as const;

  it("is used first when named first, and asks the relay for the URL", async () => {
    const t = tunnel(() => relayed("from home"));
    const s = site();
    const got = await egress({ TUNNEL: t, ...unreachable }, URL_, {
      via: ["tunnel", "unblocker", "direct"],
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
    const got = await egress({ TUNNEL: t }, URL_, { via: ["tunnel", "direct"], fetch: site().get });
    expect(got.via).toBe("tunnel");
    expect(got.response.status).toBe(404);
  });

  it("alone, fails when offline, and remembers it is down", async () => {
    const s = site();
    await expect(egress({ TUNNEL: dead }, URL_, { ...alone, fetch: s.get })).rejects.toThrow(
      "No route could fetch https://example.org/page: tunnel: Network connection lost.",
    );
    const up = tunnel(() => relayed("from home"));
    await expect(egress({ TUNNEL: up }, URL_, { ...alone, fetch: s.get })).rejects.toThrow(
      "tunnel: down in the last minute",
    );
    expect(up.seen).toEqual([]);
    expect(s.seen).toEqual([]);
  });

  it("offline, hands over to the next route named", async () => {
    const got = await egress({ TUNNEL: dead, ...unreachable }, URL_, {
      via: ["tunnel", "unblocker", "direct"],
      fetch: site().get,
      connect: noSocket,
    });
    expect(got.via).toBe("direct");
    expect(got.skipped).toEqual([
      "tunnel: Network connection lost.",
      "unblocker: proxy request failed, cannot connect to the specified address",
    ]);
  });

  it.each([502, 404])(
    "counts an answer the relay did not mark (HTTP %i) as the relay not answering",
    async (status) => {
      const t = tunnel(() => page("not the relay", status));
      await expect(egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get })).rejects.toThrow(
        `tunnel: cf-tunnel-relay not answering (HTTP ${status})`,
      );
    },
  );

  it("is not written off when only the site was unreachable", async () => {
    const t = tunnel(() =>
      page("ENOTFOUND", 502, { "x-cf-tunnel-relay-error": "getaddrinfo ENOTFOUND" }),
    );
    const get = site().get;
    await expect(egress({ TUNNEL: t }, URL_, { ...alone, fetch: get })).rejects.toThrow(
      "tunnel: getaddrinfo ENOTFOUND",
    );
    await expect(egress({ TUNNEL: t }, URL_, { ...alone, fetch: get })).rejects.toThrow();
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
    const got = await egress({ TUNNEL: t }, URL_, { via: ["tunnel", "direct"], fetch: site().get });
    expect(got.via).toBe("direct");
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
    await expect(egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get })).rejects.toThrow(
      "tunnel: destination_unavailable",
    );
    await expect(egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get })).rejects.toThrow(
      "tunnel: down in the last minute",
    );
    expect(t.checks).toBe(1);
  });

  it("counts a /health that is not the relay's as the relay not answering", async () => {
    const t = tunnel(loading, () => page("File not found", 404));
    await expect(egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get })).rejects.toThrow(
      "tunnel: cf-tunnel-relay not answering (HTTP 404)",
    );
  });

  it("is not written off when only the page was slow, but checks /health again", async () => {
    let slow = true;
    const t = tunnel(() => (slow ? timedOut() : relayed("from home")));
    const got = await egress({ TUNNEL: t }, URL_, { via: ["tunnel", "direct"], fetch: site().get });
    expect(got.via).toBe("direct");
    expect(got.skipped).toEqual(["tunnel: no answer within 35s"]);
    slow = false;
    const next = await egress({ TUNNEL: t }, URL_, { ...alone, fetch: site().get });
    expect(next.via).toBe("tunnel");
    expect(t.checks).toBe(2);
  });

  it("says so when it is not bound", async () => {
    await expect(egress({}, URL_, { ...alone, fetch: site().get })).rejects.toThrow(
      "tunnel: not bound",
    );
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
    const got = await egress({ TUNNEL: t }, URL_, { via: "browser,direct", fetch: site().get });
    expect(got.via).toBe("direct");
    expect(got.skipped).toEqual([`browser: ${no}`]);
  });
});

describe("via", () => {
  it("takes a comma-separated string as well as a list", async () => {
    const t = tunnel(() => relayed("from home"));
    const got = await egress({ TUNNEL: t }, URL_, { via: " Tunnel , direct", fetch: site().get });
    expect(got.via).toBe("tunnel");
  });

  it("uses only the one route named, with no fallback", async () => {
    const got = await egress({ TUNNEL: tunnel(() => relayed("home")) }, URL_, {
      via: ["direct"],
      fetch: site().get,
    });
    expect(got.via).toBe("direct");
    await expect(egress({}, URL_, { via: "unblocker", fetch: site().get })).rejects.toThrow(
      "No route could fetch https://example.org/page: unblocker: no APIFY_PROXY_PASSWORD",
    );
  });

  it("tries a route named twice only once", async () => {
    const t = tunnel(() => page("Bad Gateway", 502));
    await expect(
      egress({ TUNNEL: t }, URL_, { via: ["tunnel", "tunnel"], fetch: site().get }),
    ).rejects.toThrow();
    expect(t.seen).toHaveLength(1);
  });

  it("refuses a name it does not know rather than skipping it", async () => {
    await expect(egress({}, URL_, { via: ["tunel", "direct"], fetch: site().get })).rejects.toThrow(
      "Unknown route tunel; use unblocker, tunnel, browser, direct.",
    );
  });

  it("falls back to the worker's EGRESS_VIA, then to direct,unblocker", async () => {
    const t = tunnel(() => relayed("from home"));
    const set = await egress({ TUNNEL: t, EGRESS_VIA: "tunnel,direct" }, URL_, {
      fetch: site().get,
    });
    expect(set.via).toBe("tunnel");
    const unset = await egress({ TUNNEL: t }, URL_, { fetch: siteSays(403).get });
    expect(unset.via).toBe("direct");
    expect(unset.skipped).toEqual([NO_UNBLOCKER]);
  });

  it("from the call wins over EGRESS_VIA", async () => {
    const t = tunnel(() => relayed("from home"));
    const got = await egress({ TUNNEL: t, EGRESS_VIA: "tunnel" }, URL_, {
      via: ["direct"],
      fetch: site().get,
    });
    expect(got.via).toBe("direct");
  });
});
