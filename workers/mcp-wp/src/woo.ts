/**
 * WooCommerce, through its own REST namespace. Products are a post type, so wp/v2 can read them,
 * but price, stock, SKU and variations live in WooCommerce's own data stores — writing a product
 * through wp/v2 drops all of it, and orders, customers and coupons are not in wp/v2 at all. So
 * when a site exposes `wc/v3` these tools appear, and the plain wp/v2 write tools step aside for
 * WooCommerce's types, the same bargain tec.ts strikes with The Events Calendar.
 *
 * No field is listed here by hand. WordPress describes every route's arguments in the namespace
 * index (GET /wp-json/wc/v3), so each tool's schema is whatever this site's WooCommerce says it
 * takes, and an extension that adds a product field adds it to these tools too.
 *
 * Unlike wp/v2, WooCommerce serves nothing anonymously: every wc/v3 route checks capabilities,
 * reads included. So these tools exist only for sites with a login — an Application Password for
 * a Shop Manager or Administrator, or a WooCommerce REST key pair (`ck_…:cs_…`), which WooCommerce
 * accepts as HTTP Basic auth over HTTPS.
 *
 * Verified against WooCommerce trunk (includes/rest-api/Controllers/Version3) and
 * WP_REST_Server::get_data_for_route, which is what puts the arguments in the index.
 */
import type { Ctx, JSONSchema, Tools } from "../../../core/mcp";
import { stripHtml, truncate } from "../../../core/web";
import {
  api,
  apiError,
  credsFor,
  discoverSite,
  memo,
  needsLogin,
  siteUrl,
  usable,
  type Creds,
  type Schema,
} from "./wp";

export const NAMESPACE = "wc/v3";
/** Post types WooCommerce owns. wp/v2 writes for these would silently drop the product data. */
export const WC_TYPES = ["product", "product_variation", "shop_order", "shop_coupon"];

/**
 * The resources that get tools of their own. Everything else wc/v3 offers — reports, settings,
 * shipping zones, system status — is reachable read-only through `get_wc_endpoint`. A `{name}` in
 * a path is an ID the tool asks for; `{id}` is added for the single-item route.
 */
const RESOURCES = {
  products: { path: "products", label: "product" },
  product_variations: { path: "products/{product_id}/variations", label: "product variation" },
  product_categories: { path: "products/categories", label: "product category" },
  product_tags: { path: "products/tags", label: "product tag" },
  product_reviews: { path: "products/reviews", label: "product review" },
  orders: { path: "orders", label: "order" },
  order_notes: { path: "orders/{order_id}/notes", label: "order note" },
  order_refunds: { path: "orders/{order_id}/refunds", label: "refund" },
  customers: { path: "customers", label: "customer" },
  coupons: { path: "coupons", label: "coupon" },
} as const;
type Key = keyof typeof RESOURCES;
type Resource = (typeof RESOURCES)[Key];
const KEYS = Object.keys(RESOURCES) as Key[];

type Args = Record<string, unknown>;

// ─── Discovery ─────────────────────────────────────────────────────────────────────────────────
/** One argument as the index describes it. WordPress marks each one `required` on its own. */
type RawArg = Args & { required?: boolean };
type Method = "GET" | "POST" | "DELETE";
/** Per path ("orders/{order_id}/notes"), the arguments each method takes. */
export type WcIndex = Record<string, Partial<Record<Method, Record<string, RawArg>>>>;

/** "/wc/v3/orders/(?P<order_id>[\d]+)/notes" -> "orders/{order_id}/notes". */
const normalise = (route: string) =>
  route
    .replace(/^\/wc\/v3\/?/, "")
    .replace(/\(\?P<(\w+)>[^)]*\)/g, "{$1}")
    .replace(/\/+$/, "");

