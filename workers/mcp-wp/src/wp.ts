/** WordPress: discovery, credentials, and the read/write operations every tool boils down to. */
import type { Ctx } from "../../../core/mcp";
import { stripHtml, truncate } from "../../../core/web";

// ─── Shapes ────────────────────────────────────────────────────────────────────────────────────
export type PostType = {
  slug: string;
  name: string;
  rest_base: string;
  description: string;
  taxonomies: string[];
};
export type Taxonomy = { slug: string; name: string; rest_base: string; hierarchical: boolean };
export type Schema = {
  base: string;
  apiBase: string;
  postTypes: Record<string, PostType>;
  taxonomies: Record<string, Taxonomy>;
  /** REST namespaces the site exposes, e.g. "wp/v2", "tribe/events/v1". */
  namespaces: string[];
};
export type Term = { id: number; name: string; slug: string; count: number };
type Rendered = { rendered?: string };
export type Item = {
  id: number;
  date?: string;
  link?: string;
  status?: string;
  class_list?: string[];
  title?: Rendered;
  excerpt?: Rendered;
  content?: Rendered;
};
export type SearchArgs = {
  query?: string;
  after?: string;
  before?: string;
  per_page?: number;
  page?: number;
  orderby?: string;
  status?: string;
  [taxonomy: string]: string | number | undefined;
};
/** Fields common to every post type. Taxonomy terms arrive as extra keys, like SearchArgs. */
export type WriteArgs = {
  title?: string;
  content?: string;
  excerpt?: string;
  status?: string;
  slug?: string;
  date?: string;
  featured_media?: number;
  [taxonomy: string]: string | number | undefined;
};

// ─── Text helpers ──────────────────────────────────────────────────────────────────────────────
export const pluralise = (w: string) =>
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
export const siteUrl = (raw: string) => {
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
export const slug = (url: string) =>
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

// ─── Credentials ───────────────────────────────────────────────────────────────────────────────
export type Creds = { user: string; pass: string };
/** Either a usable login, or why there isn't one. Misconfiguration explains itself rather than
 *  throwing, so one bad entry cannot take the other sites on a connector down with it. */
export type Login = Creds | { problem: string };
export const usable = (l: Login | null): l is Creds => l !== null && "user" in l;

/** One person's logins: hostname -> the WordPress username and the secret holding its password. */
type Person = Record<string, { user?: string; pass?: string }>;

/** `user:application password` -> the pair. A username cannot contain a colon; a password can. */
const pairOf = (text: string): Creds | null => {
  const at = text.indexOf(":");
  if (at <= 0) return null;
  const user = text.slice(0, at).trim();
  // WordPress prints application passwords in groups of four; the spaces are stripped later.
  const pass = text.slice(at + 1).trim();
  return user && pass ? { user, pass } : null;
};

/**
 * A login carried on the request, so someone can edit a site without anything being stored here.
 *
 * Every header whose name starts with `X-WP-Auth` holds exactly one entry — one per header
 * rather than several in one, so no separator has to be chosen that a password might contain:
 *
 *   X-WP-Auth:       user:application password           any site on this connector
 *   X-WP-Auth-Apil:  apil.au=user:application password   that host only
 *
 * A header naming this host wins over a bare one, so a default plus an exception both work. The
 * name after `X-WP-Auth` is yours and is never read: connectors key headers by name, so the
 * suffix exists only to let you add more than one.
 */
export const authFrom = (headers: Record<string, string>, host: string): Creds | null => {
  let bare: Creds | null = null;
  for (const [name, value] of Object.entries(headers)) {
    if (!name.startsWith("x-wp-auth")) continue;
    // A host never contains a colon, so `u:a=b` is a password with an `=` in it, not a host.
    const named = value.match(/^([^=:\s]+)=(.*)$/);
    const creds = pairOf(named ? named[2]!.trim() : value.trim());
    if (!creds) continue;
    if (!named) bare ??= creds;
    else if (named[1] === host) return creds;
  }
  return bare;
};

export const credsFor = async (base: string, c: Ctx): Promise<Login | null> => {
  const fromHeader = authFrom(c.headers, new URL(base).hostname);
  if (fromHeader) return fromHeader;
  const email = await c.email();
  if (!email || !c.env.WP_SITES) return null;
  const { people, problem } = readSites(c.env.WP_SITES);
  if (!people) return { problem: problem ?? "WP_SITES could not be read." };
  const host = new URL(base).hostname;
  const entry = people[email]?.[host];
  if (!entry) return null;
  if (!entry.user || !entry.pass) {
    return {
      problem:
        `The WP_SITES entry for ${host} under ${email} needs both "user" (the WordPress login) ` +
        'and "pass" (the name of the secret holding its Application Password).',
    };
  }
  const pass = (c.env as unknown as Record<string, string | undefined>)[entry.pass];
  if (!pass) {
    return {
      problem:
        `${host} is configured for ${entry.user}, but there is no secret named ${entry.pass}. ` +
        "Add it, or correct the `pass` name in WP_SITES.",
    };
  }
  return { user: entry.user, pass };
};

/**
 * Why some JSON would not parse, in terms you can act on. Smart quotes are the usual culprit:
 * anything that autocorrects text turns " into a curly pair that JSON.parse rejects.
 */
/**
 * WP_SITES as an object, however the dashboard stored it. A variable can be typed Text or JSON:
 * a JSON-typed one arrives already parsed, and parsing it again would fail.
 */
const readSites = (v: unknown): { people?: Record<string, Person>; problem?: string } => {
  if (v && typeof v === "object") return { people: v as Record<string, Person> };
  if (typeof v !== "string") return { problem: `WP_SITES is a ${typeof v}, which cannot be read.` };
  try {
    return { people: JSON.parse(v) };
  } catch (e) {
    return { problem: `WP_SITES is not valid JSON — it ${whyNotJson(v, e)}` };
  }
};

const whyNotJson = (raw: string, e: unknown) => {
  const curly = /[\u201C\u201D\u2018\u2019]/.exec(raw);
  const detail = e instanceof Error ? e.message : String(e);
  if (curly) {
    return (
      `contains a curly quote (${curly[0]}) at position ${curly.index}. Something autocorrected ` +
      'the text. Replace every " and \u2019 with straight ASCII quotes and save again.'
    );
  }
  if (/,\s*[}\]]/.test(raw)) return `has a trailing comma before a closing brace. ${detail}`;
  if (!raw.trim().startsWith("{")) {
    return `does not start with "{" — it begins "${raw.trim().slice(0, 20)}". ${detail}`;
  }
  return detail;
};

