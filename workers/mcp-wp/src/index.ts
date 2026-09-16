/**
 * mcp-wp — WordPress REST API -> MCP.
 *
 *  POST /?wp=apil.au                   tools generated from that site's post types + taxonomies
 *  POST /?wp=apil.au,crikey.com.au     same, one set per site, names prefixed with the site slug
 *  POST /                              generic explorer: tools take a `url` and discover at runtime
 *
 * Reads are open. Writes appear only for hosts listed in the WP_SITES secret (see secrets.d.ts)
 * and always require the caller to pass user_confirmed. Sites running The Events Calendar also
 * get event, venue and organiser tools — see tec.ts.
 *
 * Optional `?title=&icon=&description=` decorate the connector (single-site mode). `?site=` is
 * accepted as an alias of `?wp=` for old connector URLs.
 */
import cfg from "../wrangler.json";
import pkg from "../package.json";
import { mcpWorker, type Ctx } from "../../../core/mcp";
import { ICONS } from "../../../core/icons";
import { genericTools, siteTools } from "./tools";
import { credsFor, discoverSite, loginReport, siteUrl, slug, usable } from "./wp";

/**
 * Which sites this connector is for: the `X-WP-Site` header first, then `?wp=` (or `?site=`).
 * The header exists so a connector can be configured entirely in Claude, with no URL to edit.
 */
const sitesOf = ({ params, headers }: Ctx) =>
  (headers["x-wp-site"] ?? params.get("wp") ?? params.get("site") ?? "")
    .split(",")
    .filter(Boolean)
    .map(siteUrl);

export default mcpWorker({
  ...cfg,
  version: pkg.version,
  icon: ICONS.wordpress,
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
    if (!sites.length) return "Generic mode. Add ?wp=<hostname> to target a site.";
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
          "secret, and every write asks you to confirm first.",
      };
    const hosts = sites.map((u) => new URL(u).hostname).join(", ");
    const first = new URL(sites[0]!);
    return {
      title: p.get("title") ?? hosts,
      description: p.get("description") ?? sites.join(", "),
      // Ours goes first: a site's own favicon is usually an .ico, which no client must render.
      icons: [ICONS.wordpress, ...(p.get("icon") ? [{ src: p.get("icon")! }] : [])],
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
