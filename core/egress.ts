/**
 * Getting a URL off the open web past whatever blocks a Cloudflare IP, through whichever routes
 * the caller names, in the order it names them:
 *
 *   unblocker  Apify Proxy's Unblocker, through core/proxy.ts: it deals with bot checks and
 *              CAPTCHAs itself and picks the country. Billed per successful request.
 *   tunnel     the Mac behind Cloudflare Tunnel, via scripts/cf-tunnel-relay.mjs: a home
 *              connection in Australia. Only as good as the Mac is awake.
 *   browser    the same Mac, the page loaded in its Chrome: gets past challenges that clear
 *              themselves, and has the sign-ins made there. The relay refuses it for every domain
 *              it has not been told to allow.
 *   direct     the worker's own `fetch`, from whichever Cloudflare colo ran it. Always there.
 *
 * `via` is that order: `["tunnel", "unblocker", "direct"]`, or the same as a comma-separated
 * string. One name means that route and no fallback. Unset, it is the worker's `EGRESS_VIA`, and
 * failing that `direct,unblocker`: free first, paid only when the free one was turned away.
 *
 * The next route is tried when one cannot get an answer at all, or when the answer is one of
 * `blockedBy` — a status a bot check or geo-block hands out, or a challenge header. Any other answer, a 404 included, is
 * the site speaking and is returned. If every route is blocked, the last blocked answer is
 * returned rather than an error, since it is still what the site said. What was passed over comes
 * back in `skipped`, so a caller can see that the unblocker was paid for because Cloudflare got a
 * 403.
 */

import { ProxyError, proxyFetch, type ProxyFetchOptions } from "./proxy";

export const ROUTES = ["unblocker", "tunnel", "browser", "direct"] as const;
export type Route = (typeof ROUTES)[number];

export const DEFAULT_VIA: readonly Route[] = ["direct", "unblocker"];

/**
 * Answers that mean "not you", not "not here": 403 and 429 from bot checks and rate limits, 451
 * from geo-blocks, 503 from challenge pages (Cloudflare's "Just a moment…" among them). A 401 is
 * left out — a login wall is not something another IP gets past.
 */
export const BLOCKED = new Set([403, 429, 451, 503]);

/**
 * Why this answer is a block, or undefined when it is the site speaking. Headers and status only:
 * the body is never read, so a good answer streams on untouched.
 *
 *   cf-mitigated: challenge       Cloudflare's own marker on every Challenge Page
 *   x-amzn-waf-action             AWS WAF: `challenge` comes as a 202 and `captcha` as a 405,
 *                                 neither of which the status list would catch
 */
export const blockedBy = (res: Response): string | undefined => {
  if (res.headers.get("cf-mitigated")?.toLowerCase() === "challenge")
    return `Cloudflare challenge (HTTP ${res.status})`;
  const aws = res.headers.get("x-amzn-waf-action")?.toLowerCase();
  if (aws === "challenge" || aws === "captcha") return `AWS WAF ${aws} (HTTP ${res.status})`;
  if (BLOCKED.has(res.status)) return `blocked (HTTP ${res.status})`;
  return undefined;
};

/** Routes in order, as a list or as `"tunnel,unblocker"`. */
export type Via = string | readonly string[];

/**
 * The order to try, from `via`: names checked, duplicates dropped, empty meaning "not given".
 * An unknown name is an error rather than something to skip, since a typo would otherwise
 * quietly fall through to a route the caller never asked for.
 */
export const parseVia = (via: Via | undefined): Route[] | undefined => {
  const names = (typeof via === "string" ? via.split(",") : (via ?? []))
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  const bad = names.filter((n) => !(ROUTES as readonly string[]).includes(n));
  if (bad.length) throw new Error(`Unknown route ${bad.join(", ")}; use ${ROUTES.join(", ")}.`);
  return names.length ? [...new Set(names as Route[])] : undefined;
};

const orderFor = (env: EgressEnv, opts: EgressOptions) =>
  parseVia(opts.via) ?? parseVia(env.EGRESS_VIA) ?? DEFAULT_VIA;

/** Just the part of a VPC Service binding this uses, so a test can pass a plain object. */
type Fetcher = { fetch(input: string, init?: RequestInit): Promise<Response> };

export type EgressEnv = {
  TUNNEL?: Fetcher;
  APIFY_PROXY_PASSWORD?: string;
  /** This worker's default order, e.g. "tunnel,unblocker,direct". */
  EGRESS_VIA?: string;
};

export type EgressOptions = {
  headers?: Record<string, string>;
  /** Routes to try, in order; see the top of this file. */
  via?: Via;
  /** The direct route's fetch; tests replace it. */
  fetch?: typeof fetch;
  /** The proxy route's TCP connect; tests replace it. */
  connect?: ProxyFetchOptions["connect"];
};