/**
 * A plain-language account of whether this connector can edit `base`, and what is missing if it
 * cannot. Names the secret it looked for but never its value, and never another person's email.
 */
export const loginReport = async (base: string, c: Ctx): Promise<string> => {
  const host = new URL(base).hostname;
  const email = await c.email();
  const lines = [
    `site: ${host}`,
    `signed in as: ${email ?? "(nobody — Cloudflare Access is off)"}`,
  ];

  // Never the password, and never the raw header: only whether it was usable, and as whom.
  const sent = Object.keys(c.headers).filter((n) => n.startsWith("x-wp-auth"));
  const fromHeader = authFrom(c.headers, host);
  if (!sent.length) lines.push("X-WP-Auth header: not sent");
  else if (fromHeader)
    lines.push(`X-WP-Auth header: ${sent.length} sent, one used — user ${fromHeader.user}`);
  else
    lines.push(
      `X-WP-Auth header: ${sent.length} sent, none of them for ${host}. Each should hold one ` +
        `entry: "user:application password", or "${host}=user:application password" to name ` +
        "the site. Use a second header rather than putting two in one.",
    );
  if (fromHeader) lines.push("(the header wins, so WP_SITES is not consulted)");

  if (!c.env.WP_SITES) lines.push("WP_SITES: not set");
  else {
    const { people, problem } = readSites(c.env.WP_SITES);
    if (problem) lines.push(`WP_SITES: ${problem}`);
    if (people) {
      const mine = email ? people[email] : undefined;
      const others = Object.keys(people).filter((k) => k !== email).length;
      lines.push(
        `WP_SITES: valid, ${Object.keys(people).length} identity/identities` +
          (others ? ` (${others} not you)` : ""),
      );
      if (!email) lines.push("no identity, so no entry can be matched");
      else if (!mine) lines.push(`no entry for ${email} — check it matches your Access email`);
      else {
        lines.push(`your hosts: ${Object.keys(mine).join(", ") || "(none)"}`);
        const entry = mine[host];
        if (!entry) lines.push(`no entry for ${host} — check the spelling, including any "www."`);
        else if (!entry.user || !entry.pass)
          lines.push(`entry for ${host} is missing user or pass`);
        else {
          const set = (c.env as unknown as Record<string, unknown>)[entry.pass] !== undefined;
          lines.push(`entry for ${host}: user ${entry.user}, password from secret ${entry.pass}`);
          lines.push(`secret ${entry.pass}: ${set ? "set" : "NOT SET — add it, or fix the name"}`);
        }
      }
    }
  }
  const login = await credsFor(base, c);
  lines.push("", usable(login) ? "verdict: editable" : `verdict: read-only`);
  if (login && !usable(login)) lines.push(login.problem);
  return lines.join("\n");
};

