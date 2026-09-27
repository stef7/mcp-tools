/**
 * Getting a URL off the open web past whatever blocks a Cloudflare IP, in this order:
 *
 *   unblocker  Apify Proxy's Unblocker, through core/proxy.ts: it deals with bot checks and
 *              CAPTCHAs itself and picks the country. Billed per successful request.
 *   tunnel     only with `tunnel: true`. The Mac behind Cloudflare Tunnel, via
 *              scripts/tunnel-relay.mjs: a home connection in Australia, for when the unblocker
 *              has no quota left.
 *   direct     the worker's own `fetch`, from whichever Cloudflare colo ran it. Always there.
 *
 * Each route either returns the site's answer — a 403 or 404 included, since that is the site
 * speaking, not the route failing — or says why it could not, and the next one is tried. What was
 * passed over comes back in `skipped`, so a caller can see that a page came from Cloudflare only
 * because the unblocker was out of credit.
 */

import { ProxyError, proxyFetch, type ProxyFetchOptions } from "./proxy";

export const ROUTES = ["unblocker", "tunnel", "direct"] as const;
export type Route = (typeof ROUTES)[number];

/** The tunnel only when asked for: it depends on the Mac being awake, and on its connection. */
const orderFor = (opts: EgressOptions): readonly Route[] =>
  opts.via ? [opts.via] : ROUTES.filter((r) => r !== "tunnel" || opts.tunnel);

/** Just the part of a VPC Service binding this uses, so a test can pass a plain object. */
type Fetcher = { fetch(input: string, init?: RequestInit): Promise<Response> };

export type EgressEnv = { TUNNEL?: Fetcher; APIFY_PROXY_PASSWORD?: string };

export type EgressOptions = {
  headers?: Record<string, string>;
  /** One route and no fallback. Omit for the cascade. */
  via?: Route;
  /**
   * Try the tunnel between the unblocker and a plain fetch: for when the unblocker is out of
   * quota and a home connection might still get through. Off unless asked for.
   */
  tunnel?: boolean;
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
 * How long a tunnel that did not answer is left alone. Without it every fetch while the Mac is
 * asleep would wait out the full timeout before moving on. Per isolate, so it is a hint that
 * costs one slow request per isolate, not a shared switch.
 */
const DOWN_FOR_MS = 60_000;
const TUNNEL_TIMEOUT_MS = 8_000;
let tunnelDownUntil = 0;

/** For tests, which would otherwise inherit one another's outage. */
export const resetTunnel = () => {
  tunnelDownUntil = 0;
};

const viaTunnel = async (tunnel: Fetcher, url: string, headers: Record<string, string>) => {
  if (Date.now() < tunnelDownUntil) throw new Pass("tunnel: down in the last minute");
  let res: Response;
  try {
    // The VPC Service fixes host and port (localhost:8811 on the Mac); only the path matters.
    res = await tunnel.fetch(`http://relay/fetch?url=${encodeURIComponent(url)}`, {
      headers,
      signal: AbortSignal.timeout(TUNNEL_TIMEOUT_MS),
    });
  } catch (e) {
    tunnelDownUntil = Date.now() + DOWN_FOR_MS;
    throw new Pass(`tunnel: ${e instanceof Error ? e.message : String(e)}`);
  }
  // The relay marks everything it says itself. An unmarked 5xx is cloudflared finding nothing
  // listening on the port: the Mac is up, the relay is not.
  const relayError = res.headers.get("x-relay-error");
  if (relayError) throw new Pass(`tunnel: ${relayError}`);
  if (!res.headers.has("x-relay-status") && res.status >= 500) {
    tunnelDownUntil = Date.now() + DOWN_FOR_MS;
    throw new Pass(`tunnel: relay not answering (HTTP ${res.status})`);
  }
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
    unblocker: env.APIFY_PROXY_PASSWORD
      ? () => viaUnblocker(env.APIFY_PROXY_PASSWORD!, url, opts)
      : "unblocker: no APIFY_PROXY_PASSWORD",
    direct: () => get(url, { headers }),
  };
  const skipped: string[] = [];
  for (const via of orderFor(opts)) {
    const route = routes[via];
    if (typeof route === "string") {
      skipped.push(route);
      continue;
    }
    try {
      return { response: await route(), via, skipped };
    } catch (e) {
      if (!(e instanceof Pass)) throw e;
      skipped.push(e.message);
    }
  }
  throw new Error(`No route could fetch ${url}: ${skipped.join("; ")}`);
};