/** Every wc/v3 route and what each of its methods accepts, from the site's own index. */
export const wcIndex = (base: string, creds: Creds | null) =>
  memo<WcIndex>(`wc:${base}`, async () => {
    const url = `${base}/wp-json/${NAMESPACE}`;
    const { res, body, text } = await api(url, creds);
    if (!res.ok) throw new Error(apiError(url, res, body, text));
    const routes = ((body ?? {}) as { routes?: Record<string, { endpoints?: unknown[] }> }).routes;
    const index: WcIndex = {};
    for (const [route, data] of Object.entries(routes ?? {})) {
      const methods: WcIndex[string] = {};
      for (const e of (data.endpoints ?? []) as { methods?: string[]; args?: RawArg }[]) {
        // POST, PUT and PATCH share one handler, so the first one listed speaks for all three.
        const m = (e.methods ?? []).map((x) => (x === "PUT" || x === "PATCH" ? "POST" : x));
        for (const x of m)
          if ((x === "GET" || x === "POST" || x === "DELETE") && !methods[x])
            methods[x] = (e.args ?? {}) as Record<string, RawArg>;
      }
      index[normalise(route)] = methods;
    }
    return index;
  });

// ─── Schemas ───────────────────────────────────────────────────────────────────────────────────
const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

/**
 * WooCommerce's description of an argument, cut to what a client can act on. `mixed` (used for
 * meta values) is not a JSON Schema type and some clients reject the whole tool over it; nested
 * `readonly` properties are ones WooCommerce ignores if you send them.
 */
const clean = (a: Args): JSONSchema => {
  const out: JSONSchema = {};
  const types = [a["type"]].flat().filter((t): t is string => TYPES.has(t as string));
  if (types.length) out.type = types.length === 1 ? types[0]! : types;
  if (typeof a["description"] === "string") out.description = a["description"];
  if (Array.isArray(a["enum"])) out.enum = a["enum"];
  if (typeof a["minimum"] === "number") out.minimum = a["minimum"];
  if (typeof a["maximum"] === "number") out.maximum = a["maximum"];
  if (a["items"] && typeof a["items"] === "object") out.items = clean(a["items"] as Args);
  if (a["properties"] && typeof a["properties"] === "object") {
    out.properties = Object.fromEntries(
      Object.entries(a["properties"] as Record<string, Args>)
        .filter(([, p]) => !p["readonly"])
        .map(([k, p]) => [k, clean(p)]),
    );
  }
  return out;
};

/** The `{name}` placeholders in a path, in order. */
const idsIn = (path: string) => [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
const idLabel = (p: string, label: string) =>
  p === "id" ? `The ${label} ID.` : `The ${p.replace(/_id$/, "")} ID.`;

/** An input schema: the path IDs first and required, then whatever the route itself takes. */
const inputFor = (label: string, ids: string[], args: Record<string, RawArg> = {}): JSONSchema => {
  const properties: Record<string, JSONSchema> = {};
  for (const p of ids) properties[p] = { type: "integer", description: idLabel(p, label) };
  const required = [...ids];
  for (const [k, a] of Object.entries(args)) {
    if (properties[k] || k === "context") continue; // `context` only changes what comes back
    properties[k] = clean(a);
    if (a.required) required.push(k);
  }
  return { type: "object", properties, required };
};

/** Only the arguments the route declares, so `user_confirmed` and path IDs stay out of the body. */
const pick = (args: Args, allowed: Record<string, RawArg>, ids: string[]) =>
  Object.fromEntries(
    Object.entries(args).filter(([k, v]) => v !== undefined && k in allowed && !ids.includes(k)),
  );

// ─── HTTP ──────────────────────────────────────────────────────────────────────────────────────
const root = (base: string) => `${base}/wp-json/${NAMESPACE}`;

/** Fill in `{order_id}` and friends, refusing rather than sending a request to a literal "{id}". */
const fill = (path: string, args: Args) =>
  path.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = args[k];
    if (v === undefined || v === "" || !/^\d+$/.test(String(v)))
      throw new Error(`Missing or invalid ${k}: it must be a numeric ID.`);
    return String(v);
  });

/** WordPress reads `include[]=1&include[]=2` as a list, and "true"/"false" as booleans. */
const queryOf = (args: Args) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => q.append(`${k}[]`, String(x)));
    else q.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
};

const send = async (url: string, creds: Creds, method = "GET", body?: Args) => {
  const { res, body: out, text } = await api(url, creds, { method, ...(body && { body }) });
  if (!res.ok) throw new Error(apiError(url, res, out, text));
  return { res, out };
};