/** Explains what to add when a write is attempted on a site this person has no login for. */
export const needsLogin = (base: string, email?: string) => {
  const host = new URL(base).hostname;
  if (!email)
    return (
      `Editing needs a signed-in identity and none arrived, so ${host} is read-only. ` +
      "Turn on Cloudflare Access for this worker."
    );
  return (
    `No login configured for ${host} under ${email}, so it is read-only. Add it to the WP_SITES ` +
    `variable as {"${email}": {"${host}": {"user": "your-wp-username", "pass": "PICK_A_NAME"}}}, ` +
    "then add a secret called PICK_A_NAME holding that user's Application Password."
  );
};

// ─── HTTP ──────────────────────────────────────────────────────────────────────────────────────
/** Workers send no User-Agent unless asked to, and some hosts redirect or challenge requests
 *  without one. Sent on every request so a site can recognise and allow this worker. */
const UA = "mcp-wp";

type Json = Record<string, unknown> | unknown[];
type WpError = { code?: string; message?: string; data?: { status?: number } };

/** One request to a WordPress REST endpoint. Sends the login when there is one. */
export const api = async (
  url: string,
  creds: Creds | null,
  init: { method?: string; body?: unknown } = {},
) => {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": UA };
  if (creds) {
    const pass = creds.pass.replace(/\s+/g, ""); // WordPress prints app passwords in groups of 4
    headers["Authorization"] = "Basic " + btoa(`${creds.user}:${pass}`);
  }
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let body: Json | WpError | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { res, body, text };
};

/** WordPress's own error wording, verbatim, plus the hint the status code usually calls for. */
export const apiError = (url: string, res: Response, body: unknown, text: string) => {
  const e = (body ?? {}) as WpError;
  const said = e.message ? `${e.message}${e.code ? ` (${e.code})` : ""}` : text.slice(0, 300);
  const hint =
    res.status === 401
      ? " — check the username and Application Password in WP_SITES."
      : res.status === 403
        ? " — the user lacks the capability for this. An Editor role is usually enough."
        : res.status === 404
          ? " — wrong ID, or this site does not expose that route."
          : "";
  return `WordPress API ${res.status} on ${url}: ${said}${hint}`;
};

const call = async (
  url: string,
  creds: Creds | null,
  init?: { method?: string; body?: unknown },
) => {
  const { res, body, text } = await api(url, creds, init);
  if (!res.ok) throw new Error(apiError(url, res, body, text));
  return { body, res };
};

// ─── Cache (6 h, per isolate) ──────────────────────────────────────────────────────────────────
const cache = new Map<string, { at: number; data: unknown }>();
export const memo = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
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

/** What a site has: its post types, its taxonomies, and which REST namespaces it exposes. */
export const discoverSite = (base: string) =>
  memo<Schema>(`schema:${base}`, async () => {
    const apiBase = `${base}/wp-json/wp/v2`;
    const get = (u: string) => fetch(u, { headers: { "User-Agent": UA } });
    const [typesRes, taxRes, rootRes] = await Promise.all([
      get(`${apiBase}/types`),
      get(`${apiBase}/taxonomies`),
      get(`${base}/wp-json/`),
    ]);
    if (!typesRes.ok) throw new Error(`Failed to fetch types from ${base}: ${typesRes.status}`);
    if (!taxRes.ok) throw new Error(`Failed to fetch taxonomies from ${base}: ${taxRes.status}`);
    const types: Record<string, RawType> = await typesRes.json();
    const taxes: Record<string, RawTax> = await taxRes.json();
    const root: { namespaces?: string[] } = rootRes.ok ? await rootRes.json() : {};
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
    return { base, apiBase, postTypes, taxonomies, namespaces: root.namespaces ?? [] };
  });