export type Egress = { response: Response; via: Route; skipped: string[] };

/** A route that could not serve this URL, and why, in words that go straight into `skipped`. */
class Pass extends Error {}

// ─── tunnel ───────────────────────────────────────────────────────────────────────────────────
/**
 * The page and the relay's `/health` are asked for together. `/health` answers at once, so it
 * tells a Mac that is not there from a site that is slow, which the page alone cannot: the relay
 * sends nothing back until it has the whole page, so a slow site and a Mac that has just gone to
 * sleep both look like silence.
 *
 * Whichever settles first decides. The page answering means the Mac is there, and the check is
 * dropped. A failed check — Cloudflare's own `destination_unavailable` at once, silence for
 * HEALTH_TIMEOUT_MS, or something other than the relay answering — means it is not, and the page
 * is dropped. A good check leaves the page to take as long as it takes, up to its own timeout,
 * which then costs that request only.
 *
 * Both outcomes are remembered, per isolate, so they are hints that cost one check per isolate,
 * not shared switches: the Mac missing skips the tunnel for DOWN_FOR_MS, and the Mac there skips
 * the check for UP_FOR_MS. A page that times out forgets the latter, in case the Mac went to sleep.
 */
const HEALTH_TIMEOUT_MS = 2_000;
const DOWN_FOR_MS = 60_000;
const UP_FOR_MS = 30_000;
/** The relay gives up on a site after 30 seconds and says so; this is for when it cannot. */
const PAGE_TIMEOUT_MS = 35_000;
/** Chrome loads the page and waits out a challenge; the relay gives up on its own before this. */
const BROWSER_TIMEOUT_MS = 60_000;
let tunnelDownUntil = 0;
let tunnelUpUntil = 0;

/** For tests, which would otherwise inherit one another's outage. */
export const resetTunnel = () => {
  tunnelDownUntil = 0;
  tunnelUpUntil = 0;
};

const tunnelDown = (route: string, why: string) => {
  tunnelDownUntil = Date.now() + DOWN_FOR_MS;
  tunnelUpUntil = 0;
  return new Pass(`${route}: ${why}`);
};

const isTimeout = (e: unknown) => e instanceof Error && e.name === "TimeoutError";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Why cf-tunnel-relay is not there to ask, or nothing if it is. Never throws. */
const unhealthy = async (tunnel: Fetcher, stop: AbortSignal): Promise<string | undefined> => {
  try {
    // The VPC Service fixes host and port (localhost:8811 on the Mac); only the path matters.
    const res = await tunnel.fetch("http://cf-tunnel-relay/health", {
      signal: AbortSignal.any([stop, AbortSignal.timeout(HEALTH_TIMEOUT_MS)]),
    });
    // Anything else is not the relay: a 5xx is cloudflared finding nothing listening on the
    // port, and a 404 some other program on it (`python -m http.server` answers every URL so).
    if (res.ok && (await res.text()).trim() === "ok") return undefined;
    await res.body?.cancel();
    return `cf-tunnel-relay not answering (HTTP ${res.status})`;
  } catch (e) {
    return isTimeout(e)
      ? `cf-tunnel-relay did not answer /health within ${HEALTH_TIMEOUT_MS / 1000}s`
      : message(e);
  }
};

const viaTunnel = async (
  tunnel: Fetcher,
  url: string,
  headers: Record<string, string>,
  route: "tunnel" | "browser" = "tunnel",
) => {
  if (Date.now() < tunnelDownUntil) throw new Pass(`${route}: down in the last minute`);
  const browser = route === "browser";
  const timeout = browser ? BROWSER_TIMEOUT_MS : PAGE_TIMEOUT_MS;
  // Two switches, since dropping the check must not cut off a page already being read.
  const dropPage = new AbortController();
  const dropCheck = new AbortController();
  const mode = browser ? "&mode=browser" : "";
  const page = tunnel.fetch(`http://cf-tunnel-relay/fetch?url=${encodeURIComponent(url)}${mode}`, {
    headers,
    signal: AbortSignal.any([dropPage.signal, AbortSignal.timeout(timeout)]),
  });
  let res: Response;
  try {
    if (Date.now() >= tunnelUpUntil) {
      const first = await Promise.race([
        page.then((r) => ({ page: r })),
        unhealthy(tunnel, dropCheck.signal).then((why) => ({ why })),
      ]);
      if ("why" in first && first.why) {
        dropPage.abort();
        page.catch(() => {});
        throw tunnelDown(route, first.why);
      }
      dropCheck.abort();
    }
    res = await page;
  } catch (e) {
    dropCheck.abort();
    if (e instanceof Pass) throw e;
    // The Mac was there a moment ago, so a timeout is most likely the site. Check again next time.
    if (isTimeout(e)) {
      tunnelUpUntil = 0;
      throw new Pass(`${route}: no answer within ${timeout / 1000}s`);
    }
    throw tunnelDown(route, message(e));
  }
  // The relay marks everything it says itself, so an unmarked answer is not the relay.
  const relayError = res.headers.get("x-cf-tunnel-relay-error");
  if (!relayError && !res.headers.has("x-cf-tunnel-relay-status")) {
    await res.body?.cancel();
    throw tunnelDown(route, `cf-tunnel-relay not answering (HTTP ${res.status})`);
  }
  // Either way the relay answered, so the Mac is there.
  tunnelUpUntil = Date.now() + UP_FOR_MS;
  if (relayError) throw new Pass(`${route}: ${relayError}`);
  return res;
};

