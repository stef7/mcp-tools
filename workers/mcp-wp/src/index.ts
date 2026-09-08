/**
 * mcp-wp — WordPress REST API -> MCP.
 *
 *  POST /?wp=apil.au                   tools generated from that site's post types + taxonomies
 *  POST /?wp=apil.au,crikey.com.au     same, one set per site, names prefixed with the site slug
 *  POST /                              generic explorer: tools take a `url` and discover at runtime
 *
 * Optional `?title=&icon=&description=` decorate the connector (single-site mode). `?site=` is
 * accepted as an alias of `?wp=` for old connector URLs.
 */
import cfg from "../wrangler.json";
import pkg from "../package.json";
import { mcpWorker, tool, type Ctx, type JSONSchema, type Tools } from "../../../core/mcp";

// ─── WordPress shapes we rely on ───────────────────────────────────────────────────────────────
type PostType = {
  slug: string;
  name: string;
  rest_base: string;
  description: string;
  taxonomies: string[];
};
type Taxonomy = { slug: string; name: string; rest_base: string; hierarchical: boolean };
type Schema = {
  postTypes: Record<string, PostType>;
  taxonomies: Record<string, Taxonomy>;
  apiBase: string;
};
type Term = { id: number; name: string; slug: string; count: number };
type Rendered = { rendered?: string };
type Item = {
  id: number;
  date?: string;
  link?: string;
  class_list?: string[];
  title?: Rendered;
  excerpt?: Rendered;
  content?: Rendered;
};
type SearchArgs = {
  query?: string;
  after?: string;
  before?: string;
  per_page?: number;
  page?: number;
  orderby?: string;
  [taxonomy: string]: string | number | undefined;
};

// ─── Text helpers ──────────────────────────────────────────────────────────────────────────────
const stripHtml = (html = "") =>
  html
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;/g, "’")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#?\w+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/gm, "")
    .trim();
const truncate = (s: string, max = 800) =>
  s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "") + "…";
const pluralise = (w: string) =>
  w.endsWith("s") ? w : w.endsWith("y") && !/[aeiou]y$/i.test(w) ? w.slice(0, -1) + "ies" : w + "s";
const formatDate = (s = "") =>
  s
    ? new Date(s).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })
    : "";
const normaliseDate = (s: string) => {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.includes("T") ? s : s + "T00:00:00";
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString();
};
const siteUrl = (raw: string) => {
  const url = raw.trim().startsWith("http") ? raw.trim() : `https://${raw.trim()}`;
  try {
    new URL(url);
  } catch {
    throw new Error(
      `Invalid URL: "${raw}". Provide a WordPress base URL, e.g. https://example.com`,
    );
  }
  return url.replace(/\/+$/, "");
};
/** "https://www.un.org/unispal" -> "un_org_unispal": prefix for multi-site tool names. */
const slug = (url: string) =>
  (new URL(url).host.replace(/^www\./, "") + new URL(url).pathname)
    .replace(/\W+/g, "_")
    .replace(/^_|_$/g, "");
const termLabels = ({ class_list = [] }: Item) => {
  const skip = /^(post-|type-|status-|hentry)/;
  const labels = class_list
    .filter((c) => !skip.test(c))
    .map((c) => c.replaceAll("-", " "))
    .join(", ");
  return labels ? `Tags: ${labels}` : "";
};

// ─── In-memory cache (6 h) ─────────────────────────────────────────────────────────────────────
const cache = new Map<string, { at: number; data: unknown }>();
const memo = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.data as T;
  const data = await load();
  cache.set(key, { at: Date.now(), data });
  return data;
};

// ─── Discovery ─────────────────────────────────────────────────────────────────────────────────
const EXCLUDED = new Set([
  "attachment",
  "nav_menu_item",
  "wp_block",
  "wp_template",
  "wp_template_part",
  "wp_navigation",
  "wp_font_family",
  "wp_font_face",
  "wp_global_styles",
  "wp_pattern",
]);
type RawType = {
  name: string;
  rest_base?: string;
  rest_namespace?: string;
  description?: string;
  taxonomies?: string[];
};
type RawTax = { name: string; rest_base?: string; hierarchical?: boolean };