const getTerms = (apiBase: string, tax: Taxonomy) =>
  memo<Term[]>(`terms:${apiBase}:${tax.rest_base}`, async () => {
    const res = await fetch(`${apiBase}/${tax.rest_base}?per_page=100&orderby=count&order=desc`, {
      headers: { "User-Agent": UA },
    }).catch(() => null);
    if (!res?.ok) return [];
    const terms: Term[] = await res.json();
    return terms.map(({ id, name, slug, count }) => ({ id, name, slug, count }));
  });

/** A term ID from an ID, a slug, or a name — so callers never have to look one up first. */
export const resolveTerm = async (apiBase: string, tax: Taxonomy, query: string | number) => {
  if (!isNaN(Number(query))) return Number(query);
  const q = String(query).toLowerCase().trim();
  const terms = await getTerms(apiBase, tax);
  const hit =
    terms.find((t) => t.name.toLowerCase() === q || t.slug === q) ??
    terms.find((t) => t.name.toLowerCase().includes(q));
  if (hit) return hit.id;
  const res = await fetch(
    `${apiBase}/${tax.rest_base}?search=${encodeURIComponent(q)}&per_page=1`,
    { headers: { "User-Agent": UA } },
  ).catch(() => null);
  const found: Term[] = res?.ok ? await res.json() : [];
  return found[0]?.id ?? null;
};

/** Turn taxonomy arguments (by name, slug or ID) into the `?tax=ID` pairs WordPress wants. */
const taxParams = async (args: SearchArgs, type: PostType, s: Schema) => {
  const out: Record<string, string> = {};
  for (const taxSlug of type.taxonomies) {
    const wanted = args[taxSlug.replaceAll("-", "_")];
    const tax = s.taxonomies[taxSlug];
    if (wanted === undefined || wanted === "" || !tax) continue;
    const id = await resolveTerm(s.apiBase, tax, wanted);
    if (!id)
      throw new Error(
        `Could not resolve "${wanted}" to a term in ${tax.name}. ` +
          "Use list_terms to browse available terms.",
      );
    out[tax.rest_base] = String(id);
  }
  return out;
};

// ─── Read ──────────────────────────────────────────────────────────────────────────────────────
export const search = async (args: SearchArgs, type: PostType, s: Schema, creds: Creds | null) => {
  const p = new URLSearchParams({
    order: "desc",
    per_page: String(Math.min(Math.max(args.per_page ?? 10, 1), 100)),
    page: String(Math.max(args.page ?? 1, 1)),
    orderby: args.orderby ?? (args.query ? "relevance" : "date"),
  });
  if (args.query) p.set("search", args.query);
  if (args.after) p.set("after", normaliseDate(args.after));
  if (args.before) p.set("before", normaliseDate(args.before));
  if (args.status) p.set("status", args.status); // drafts and private need a login
  for (const [k, v] of Object.entries(await taxParams(args, type, s))) p.set(k, v);

  const { body, res } = await call(`${s.apiBase}/${type.rest_base}?${p}`, creds);
  const items = (body ?? []) as Item[];
  const total = res.headers.get("X-WP-Total") ?? "?";
  const pages = res.headers.get("X-WP-TotalPages") ?? "?";
  const page = args.page ?? 1;
  if (!items.length) return `No ${type.name} found matching your criteria.`;
  let out = `Found ${total} ${type.name} (page ${page}/${pages}):\n\n`;
  items.forEach((item, i) => {
    const n = (page - 1) * (args.per_page ?? 10) + i + 1;
    out += `${n}. ${stripHtml(item.title?.rendered || "Untitled")}\n`;
    out += `   ID: ${item.id} | Date: ${formatDate(item.date)}`;
    out += item.status && item.status !== "publish" ? ` | ${item.status}\n` : "\n";
    if (item.link) out += `   URL: ${item.link}\n`;
    if (termLabels(item)) out += `   ${termLabels(item)}\n`;
    const excerpt = truncate(stripHtml(item.excerpt?.rendered || item.content?.rendered), 400);
    if (excerpt) out += `   ${excerpt}\n`;
    out += "\n";
  });
  if (Number(pages) > page) out += `→ More results available. Use page: ${page + 1} to continue.`;
  return out;
};

/**
 * One item, with its body exactly as WordPress stores it.
 *
 * The body is deliberately NOT stripped. Reading a post is usually the first half of editing it,
 * and stripping the markup would mean writing back plain text over the blocks, links, embeds and
 * shortcodes that were there — destroying the post in the name of making it readable. Search
 * results still strip, because a 400-character preview of raw HTML is mostly angle brackets.
 */
