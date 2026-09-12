/**
 * The tools themselves, in two flavours.
 *
 *  site mode    (?wp=apil.au)  one pair of tools per post type the site actually has, named after
 *                              it, plus writes when WP_SITES holds a login for that host
 *  generic mode (no ?wp=)      a handful of tools that take a `url` and discover at call time
 *
 * Both are generated from what discovery found, so a site with an Events Calendar or a custom
 * "knowledge" type gets tools for it without anything being listed here by hand.
 */
import { tool, type Ctx, type JSONSchema, type Tools } from "../../../core/mcp";
import { NAMESPACE, TEC_TYPES, tecTools } from "./tec";
import {
  available,
  create,
  credsFor,
  discoverSite,
  findTax,
  findType,
  get,
  listTerms,
  needsLogin,
  usable,
  pluralise,
  remove,
  search,
  siteUrl,
  update,
  type Creds,
  type Login,
  type PostType,
  type Schema,
  type SearchArgs,
  type WriteArgs,
} from "./wp";

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
  status: {
    type: "string",
    description: "publish (default), draft, pending, private, future, any. Needs a login.",
  },
} as const satisfies Record<string, JSONSchema>;

/** The fields every post type accepts. Taxonomy filters are added per type alongside these. */
const WRITE_PROPS = {
  title: { type: "string", description: "The title." },
  content: { type: "string", description: "Body content. Block markup is allowed." },
  excerpt: { type: "string", description: "Short summary." },
  status: {
    type: "string",
    description: "publish, draft (default when creating), pending, private or future.",
  },
  slug: { type: "string", description: "URL slug." },
  date: { type: "string", description: "Publish date, e.g. 2026-09-01T09:00:00." },
  featured_media: { type: "integer", description: "Attachment ID for the featured image." },
} as const satisfies Record<string, JSONSchema>;

const URL_PROP = {
  url: { type: "string", description: "WordPress site base URL, e.g. https://example.com" },
} as const;

/** One `{ tax_name: "..." }` property per taxonomy attached to this post type. */
const taxProps = (type: PostType, s: Schema): Record<string, JSONSchema> =>
  Object.fromEntries(
    type.taxonomies.map((t) => [
      t.replaceAll("-", "_"),
      {
        type: "string",
        description: `Filter by ${s.taxonomies[t]?.name} — use a name, slug, or term ID`,
      },
    ]),
  );

// ─── Site mode ─────────────────────────────────────────────────────────────────────────────────
export const siteTools = (s: Schema, creds: Creds | null): Tools => {
  const tools: Tools = {};
  const host = new URL(s.base).hostname;
  const hasTec = s.namespaces.includes(NAMESPACE);

  for (const type of Object.values(s.postTypes)) {
    const taxonomies = taxProps(type, s);

    tools[`search_${pluralise(type.rest_base)}`] = {
      annotations: RO,
      description:
        `Search ${type.name} (${type.description || type.slug}). ` +
        "Returns titles, dates, URLs, and excerpts.",
      input: { type: "object", properties: { ...SEARCH_PROPS, ...taxonomies } },
      run: (args: SearchArgs) => search(args, type, s, creds),
    };

    tools[`get_${type.rest_base}`] = {
      annotations: RO,
      description: `Get a single ${type.name} by ID. Returns full content.`,
      input: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "integer", description: `The ${type.name} ID` } },
      },
      run: ({ id }: { id: number }) => get(id, type, s, creds),
    };

    // The Events Calendar owns its own types: writing them through wp/v2 would drop event meta.
    if (!creds || (hasTec && TEC_TYPES.includes(type.slug))) continue;

    tools[`create_${type.rest_base}`] = {
      description: `Create ${type.name} on ${host}. Creates a draft unless status says otherwise.`,
      confirm: true,
      input: { type: "object", properties: { ...WRITE_PROPS, ...taxonomies } },
      run: (args: WriteArgs) => create(args, type, s, creds),
    };

    tools[`update_${type.rest_base}`] = {
      description:
        `Update one ${type.name} on ${host}. Send only the fields you are changing; ` +
        "everything else is left alone.",
      confirm: true,
      input: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "integer", description: `The ${type.name} ID` },
          ...WRITE_PROPS,
          ...taxonomies,
        },
      },
      run: ({ id, ...args }: WriteArgs & { id: number }) => update(id, args, type, s, creds),
    };

    tools[`delete_${type.rest_base}`] = {
      description: `Move one ${type.name} to the trash on ${host}.`,
      confirm: true,
      annotations: { destructiveHint: true },
      input: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "integer", description: `The ${type.name} ID` },
          force: {
            type: "boolean",
            description: "Delete permanently instead of trashing. Cannot be undone.",
          },
        },
      },
      run: ({ id, force }: { id: number; force?: boolean }) =>
        remove(id, force === true, type, s, creds),
    };
  }

  const taxNames = Object.keys(s.taxonomies).join(", ");
  tools["list_terms"] = {
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

  return hasTec ? { ...tools, ...tecTools(s, creds) } : tools;
};