const discoverSite = (base: string) =>
  memo<Schema>(`schema:${base}`, async () => {
    const apiBase = `${base}/wp-json/wp/v2`;
    const [typesRes, taxRes] = await Promise.all([
      fetch(`${apiBase}/types`),
      fetch(`${apiBase}/taxonomies`),
    ]);
    if (!typesRes.ok) throw new Error(`Failed to fetch types from ${base}: ${typesRes.status}`);
    if (!taxRes.ok) throw new Error(`Failed to fetch taxonomies from ${base}: ${taxRes.status}`);
    const types: Record<string, RawType> = await typesRes.json();
    const taxes: Record<string, RawTax> = await taxRes.json();
    const postTypes: Schema["postTypes"] = {};
    for (const [slug, t] of Object.entries(types)) {
      if (EXCLUDED.has(slug) || !t.rest_base || !t.rest_namespace?.startsWith("wp/v2")) continue;
      postTypes[slug] = {
        slug,
        name: t.name,
        rest_base: t.rest_base,
        description: t.description ?? "",
        taxonomies: (t.taxonomies ?? []).filter((x) => taxes[x]),
      };
    }
    const taxonomies = Object.fromEntries(
      Object.entries(taxes).map(([slug, t]) => [
        slug,
        {
          slug,
          name: t.name,
          rest_base: t.rest_base ?? slug,
          hierarchical: t.hierarchical ?? false,
        },
      ]),
    );
    return { postTypes, taxonomies, apiBase };
  });

const getTerms = (apiBase: string, tax: Taxonomy) =>
  memo<Term[]>(`terms:${apiBase}:${tax.rest_base}`, async () => {
    const res = await fetch(
      `${apiBase}/${tax.rest_base}?per_page=100&orderby=count&order=desc`,
    ).catch(() => null);
    if (!res?.ok) return [];
    const terms: Term[] = await res.json();
    return terms.map(({ id, name, slug, count }) => ({ id, name, slug, count }));
  });

const resolveTerm = async (apiBase: string, tax: Taxonomy, query: string | number) => {
  if (!isNaN(Number(query))) return Number(query);
  const q = String(query).toLowerCase().trim();
  const terms = await getTerms(apiBase, tax);
  const hit =
    terms.find((t) => t.name.toLowerCase() === q || t.slug === q) ??
    terms.find((t) => t.name.toLowerCase().includes(q));
  if (hit) return hit.id;
  const res = await fetch(
    `${apiBase}/${tax.rest_base}?search=${encodeURIComponent(q)}&per_page=1`,
  ).catch(() => null);
  const found: Term[] = res?.ok ? await res.json() : [];
  return found[0]?.id ?? null;
};