// ─── Presentation ──────────────────────────────────────────────────────────────────────────────
/** Whichever field names a record: products have a name, orders a number, coupons a code… */
const NAMES = ["name", "number", "code", "email", "username", "review", "note", "reason", "title"];
/** The facts worth a glance in a list, when a record has them. */
const FACTS = [
  "status",
  "type",
  "sku",
  "price",
  "stock_status",
  "stock_quantity",
  "total",
  "currency",
  "amount",
  "discount_type",
  "role",
  "rating",
  "reviewer",
  "count",
  "date_created",
];

const headline = (r: Args) => {
  const raw = NAMES.map((k) => r[k]).find((v) => typeof v === "string" && v) as string | undefined;
  let out = truncate(stripHtml(raw ?? ""), 120) || "(unnamed)";
  const b = r["billing"] as Args | undefined; // an order says whose it is
  const who = [b?.["first_name"], b?.["last_name"]].filter(Boolean).join(" ");
  if (who) out += ` — ${who}`;
  return out;
};
const facts = (r: Args) =>
  [`ID: ${r["id"]}`]
    .concat(FACTS.filter((k) => r[k] != null && r[k] !== "").map((k) => `${k}: ${r[k]}`))
    .join(" | ");
/** Links are for browsing the API, not for reading the record, and they are much of its size. */
const withoutLinks = ({ _links, ...r }: Args) => r;

const describe = (r: Args, what: string) =>
  `${what}: ${headline(r)}\n${facts(r)}\n` +
  (r["permalink"] ? `URL: ${r["permalink"]}\n` : "") +
  `\n${JSON.stringify(withoutLinks(r), null, 2).slice(0, 4000)}`;

// ─── Operations ────────────────────────────────────────────────────────────────────────────────
const list = async (base: string, creds: Creds, res: Resource, ids: Args, query: Args) => {
  const url = `${root(base)}/${fill(res.path, ids)}${queryOf(query)}`;
  const { res: r, out } = await send(url, creds);
  const items = (Array.isArray(out) ? out : []) as Args[];
  if (!items.length) return `No ${res.label}s found matching your criteria.`;
  const page = Number(query["page"] ?? 1);
  const total = r.headers.get("X-WP-Total") ?? "?";
  const pages = r.headers.get("X-WP-TotalPages") ?? "?";
  const lines = items.map(
    (it) =>
      `• ${headline(it)}\n  ${facts(it)}` + (it["permalink"] ? `\n  URL: ${it["permalink"]}` : ""),
  );
  let text = `Found ${total} ${res.label}(s) (page ${page}/${pages}):\n\n${lines.join("\n")}\n`;
  if (Number(pages) > page) text += `\n→ More results available. Use page: ${page + 1}.`;
  return text;
};

/** One record, whole, so it can be read before it is changed. */
const one = async (base: string, creds: Creds, res: Resource, ids: Args) => {
  const url = `${root(base)}/${fill(`${res.path}/{id}`, ids)}`;
  const { out } = await send(url, creds);
  const r = (out ?? {}) as Args;
  let text = `# ${headline(r)}\n${facts(r)}\n`;
  if (r["permalink"]) text += `URL: ${r["permalink"]}\n`;
  text += `\n${JSON.stringify(withoutLinks(r), null, 2)}`;
  if (text.length > 100_000) text = text.slice(0, 100_000) + "\n\n[Truncated to 100,000 chars]";
  return text;
};

/** Whether a create route's `status` can be "draft" — true of products, not of orders. */
const draftable = (status?: Args) => {
  const e = status?.["enum"];
  return Array.isArray(e) && e.includes("draft");
};

const make = async (
  base: string,
  creds: Creds,
  res: Resource,
  ids: Args,
  body: Args,
  status?: Args,
) => {
  // A new product is live by default in WooCommerce; here it is a draft unless you say otherwise.
  if (draftable(status) && body["status"] === undefined) body = { ...body, status: "draft" };
  const url = `${root(base)}/${fill(res.path, ids)}`;
  const { out } = await send(url, creds, "POST", body);
  return describe((out ?? {}) as Args, `Created ${res.label}`);
};

