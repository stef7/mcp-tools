/**
 * mcp-wp — WordPress REST API -> MCP.
 *
 *  POST /?wp=apil.au                   tools generated from that site's post types + taxonomies
 *  POST /https://apil.au               the same, with the site in the path (see sitesInPath)
 *  POST /?wp=apil.au,crikey.com.au     same, one set per site, names prefixed with the site slug
 *  POST /                              generic explorer: tools take a `url` and discover at runtime
 *
 * Reads are open. Writes appear only for hosts listed in the WP_SITES secret (see secrets.d.ts)
 * and always require the caller to pass user_confirmed. Sites running The Events Calendar also
 * get event, venue and organiser tools — see tec.ts — and sites running WooCommerce get product,
 * order, customer and coupon tools once there is a login, since WooCommerce reads need one too —
 * see woo.ts.
 *
 * Optional `?title=&description=` decorate the connector (single-site mode). `?site=` is
 * accepted as an alias of `?wp=` for old connector URLs.
 */
import cfg from "../wrangler.json";
import { version } from "../package.json";
import { mcpWorker } from "../../../core/mcp";
import { genericTools, siteTools } from "./tools";
import { credsFor, discoverSite, loginReport, sitesOf, slug, usable } from "./wp";

const Worker = mcpWorker({
  ...cfg,
  version,
  confirmNote: "Changes the site.",
  async tools(c) {
    const sites = sitesOf(c);
    if (!sites.length) return genericTools;
    const sets = await Promise.all(
      sites.map(async (base) => {
        const login = await credsFor(base, c);
        return siteTools(await discoverSite(base), usable(login) ? login : null);
      }),
    );
    if (sites.length === 1) return sets[0]!;
    return Object.fromEntries(
      sets.flatMap((t, i) => Object.entries(t).map(([k, v]) => [`${slug(sites[i]!)}_${k}`, v])),
    );
  },
  /** Opening the URL in a browser says, per site, whether it is editable and what is missing. */
  async status(c) {
    const sites = sitesOf(c);
    if (!sites.length)
      return "Generic mode. Add ?wp=<hostname>, or /https://<hostname>, to target a site.";
    const reports = await Promise.all(sites.map((base) => loginReport(base, c)));
    return reports.map((r) => r.split("\n"));
  },
  info(c) {
    const sites = sitesOf(c);
    const p = c.params;
    if (!sites.length)
      return {
        title: "WordPress Explorer",
        description:
          "Query any WordPress site's REST API. Use discover_site to probe a site, then " +
          "search_content, get_content, and list_site_terms to retrieve content.",
        instructions:
          "WordPress Explorer: query any WordPress site. Start with discover_site(url) to probe " +
          "a site, then use search_content, get_content, and list_site_terms. The REST API often " +
          "returns full content even on paywalled sites. Editing needs a login in the WP_SITES " +
          "secret, and every write asks you to confirm first. WooCommerce shops have *_wc tools, " +
          "which need a login even to read.",
      };
    const hosts = sites.map((u) => new URL(u).hostname).join(", ");
    const first = new URL(sites[0]!);
    return {
      title: p.get("title") ?? hosts,
      description: p.get("description") ?? sites.join(", "),
      websiteUrl: sites[0]!,
      instructions:
        `Access to ${hosts} via the WordPress REST API. Use search and get tools to find ` +
        "content, and list_terms to discover taxonomy filters. Read the item you are about to " +
        "change before changing it, send only the fields that differ, and never guess an ID. " +
        "Tools whose names start with create_, update_ or delete_ alter the live site and will " +
        "not run until you pass user_confirmed: true.",
    };
  },
});

/**
 * The site named in the path — `/https://happilymade.com.au` — as a `?wp=` value, or null when
 * the path names none. Only a path that starts with a scheme counts, so `/` and stray requests
 * such as `/favicon.ico` stay in generic mode. Some clients and proxies merge `//` into `/`, and
 * some percent-encode the colon, so `/https:/host` and `/https%3A%2F%2Fhost` count too. Commas
 * separate several sites, as they do in `?wp=`.
 */
export const sitesInPath = (url: URL): string | null => {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null; // a malformed escape is not a site
  }
  if (!/^\/https?:/i.test(path)) return null;
  return path
    .slice(1)
    .split(",")
    .map((s) => s.replace(/^(https?):\/*/i, (_, scheme: string) => `${scheme.toLowerCase()}://`))
    .join(",");
};

/**
 * Moves a site named in the path into `?wp=` before anything else reads the request, so the
 * tools, the GET page and the X-Auth-Token rules behave exactly as they do for `?wp=`. The path
 * wins over any `?wp=` or `?site=` alongside it: one connector URL, one answer to which site.
 */
export default class extends Worker {
  override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sites = sitesInPath(url);
    if (!sites) return super.fetch(request);
    url.pathname = "/";
    url.searchParams.delete("site");
    url.searchParams.set("wp", sites);
    return super.fetch(new Request(url, request));
  }
}