// ─── The three operations every site tool boils down to ────────────────────────────────────────
const search = async (args: SearchArgs, type: PostType, s: Schema) => {
  const p = new URLSearchParams({
    order: "desc",
    per_page: String(Math.min(Math.max(args.per_page ?? 10, 1), 100)),
    page: String(Math.max(args.page ?? 1, 1)),
    orderby: args.orderby ?? (args.query ? "relevance" : "date"),
  });
  if (args.query) p.set("search", args.query);
  if (args.after) p.set("after", normaliseDate(args.after));
  if (args.before) p.set("before", normaliseDate(args.before));
  for (const taxSlug of type.taxonomies) {
    const wanted = args[taxSlug.replaceAll("-", "_")];
    const tax = s.taxonomies[taxSlug];
    if (!wanted || !tax) continue;
    const id = await resolveTerm(s.apiBase, tax, wanted);
    if (!id)
      return (
        `Could not resolve "${wanted}" to a term in ${tax.name}. ` +
        "Use list_terms to browse available terms."
      );
    p.set(tax.rest_base, String(id));
  }
  const res = await fetch(`${s.apiBase}/${type.rest_base}?${p}`);
  if (!res.ok)
    return `WordPress API error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
  const items: Item[] = await res.json();
  const total = res.headers.get("X-WP-Total") ?? "?";
  const pages = res.headers.get("X-WP-TotalPages") ?? "?";
  const page = args.page ?? 1;
  if (!items.length) return `No ${type.name} found matching your criteria.`;
  let out = `Found ${total} ${type.name} (page ${page}/${pages}):\n\n`;
  items.forEach((item, i) => {
    const n = (page - 1) * (args.per_page ?? 10) + i + 1;
    out += `${n}. ${stripHtml(item.title?.rendered || "Untitled")}\n`;
    out += `   ID: ${item.id} | Date: ${formatDate(item.date)}\n`;
    if (item.link) out += `   URL: ${item.link}\n`;
    if (termLabels(item)) out += `   ${termLabels(item)}\n`;
    const excerpt = truncate(stripHtml(item.excerpt?.rendered || item.content?.rendered), 400);
    if (excerpt) out += `   ${excerpt}\n`;
    out += "\n";
  });
  if (Number(pages) > page) out += `→ More results available. Use page: ${page + 1} to continue.`;
  return out;
};

const get = async (id: number, type: PostType, s: Schema) => {
  if (!id) throw new Error("Missing required parameter: id");
  const res = await fetch(`${s.apiBase}/${type.rest_base}/${id}`);
  if (res.status === 404) return `${type.name} with ID ${id} not found.`;
  if (!res.ok) return `WordPress API error ${res.status}`;
  const item: Item = await res.json();
  let out = `# ${stripHtml(item.title?.rendered || "Untitled")}\n`;
  out += `Date: ${formatDate(item.date)} | ID: ${item.id}\n`;
  if (item.link) out += `URL: ${item.link}\n`;
  if (termLabels(item)) out += `${termLabels(item)}\n`;
  out += `\n---\n\n${stripHtml(item.content?.rendered)}`;
  if (out.length > 100_000) {
    out =
      out.slice(0, 100_000) +
      "\n\n[Content truncated to 100,000 chars — full document at URL above]";
  }
  return out;
};

const listTerms = async (
  tax: Taxonomy,
  s: Schema,
  args: { search?: string; per_page?: number },
) => {
  const p = new URLSearchParams({
    per_page: String(Math.min(args.per_page ?? 50, 100)),
    orderby: "count",
    order: "desc",
  });
  if (args.search) p.set("search", args.search);
  const res = await fetch(`${s.apiBase}/${tax.rest_base}?${p}`);
  if (!res.ok) return `WordPress API error ${res.status}`;
  const terms: Term[] = await res.json();
  if (!terms.length)
    return `No terms found in ${tax.name}${args.search ? ` matching "${args.search}"` : ""}.`;
  const lines = terms.map((t) => `• ${t.name} (slug: ${t.slug}, id: ${t.id}, count: ${t.count})`);
  const total = res.headers.get("X-WP-Total") ?? "?";
  return `${tax.name} — ${total} total terms (showing ${terms.length}):\n\n${lines.join("\n")}\n`;
};

/** Find a post type / taxonomy by rest_base (or slug), else a message listing what exists. */
const findType = (s: Schema, restBase = "posts") =>
  Object.values(s.postTypes).find((t) => t.rest_base === restBase);
const findTax = (s: Schema, key: string) =>
  Object.values(s.taxonomies).find((t) => t.rest_base === key || t.slug === key);
const available = (xs: { rest_base: string }[]) => xs.map((x) => x.rest_base).join(", ");

// ─── Site mode: one tool set generated from what the site actually has ─────────────────────────
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const SEARCH_PROPS = {
  query: { type: "string", description: "Full-text search query" },
  after: { type: "string", description: "Only items published after this date (e.g. 2025-10-01)" },
  before: {
    type: "string",
    description: "Only items published before this date (e.g. 2026-01-01)",
  },
  per_page: { type: "integer", description: "Results per page (1-100, default 10)" },
  page: { type: "integer", description: "Page number (default 1)" },
  orderby: {
    type: "string",
    description: "Sort by: date, relevance, title, modified",
    enum: ["date", "relevance", "title", "modified"],
  },
} as const satisfies Record<string, JSONSchema>;

