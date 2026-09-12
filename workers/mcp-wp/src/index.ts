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
import { genericTools, siteTools } from "./tools";
import { credsFor, discoverSite, loginReport, siteUrl, slug, usable } from "./wp";

/**
 * Served inline rather than linked. The protocol asks that icon URLs come from the same domain as
 * the server and that clients need only support png, jpeg, svg and webp — a site's own favicon.ico
 * fails both tests. A data: URI is explicitly allowed and sidesteps them.
 */
const ICON = {
  src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzIxNzU5YiIvPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik00IDhoMi4zbDEuNiA2LjRMOS42IDhoMS44bDEuNyA2LjRMMTQuNyA4SDE3bC0yLjggOWgtMmwtMS43LTYuMkw4LjggMTdoLTJ6Ii8+PC9zdmc+",
  mimeType: "image/svg+xml",
  sizes: ["any"],
};

const sitesOf = ({ params }: Ctx) =>
  (params.get("wp") ?? params.get("site") ?? "").split(",").filter(Boolean).map(siteUrl);

export default mcpWorker({
  ...cfg,
  version: pkg.version,
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
        icons: [ICON],
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
      // A site may name its own, but ours goes first: it is same-domain and a supported type.
      icons: [ICON, ...(p.get("icon") ? [{ src: p.get("icon")! }] : [])],
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