const change = async (base: string, creds: Creds, res: Resource, ids: Args, body: Args) => {
  if (!Object.keys(body).length) return "Nothing to update: no fields were supplied.";
  const url = `${root(base)}/${fill(`${res.path}/{id}`, ids)}`;
  const { out } = await send(url, creds, "POST", body);
  return describe((out ?? {}) as Args, `Updated ${res.label}`);
};

/**
 * Products, variations, orders and coupons can be trashed. Customers, categories, tags, notes
 * and refunds cannot, and WooCommerce refuses those without `force` — its own message says so,
 * which is the cue to ask the user about deleting permanently rather than to retry quietly.
 */
const drop = async (base: string, creds: Creds, res: Resource, ids: Args, force: boolean) => {
  const url = `${root(base)}/${fill(`${res.path}/{id}`, ids)}${force ? "?force=true" : ""}`;
  await send(url, creds, "DELETE");
  return force
    ? `Permanently deleted ${res.label} ${ids["id"]}. This cannot be undone.`
    : `Moved ${res.label} ${ids["id"]} to the trash. Restore it in wp-admin, or pass force to purge it.`;
};

/** Any wc/v3 route, read-only; or, with no path, the list of routes this site has. */
const endpoint = async (base: string, creds: Creds, path?: string, query: Args = {}) => {
  if (!path) {
    const index = await wcIndex(base, creds);
    const lines = Object.entries(index).map(
      ([p, m]) => `• ${p || "(namespace root)"} — ${Object.keys(m).join(", ")}`,
    );
    return `wc/v3 routes on ${new URL(base).hostname}:\n\n${lines.join("\n")}\n`;
  }
  const route = path
    .trim()
    .replace(/^\/+/, "")
    .replace(/^wc\/v3\/?/, "");
  // Letters, digits, dashes, underscores and slashes only: no dots, encoded or not, and no query,
  // so a path cannot climb out of wc/v3 into some other namespace with this login attached.
  if (!/^[\w\-/]*$/.test(route))
    return `Invalid path "${path}". Use a wc/v3 route such as "reports/sales" or "system_status".`;
  const { out } = await send(`${root(base)}/${route}${queryOf(query)}`, creds);
  const text = JSON.stringify(
    Array.isArray(out) ? (out as Args[]).map(withoutLinks) : out,
    null,
    2,
  );
  return text.length > 100_000 ? text.slice(0, 100_000) + "\n\n[Truncated]" : text;
};

const ENDPOINT_PROPS = {
  path: {
    type: "string",
    description:
      'A wc/v3 route, e.g. "reports/sales", "reports/top_sellers", "settings/general", ' +
      '"system_status", "shipping/zones", "payment_gateways". Omit to list every route.',
  },
  query: { type: "object", description: 'Query parameters, e.g. {"period": "month"}.' },
} as const satisfies Record<string, JSONSchema>;

// ─── Site mode ─────────────────────────────────────────────────────────────────────────────────
/**
 * Tools for each resource, generated from what the site's index says each route accepts. A
 * method the site does not offer (WooCommerce has no way to edit a refund) gets no tool.
 */
