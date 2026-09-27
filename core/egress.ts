/**
 * Getting a URL off the open web from an Australian address, cheapest route first.
 *
 *   tunnel   the Mac behind Cloudflare Tunnel, via scripts/tunnel-relay.mjs: a home connection,
 *            free, and the best disguise there is. Used whenever it answers.
 *   proxy    apify/rag-web-browser on Apify's AU residential proxies. Costs money per page and
 *            only returns HTML, so it is skipped for anything that looks like a document.
 *   direct   the worker's own `fetch`, from whichever Cloudflare colo ran it. Always there.
 *
 * Each route either returns the site's answer — a 403 or 404 included, since that is the site
 * speaking, not the route failing — or says why it could not, and the next one is tried. What was
 * passed over comes back in `skipped`, so a caller can see that a page came from Cloudflare only
 * because the proxy was out of credit.
 */

export const ROUTES = ["tunnel", "proxy", "direct"] as const;
export type Route = (typeof ROUTES)[number];

/** Just the part of a VPC Service binding this uses, so a test can pass a plain object. */
type Fetcher = { fetch(input: string, init?: RequestInit): Promise<Response> };

export type EgressEnv = { TUNNEL?: Fetcher; APIFY_TOKEN?: string };

export type EgressOptions = {
  headers?: Record<string, string>;
  /** One route and no fallback. Omit for the cascade. */
  via?: Route;
  /** The direct route's fetch; tests replace it. */
  fetch?: typeof fetch;
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

// ─── proxy ────────────────────────────────────────────────────────────────────────────────────
const APIFY_RUN =
  "https://api.apify.com/v2/acts/apify~rag-web-browser/run-sync-get-dataset-items" +
  "?timeout=60&memory=1024";

/** rag-web-browser returns a page's HTML and nothing else, so a PDF is not worth paying for. */
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|zip|csv|json|xml|rss|png|jpe?g|gif|webp|mp[34])$/i;

type ApifyItem = {
  crawl?: { httpStatusCode?: number };
  metadata?: { headers?: Record<string, string> };
  html?: string;
};

const viaProxy = async (token: string, url: string, get: typeof fetch) => {
  if (DOCUMENT.test(new URL(url).pathname)) throw new Pass("proxy: not an HTML page");
  const res = await get(APIFY_RUN, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: url,
      outputFormats: ["html"],
      scrapingTool: "raw-http",
      // The page as served: the Actor's default strips nav, footers and scripts for an LLM.
      removeElementsCssSelector: "",
      htmlTransformer: "none",
      removeCookieWarnings: false,
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ["RESIDENTIAL"],
        apifyProxyCountry: "AU",
      },
    }),
  }).catch((e: unknown) => {
    throw new Pass(`proxy: ${e instanceof Error ? e.message : String(e)}`);
  });
  // 402 is Apify's "over your usage limit or out of credit".
  if (res.status === 402) throw new Pass("proxy: no quota left (HTTP 402)");
  if (!res.ok) throw new Pass(`proxy: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const [item] = (await res.json()) as ApifyItem[];
  // A page the Actor could not load is left out of the dataset rather than reported.
  if (!item?.html) throw new Pass("proxy: the Actor returned no page");
  return new Response(item.html, {
    status: item.crawl?.httpStatusCode ?? 200,
    headers: { "content-type": item.metadata?.headers?.["content-type"] ?? "text/html" },
  });
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
    proxy: env.APIFY_TOKEN ? () => viaProxy(env.APIFY_TOKEN!, url, get) : "proxy: no APIFY_TOKEN",
    direct: () => get(url, { headers }),
  };
  const skipped: string[] = [];
  for (const via of opts.via ? [opts.via] : ROUTES) {
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