export const get = async (id: number, type: PostType, s: Schema, creds: Creds | null) => {
  const { body } = await call(`${s.apiBase}/${type.rest_base}/${id}`, creds);
  const item = (body ?? {}) as Item;
  let out = `# ${stripHtml(item.title?.rendered || "Untitled")}\n`;
  out += `Date: ${formatDate(item.date)} | ID: ${item.id}`;
  out += item.status ? ` | ${item.status}\n` : "\n";
  if (item.link) out += `URL: ${item.link}\n`;
  if (termLabels(item)) out += `${termLabels(item)}\n`;
  out += `\n---\n\n${item.content?.rendered ?? ""}`;
  if (out.length > 100_000) {
    out =
      out.slice(0, 100_000) +
      "\n\n[Content truncated to 100,000 chars — full document at URL above]";
  }
  return out;
};

export const listTerms = async (
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
  const { body, res } = await call(`${s.apiBase}/${tax.rest_base}?${p}`, null);
  const terms = (body ?? []) as Term[];
  if (!terms.length)
    return `No terms found in ${tax.name}${args.search ? ` matching "${args.search}"` : ""}.`;
  const lines = terms.map((t) => `• ${t.name} (slug: ${t.slug}, id: ${t.id}, count: ${t.count})`);
  const total = res.headers.get("X-WP-Total") ?? "?";
  return `${tax.name} — ${total} total terms (showing ${terms.length}):\n\n${lines.join("\n")}\n`;
};

// ─── Write ─────────────────────────────────────────────────────────────────────────────────────
/** Only the fields actually supplied are sent, so an update leaves everything else alone. */
const bodyFor = async (args: WriteArgs, type: PostType, s: Schema) => {
  const keep = ["title", "content", "excerpt", "status", "slug", "date", "featured_media"] as const;
  const body: Record<string, unknown> = {};
  for (const k of keep) if (args[k] !== undefined) body[k] = args[k];
  for (const [restBase, id] of Object.entries(await taxParams(args, type, s))) {
    body[restBase] = [Number(id)];
  }
  return body;
};

const describe = (item: Item, what: string) =>
  `${what}: ${stripHtml(item.title?.rendered || "(untitled)")}\n` +
  `ID: ${item.id} | status: ${item.status ?? "?"}\n` +
  (item.link ? `URL: ${item.link}\n` : "") +
  `\n${JSON.stringify(item, null, 2).slice(0, 4000)}`;

export const create = async (args: WriteArgs, type: PostType, s: Schema, creds: Creds) => {
  const body = await bodyFor(args, type, s);
  if (!body["status"]) body["status"] = "draft"; // never publish by accident
  const { body: made } = await call(`${s.apiBase}/${type.rest_base}`, creds, {
    method: "POST",
    body,
  });
  return describe((made ?? {}) as Item, `Created ${type.name}`);
};

export const update = async (
  id: number,
  args: WriteArgs,
  type: PostType,
  s: Schema,
  creds: Creds,
) => {
  const body = await bodyFor(args, type, s);
  if (!Object.keys(body).length) return "Nothing to update: no fields were supplied.";
  const { body: saved } = await call(`${s.apiBase}/${type.rest_base}/${id}`, creds, {
    method: "POST",
    body,
  });
  return describe((saved ?? {}) as Item, `Updated ${type.name}`);
};

export const remove = async (
  id: number,
  force: boolean,
  type: PostType,
  s: Schema,
  creds: Creds,
) => {
  const url = `${s.apiBase}/${type.rest_base}/${id}?force=${force}`;
  await call(url, creds, { method: "DELETE" });
  return force
    ? `Permanently deleted ${type.name} ${id}. This cannot be undone.`
    : `Moved ${type.name} ${id} to the trash. Restore it in wp-admin, or pass force to purge it.`;
};

// ─── Lookups shared by the tool definitions ────────────────────────────────────────────────────
export const findType = (s: Schema, restBase = "posts") =>
  Object.values(s.postTypes).find((t) => t.rest_base === restBase);
export const findTax = (s: Schema, key: string) =>
  Object.values(s.taxonomies).find((t) => t.rest_base === key || t.slug === key);
export const available = (xs: { rest_base: string }[]) => xs.map((x) => x.rest_base).join(", ");