// ─── Generic mode ──────────────────────────────────────────────────────────────────────────────
/** Resolve a site and its login in one step, for tools that take a `url` per call. */
const open = async (url: string, c: Ctx) => {
  const base = siteUrl(url);
  const s = await discoverSite(base);
  return { base, s, login: await credsFor(base, c) };
};

/** For the write tools: the login, or the sentence explaining why there isn't one. */
const login = async (base: string, l: Login | null, c: Ctx) =>
  usable(l) ? l : (l?.problem ?? needsLogin(base, await c.email()));

export const genericTools: Tools = {
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
      const tec = s.namespaces.includes(NAMESPACE)
        ? "\nThis site runs The Events Calendar. Point the connector at it with " +
          `?wp=${new URL(base).hostname} to get event, venue and organiser tools.\n`
        : "";
      return (
        `# ${base}\n\n## Content Types\n\n${types.join("\n")}\n\n` +
        `## Taxonomies\n\n${taxes.join("\n")}\n${tec}\n## Usage\n` +
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
    async run({ url, content_type, taxonomy_filters, ...args }, c) {
      const { s, login: l } = await open(url, c);
      const creds = usable(l) ? l : null;
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
      return search({ ...args, ...filters }, type, s, creds);
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
    async run({ url, content_type, id }, c) {
      const { s, login: l } = await open(url, c);
      const creds = usable(l) ? l : null;
      const type = findType(s, content_type);
      const all = available(Object.values(s.postTypes));
      if (!type) return `Unknown content type "${content_type}". Available: ${all}`;
      return get(id, type, s, creds);
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
    async run({ url, taxonomy, ...args }, c) {
      const { s } = await open(url, c);
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

  create_content: tool({
    description:
      "Create a post, page or other item on a WordPress site. Creates a draft by default.",
    confirm: true,
    input: {
      type: "object",
      required: ["url"],
      properties: {
        ...URL_PROP,
        content_type: {
          type: "string",
          description: 'Content type rest_base (e.g. "posts", "pages"). Defaults to "posts".',
        },
        ...WRITE_PROPS,
      },
    },
    async run({ url, content_type, ...args }, c) {
      const { base, s, login: l } = await open(url, c);
      const creds = await login(base, l, c);
      if (typeof creds === "string") return creds;
      const type = findType(s, content_type);
      if (!type) return `Unknown content type "${content_type}".`;
      return create(args, type, s, creds);
    },
  }),

  update_content: tool({
    description:
      "Update one item on a WordPress site. Send only the fields you are changing; " +
      "everything else is left alone.",
    confirm: true,
    input: {
      type: "object",
      required: ["url", "id"],
      properties: {
        ...URL_PROP,
        content_type: {
          type: "string",
          description: 'Content type rest_base (e.g. "posts", "pages"). Defaults to "posts".',
        },
        id: { type: "integer", description: "The item ID" },
        ...WRITE_PROPS,
      },
    },
    async run({ url, content_type, id, ...args }, c) {
      const { base, s, login: l } = await open(url, c);
      const creds = await login(base, l, c);
      if (typeof creds === "string") return creds;
      const type = findType(s, content_type);
      if (!type) return `Unknown content type "${content_type}".`;
      return update(id, args, type, s, creds);
    },
  }),

  delete_content: tool({
    description: "Move one item on a WordPress site to the trash.",
    confirm: true,
    annotations: { destructiveHint: true },
    input: {
      type: "object",
      required: ["url", "id"],
      properties: {
        ...URL_PROP,
        content_type: {
          type: "string",
          description: 'Content type rest_base (e.g. "posts", "pages"). Defaults to "posts".',
        },
        id: { type: "integer", description: "The item ID" },
        force: {
          type: "boolean",
          description: "Delete permanently instead of trashing. Cannot be undone.",
        },
      },
    },
    async run({ url, content_type, id, force }, c) {
      const { base, s, login: l } = await open(url, c);
      const creds = await login(base, l, c);
      if (typeof creds === "string") return creds;
      const type = findType(s, content_type);
      if (!type) return `Unknown content type "${content_type}".`;
      return remove(id, force === true, type, s, creds);
    },
  }),
};