const siteTools = (s: Schema): Tools => {
  const tools: Tools = {};
  for (const type of Object.values(s.postTypes)) {
    const taxProps = Object.fromEntries(
      type.taxonomies.map((t): [string, JSONSchema] => [
        t.replaceAll("-", "_"),
        {
          type: "string",
          description: `Filter by ${s.taxonomies[t]?.name} — use a name, slug, or term ID`,
        },
      ]),
    );
    tools[`search_${pluralise(type.rest_base)}`] = {
      annotations: RO,
      description:
        `Search ${type.name} (${type.description || type.slug}). ` +
        "Returns titles, dates, URLs, and excerpts.",
      input: { type: "object", properties: { ...SEARCH_PROPS, ...taxProps } },
      run: (args: SearchArgs) => search(args, type, s),
    };
    tools[`get_${type.rest_base}`] = {
      annotations: RO,
      description: `Get a single ${type.name} by ID. Returns full content.`,
      input: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "integer", description: `The ${type.name} ID` } },
      },
      run: ({ id }: { id: number }) => get(id, type, s),
    };
  }
  const taxNames = Object.keys(s.taxonomies).join(", ");
  tools.list_terms = {
    annotations: RO,
    description: `List terms in a taxonomy. Available: ${taxNames}`,
    input: {
      type: "object",
      required: ["taxonomy"],
      properties: {
        taxonomy: { type: "string", description: `Taxonomy slug — one of: ${taxNames}` },
        search: { type: "string", description: "Optional search query to filter terms" },
        per_page: { type: "integer", description: "Results per page (1-100, default 50)" },
      },
    },
    run: ({ taxonomy, ...args }: { taxonomy: string; search?: string; per_page?: number }) => {
      const tax = s.taxonomies[taxonomy];
      return tax
        ? listTerms(tax, s, args)
        : `Unknown taxonomy: "${taxonomy}". Available: ${taxNames}`;
    },
  };
  return tools;
};