export const wcTools = async (s: Schema, creds: Creds | null): Promise<Tools> => {
  if (!creds || !s.namespaces.includes(NAMESPACE)) return {};
  const auth = creds;
  const host = new URL(s.base).hostname;
  const tools: Tools = {
    get_wc_endpoint: {
      description:
        `Read any WooCommerce REST route on ${host} — reports, settings, shipping, tax, system ` +
        "status. Call with no path to list the routes. Returns the raw JSON.",
      input: { type: "object", properties: ENDPOINT_PROPS },
      run: ({ path, query }: { path?: string; query?: Args }) =>
        endpoint(s.base, auth, path, query),
    },
  };
  // Without the index there is nothing to build schemas from, but the endpoint tool still works
  // and will say what went wrong when asked for the route list.
  const index = await wcIndex(s.base, auth).catch(() => null);
  if (!index) return tools;

  for (const key of KEYS) {
    const res = RESOURCES[key];
    const coll = index[res.path];
    const item = index[`${res.path}/{id}`];
    const ids = idsIn(res.path);
    const itemIds = [...ids, "id"];

    if (coll?.GET)
      tools[`search_wc_${key}`] = {
        description:
          `List or search WooCommerce ${res.label}s on ${host}. ` +
          "Returns a line per record with its ID; use get_wc_" +
          `${key} for the whole thing.`,
        input: inputFor(res.label, ids, coll.GET),
        run: (args: Args) => list(s.base, auth, res, args, pick(args, coll.GET!, ids)),
      };

    if (item?.GET)
      tools[`get_wc_${key}`] = {
        description: `Get one WooCommerce ${res.label} by ID, every field as JSON.`,
        input: inputFor(res.label, itemIds),
        run: (args: Args) => one(s.base, auth, res, args),
      };

    if (coll?.POST)
      tools[`create_wc_${key}`] = {
        description:
          `Create a WooCommerce ${res.label} on ${host}.` +
          (draftable(coll.POST["status"]) ? " Creates a draft unless status says otherwise." : ""),
        confirm: true,
        annotations: { destructiveHint: false },
        input: inputFor(res.label, ids, coll.POST),
        run: (args: Args) =>
          make(s.base, auth, res, args, pick(args, coll.POST!, ids), coll.POST!["status"]),
      };

    if (item?.POST)
      tools[`update_wc_${key}`] = {
        description:
          `Update one WooCommerce ${res.label} on ${host}. Send only the fields you are ` +
          "changing; everything else is left alone.",
        confirm: true,
        input: inputFor(res.label, itemIds, item.POST),
        run: (args: Args) => change(s.base, auth, res, args, pick(args, item.POST!, itemIds)),
      };

    if (item?.DELETE)
      tools[`delete_wc_${key}`] = {
        description:
          `Delete one WooCommerce ${res.label} on ${host}. Trashes it where WooCommerce can; ` +
          "where it cannot, it refuses unless force is true, which deletes permanently.",
        confirm: true,
        annotations: { destructiveHint: true },
        input: inputFor(res.label, itemIds, { force: item.DELETE["force"] ?? { type: "boolean" } }),
        run: (args: Args) => drop(s.base, auth, res, args, args["force"] === true),
      };
  }
  return tools;
};

// ─── Generic mode ──────────────────────────────────────────────────────────────────────────────
const RESOURCE_PROP = {
  type: "string",
  enum: KEYS,
  description:
    "Which WooCommerce resource. product_variations needs parent_id (the product); order_notes " +
    "and order_refunds need parent_id (the order).",
} as const;
const COMMON = {
  url: { type: "string", description: "WordPress site base URL, e.g. https://shop.example" },
  resource: RESOURCE_PROP,
  parent_id: { type: "integer", description: "The product or order the resource belongs to." },
} as const satisfies Record<string, JSONSchema>;

/** The site, its login (or why there is none) and the path IDs, for tools that take a `url`. */
const open = async (c: Ctx, url: string, resource: Key, parent?: number, id?: number) => {
  const base = siteUrl(url);
  const res = RESOURCES[resource];
  if (!res) throw new Error(`Unknown resource "${resource}". One of: ${KEYS.join(", ")}.`);
  const login = await credsFor(base, c);
  if (!usable(login)) return { problem: login?.problem ?? needsLogin(base, await c.email()) };
  const s = await discoverSite(base);
  if (!s.namespaces.includes(NAMESPACE))
    return { problem: `${new URL(base).hostname} does not expose WooCommerce's REST API (wc/v3).` };
  const [parentKey] = idsIn(res.path);
  const ids: Args = { ...(parentKey && { [parentKey]: parent }), ...(id !== undefined && { id }) };
  return { base, res, creds: login, ids };
};