// ─── unblocker ────────────────────────────────────────────────────────────────────────────────────
/**
 * Apify Proxy's Unblocker. The group rides in the username; the password is the proxy password
 * from Apify Console -> Proxy, not the API token. External connections need a paid Apify plan.
 *
 * No country: Apify says pinning one "can reduce how effectively Unblocker bypasses anti-bot
 * protection", and getting past the block is the point. The tunnel is the Australian route.
 */
const APIFY_PROXY = { hostname: "proxy.apify.com", port: 8000, username: "groups-UNBLOCKER" };

const viaUnblocker = async (password: string, url: string, opts: EgressOptions) => {
  try {
    return await proxyFetch({ ...APIFY_PROXY, password }, url, {
      ...(opts.headers && { headers: opts.headers }),
      ...(opts.connect && { connect: opts.connect }),
      // Bot challenges take a while to get through.
      timeoutMs: 60_000,
    });
  } catch (e) {
    // Apify does not document what it answers once Unblocker units run out, so every refusal
    // moves on; the status says which it was.
    if (e instanceof ProxyError && e.status === 407)
      throw new Pass("unblocker: refused (407): wrong password, or no paid plan or units left");
    const message = e instanceof Error ? e.message : String(e);
    // Nor does it say whether Unblocker re-signs HTTPS to do its work. If it does, every https
    // URL fails here, and a Worker has no way to accept a certificate it cannot verify.
    const tls = /tls|ssl|certificate/i.test(message)
      ? " (every https URL failing like this means Unblocker re-signs HTTPS, which a Worker cannot accept)"
      : "";
    throw new Pass(`unblocker: ${message}${tls}`);
  }
};

// ─── the cascade ──────────────────────────────────────────────────────────────────────────────
export const egress = async (
  env: EgressEnv,
  url: string,
  opts: EgressOptions = {},
): Promise<Egress> => {
  const headers = opts.headers ?? {};
  const get = opts.fetch ?? fetch;
  const routes: Record<Route, (() => Promise<Response>) | string> = {
    tunnel: env.TUNNEL ? () => viaTunnel(env.TUNNEL!, url, headers) : "tunnel: not bound",
    browser: env.TUNNEL
      ? () => viaTunnel(env.TUNNEL!, url, headers, "browser")
      : "browser: not bound",
    unblocker: env.APIFY_PROXY_PASSWORD
      ? () => viaUnblocker(env.APIFY_PROXY_PASSWORD!, url, opts)
      : "unblocker: no APIFY_PROXY_PASSWORD",
    direct: () =>
      get(url, { headers }).catch((e: unknown) => {
        throw new Pass(`direct: ${e instanceof Error ? e.message : String(e)}`);
      }),
  };
  const skipped: string[] = [];
  /** The latest blocked answer, and where its note sits in `skipped`. */
  let blocked: { response: Response; via: Route; at: number } | undefined;
  for (const via of orderFor(env, opts)) {
    const route = routes[via];
    if (typeof route === "string") {
      skipped.push(route);
      continue;
    }
    let response: Response;
    try {
      response = await route();
    } catch (e) {
      if (!(e instanceof Pass)) throw e;
      skipped.push(e.message);
      continue;
    }
    const why = blockedBy(response);
    if (!why) return { response, via, skipped };
    // Kept, not read: the next route may do better, and if none does this is the answer.
    await blocked?.response.body?.cancel();
    blocked = { response, via, at: skipped.length };
    skipped.push(`${via}: ${why}`);
  }
  if (blocked) {
    // Its note describes the very answer being returned, so it was not skipped.
    skipped.splice(blocked.at, 1);
    return { response: blocked.response, via: blocked.via, skipped };
  }
  throw new Error(`No route could fetch ${url}: ${skipped.join("; ")}`);
};