// ─── Generic mode: tools take a `url` and discover on the fly ──────────────────────────────────
const URL_PROP = {
  url: { type: "string", description: "WordPress site base URL, e.g. https://example.com" },
} as const;
const genericTools: Tools = {
  discover_site: tool({
    annotations: RO,
    description:
      "Probe a WordPress site and return its available content types, taxonomies, and term " +
      "counts. Call this first to learn what a site has before searching.",
    input: { type: "object", required: ["url"], additionalProperties: false, properties: URL_PROP },
    async run({ url }) {
      const base = siteUrl(url);
      const s = await discoverSite(base);
      const types = Object.values(s.postTypes).map(
        (t) =>
          `• **${t.name}** (rest_base: \`${t.rest_base}\`)` +
          (t.description ? ` — ${t.description}` : "") +
          (t.taxonomies.length ? `\n  Taxonomies: ${t.taxonomies.join(", ")}` : ""),
      );
      const taxes = Object.values(s.taxonomies).map(
        (t) =>
          `• **${t.name}** (rest_base: \`${t.rest_base}\`, ` +
          `${t.hierarchical ? "hierarchical" : "flat"})`,
      );
      return (
        `# ${base}\n\n## Content Types\n\n${types.join("\n")}\n\n` +
        `## Taxonomies\n\n${taxes.join("\n")}\n\n## Usage\n` +
        `Use search_content with url="${base}" and content_type set to a rest_base above.\n` +
        `Use taxonomy_filters with rest_base slugs as keys, e.g. {"categories": "news"}.\n` +
        `Use list_site_terms to browse available terms in any taxonomy.\n`
      );
    },
  }),
  search_content: tool({
    annotations: RO,
    description:
      "Search a WordPress site for content. Use discover_site first to find available content " +
      "types and taxonomy filters. Defaults to searching posts.",
    input: {
      type: "object",
      required: ["url"],
      additionalProperties: false,
      properties: {
        ...URL_PROP,
        ...SEARCH_PROPS,
        content_type: {
          type: "string",
          description:
            'Content type rest_base from discover_site (e.g. "posts", ' +
            '"pages", "documents"). Defaults to "posts".',
        },
        taxonomy_filters: {
          type: "object",
          description:
            "Filter by taxonomy terms. Keys are taxonomy rest_base slugs (from discover_site), " +
            'values are term names, slugs, or IDs. E.g. {"categories": "news", "tags": "gaza"}',
        },
      },
    },
    async run({ url, content_type, taxonomy_filters, ...args }) {
      const s = await discoverSite(siteUrl(url));
      const type = findType(s, content_type);
      if (!type)
        return (
          `Unknown content type "${content_type}". Available on this site: ` +
          `${available(Object.values(s.postTypes))}. Use discover_site to see details.`
        );
      const filters: SearchArgs = {};
      for (const [key, term] of Object.entries(taxonomy_filters ?? {})) {
        const tax = findTax(s, key);
        if (!tax)
          return (
            `Unknown taxonomy "${key}". Available: ${available(Object.values(s.taxonomies))}. ` +
            "Use discover_site or list_site_terms."
          );
        filters[tax.slug.replaceAll("-", "_")] = String(term);
      }
      return search({ ...args, ...filters }, type, s);
    },
  }),
  get_content: tool({
    annotations: RO,
    description:
      "Get a single item from a WordPress site by ID. Returns full content. " +
      "Use search_content first to find IDs.",
    input: {
      type: "object",
      required: ["url", "id"],
      additionalProperties: false,
      properties: {
        ...URL_PROP,
        content_type: {
          type: "string",
          description: 'Content type rest_base (e.g. "posts", "pages"). Defaults to "posts".',
        },
        id: { type: "integer", description: "The item ID" },
      },
    },
    async run({ url, content_type, id }) {
      const s = await discoverSite(siteUrl(url));
      const type = findType(s, content_type);
      const all = available(Object.values(s.postTypes));
      if (!type) return `Unknown content type "${content_type}". Available: ${all}`;
      return get(id, type, s);
    },
  }),
  list_site_terms: tool({
    annotations: RO,
    description:
      "List terms in a taxonomy on a WordPress site. " +
      "Use discover_site first to find available taxonomies.",
    input: {
      type: "object",
      required: ["url", "taxonomy"],
      additionalProperties: false,
      properties: {
        ...URL_PROP,
        taxonomy: {
          type: "string",
          description: 'Taxonomy rest_base slug (from discover_site, e.g. "categories", "tags")',
        },
        search: { type: "string", description: "Optional search query to filter terms" },
        per_page: { type: "integer", description: "Results per page (1-100, default 50)" },
      },
    },
    async run({ url, taxonomy, ...args }) {
      const s = await discoverSite(siteUrl(url));
      const tax = findTax(s, taxonomy);
      if (!tax)
        return (
          `Unknown taxonomy "${taxonomy}". Available: ` +
          Object.values(s.taxonomies)
            .map((t) => `${t.slug} (rest_base: ${t.rest_base})`)
            .join(", ")
        );
      return listTerms(tax, s, args);
    },
  }),
};

// ─── Worker ────────────────────────────────────────────────────────────────────────────────────
const sitesOf = ({ params }: Ctx) =>
  (params.get("wp") ?? params.get("site") ?? "").split(",").filter(Boolean).map(siteUrl);

export default mcpWorker({
  ...cfg,
  version: pkg.version,
  async tools(c) {
    const sites = sitesOf(c);
    if (!sites.length) return genericTools;
    const sets = await Promise.all(sites.map(async (u) => siteTools(await discoverSite(u))));
    if (sites.length === 1) return sets[0]!;
    return Object.fromEntries(
      sets.flatMap((t, i) => Object.entries(t).map(([k, v]) => [`${slug(sites[i]!)}_${k}`, v])),
    );
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
        icons: [{ src: "https://s.w.org/style/images/about/WordPress-logotype-wmark.png" }],
        instructions:
          "WordPress Explorer: query any WordPress site. Start with discover_site(url) to probe " +
          "a site, then use search_content, get_content, and list_site_terms. The REST API often " +
          "returns full content even on paywalled sites.",
      };
    const hosts = sites.map((u) => new URL(u).hostname).join(", ");
    const first = new URL(sites[0]!);
    return {
      title: p.get("title") ?? hosts,
      description: p.get("description") ?? sites.join(", "),
      icons: [{ src: p.get("icon") ?? `${first.origin}/favicon.ico` }],
      websiteUrl: sites[0]!,
      instructions:
        `Read-only access to ${hosts} via WordPress REST API. Use search and get tools to find ` +
        "content. Use list_terms to discover taxonomy filters.",
    };
  },
});