export const wcGenericTools: Tools = {
  search_wc: {
    description:
      "List or search a WooCommerce resource — products, orders, customers, coupons and so on. " +
      "WooCommerce needs a login even to read.",
    input: {
      type: "object",
      required: ["url", "resource"],
      properties: {
        ...COMMON,
        search: { type: "string", description: "Full-text search." },
        status: { type: "string", description: "Filter by status, e.g. processing, draft." },
        page: { type: "integer", description: "Page number (default 1)." },
        per_page: { type: "integer", description: "Results per page (1-100, default 10)." },
        filters: {
          type: "object",
          description: 'Any other list parameter the route takes, e.g. {"sku": "ABC-1"}.',
        },
      },
    },
    async run(a: Args & { url: string; resource: Key; parent_id?: number; filters?: Args }, c) {
      const o = await open(c, a.url, a.resource, a.parent_id);
      if ("problem" in o) return o.problem;
      const { search, status, page, per_page } = a;
      return list(o.base, o.creds, o.res, o.ids, { ...a.filters, search, status, page, per_page });
    },
  },

  get_wc: {
    description: "Get one WooCommerce record by ID, every field as JSON.",
    input: {
      type: "object",
      required: ["url", "resource", "id"],
      properties: { ...COMMON, id: { type: "integer", description: "The record ID." } },
    },
    async run(a: { url: string; resource: Key; parent_id?: number; id: number }, c) {
      const o = await open(c, a.url, a.resource, a.parent_id, a.id);
      return "problem" in o ? o.problem : one(o.base, o.creds, o.res, o.ids);
    },
  },

  get_wc_endpoint: {
    description:
      "Read any WooCommerce REST route — reports, settings, shipping, tax, system status. Call " +
      "with no path to list the routes. Returns the raw JSON.",
    input: {
      type: "object",
      required: ["url"],
      properties: { url: COMMON.url, ...ENDPOINT_PROPS },
    },
    async run(a: { url: string; path?: string; query?: Args }, c) {
      const base = siteUrl(a.url);
      const login = await credsFor(base, c);
      if (!usable(login)) return login?.problem ?? needsLogin(base, await c.email());
      return endpoint(base, login, a.path, a.query);
    },
  },

  create_wc: {
    description:
      "Create a WooCommerce record. A product is created as a draft unless fields.status says " +
      "otherwise. Use get_wc_endpoint with no path, or a site-mode connector, to see the fields.",
    confirm: true,
    annotations: { destructiveHint: false },
    input: {
      type: "object",
      required: ["url", "resource", "fields"],
      properties: {
        ...COMMON,
        fields: {
          type: "object",
          description: 'The record, e.g. {"name": "Mug", "regular_price": "12"}.',
        },
      },
    },
    async run(a: { url: string; resource: Key; parent_id?: number; fields: Args }, c) {
      const o = await open(c, a.url, a.resource, a.parent_id);
      if ("problem" in o) return o.problem;
      const status = a.resource === "products" ? { enum: ["draft"] } : undefined;
      return make(o.base, o.creds, o.res, o.ids, { ...a.fields }, status);
    },
  },

  update_wc: {
    description:
      "Update one WooCommerce record. Send only the fields you are changing; everything else is " +
      "left alone.",
    confirm: true,
    input: {
      type: "object",
      required: ["url", "resource", "id", "fields"],
      properties: {
        ...COMMON,
        id: { type: "integer", description: "The record ID." },
        fields: { type: "object", description: "Only the fields to change." },
      },
    },
    async run(a: { url: string; resource: Key; parent_id?: number; id: number; fields: Args }, c) {
      const o = await open(c, a.url, a.resource, a.parent_id, a.id);
      return "problem" in o ? o.problem : change(o.base, o.creds, o.res, o.ids, { ...a.fields });
    },
  },

  delete_wc: {
    description:
      "Delete one WooCommerce record. Trashes it where WooCommerce can; where it cannot " +
      "(customers, categories, tags, notes, refunds) it refuses unless force is true.",
    confirm: true,
    annotations: { destructiveHint: true },
    input: {
      type: "object",
      required: ["url", "resource", "id"],
      properties: {
        ...COMMON,
        id: { type: "integer", description: "The record ID." },
        force: { type: "boolean", description: "Delete permanently. Cannot be undone." },
      },
    },
    async run(
      a: { url: string; resource: Key; parent_id?: number; id: number; force?: boolean },
      c,
    ) {
      const o = await open(c, a.url, a.resource, a.parent_id, a.id);
      return "problem" in o ? o.problem : drop(o.base, o.creds, o.res, o.ids, a.force === true);
    },
  },
};
