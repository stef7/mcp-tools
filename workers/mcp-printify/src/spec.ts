/**
 * The vendored OpenAPI document (spec.json, built by scripts/vendor-printify-spec.mjs), read once
 * into an index the tools can search, resolve a call against, and validate with.
 *
 * Nothing here throws at a caller. A document that cannot be read becomes `{ problem }`, which
 * the status page and every tool result report in words.
 */
import vendored from "./spec.json";

export type Schema = {
  $ref?: string;
  type?: string;
  nullable?: boolean;
  description?: string;
  enum?: unknown[];
  format?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  readOnly?: boolean;
  default?: unknown;
};

export type Param = {
  name: string;
  in: "path" | "query";
  required: boolean;
  description?: string;
  schema: Schema;
};

export type Operation = {
  method: string;
  /** The path as the spec writes it, placeholders and all: /v1/shops/{shop_id}/products.json */
  path: string;
  summary: string;
  description?: string;
  tag?: string;
  deprecated?: boolean;
  params: Param[];
  body?: { schema: Schema; example?: unknown };
  /** Matches a path with its placeholders filled in, capturing each value. */
  filled: RegExp;
  /** How many segments are literal: the tie-break when a filled-in path fits two templates. */
  literals: number;
};

export type Index = {
  ops: Operation[];
  schemas: Record<string, Schema>;
  server: string;
  /** Where the vendored copy came from, for the status page. */
  origin: string;
};
export type Loaded = Index | { problem: string };

type Doc = {
  openapi?: string;
  "x-vendored"?: { source?: string; retrieved?: string };
  servers?: { url?: string }[];
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    parameters?: Record<string, unknown>;
    requestBodies?: Record<string, unknown>;
    schemas?: Record<string, Schema>;
  };
};
type RawOp = {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: unknown[];
  requestBody?: unknown;
};
type RawBody = { content?: Record<string, { schema?: Schema; example?: unknown }> };

const METHODS = ["get", "post", "put", "patch", "delete"];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Turns an OpenAPI document into an index, or says what is wrong with it. */
export const buildIndex = (doc: unknown): Loaded => {
  try {
    const d = doc as Doc;
    if (!d || typeof d !== "object") return { problem: "The vendored spec is not an object." };
    if (!d.paths || !Object.keys(d.paths).length)
      return { problem: "The vendored spec has no paths." };
    const server = d.servers?.[0]?.url;
    if (!server) return { problem: "The vendored spec names no server." };
    const components = d.components ?? {};
    const follow = <T>(v: unknown): T => {
      const ref = (v as { $ref?: string } | undefined)?.$ref;
      if (!ref) return v as T;
      const [, , section, name] = ref.split("/");
      const target = (components as Record<string, Record<string, unknown> | undefined>)[
        section ?? ""
      ]?.[name ?? ""];
      if (!target) throw new Error(`nothing at ${ref}`);
      return follow<T>(target);
    };

    const ops: Operation[] = [];
    for (const [path, item] of Object.entries(d.paths)) {
      const shared = (item["parameters"] as unknown[] | undefined) ?? [];
      for (const method of METHODS) {
        const op = item[method] as RawOp | undefined;
        if (!op) continue;
        // An operation's own parameter replaces a path-level one of the same name and place.
        const params = new Map<string, Param>();
        for (const raw of [...shared, ...(op.parameters ?? [])]) {
          const p = follow<Partial<Param>>(raw);
          if (!p.name || (p.in !== "path" && p.in !== "query")) continue;
          params.set(`${p.in}:${p.name}`, {
            name: p.name,
            in: p.in,
            required: p.in === "path" || p.required === true,
            ...(p.description ? { description: p.description.trim() } : {}),
            schema: p.schema ?? {},
          });
        }
        const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
        for (const n of names)
          if (!params.has(`path:${n}`))
            params.set(`path:${n}`, { name: n, in: "path", required: true, schema: {} });
        const json = op.requestBody
          ? follow<RawBody>(op.requestBody).content?.["application/json"]
          : undefined;
        ops.push({
          method: method.toUpperCase(),
          path,
          summary: op.summary ?? op.description ?? "",
          ...(op.description ? { description: op.description } : {}),
          ...(op.tags?.[0] ? { tag: op.tags[0] } : {}),
          ...(op.deprecated ? { deprecated: true } : {}),
          params: [...params.values()],
          ...(json?.schema
            ? {
                body: {
                  schema: json.schema,
                  ...(json.example === undefined ? {} : { example: json.example }),
                },
              }
            : {}),
          filled: new RegExp(
            "^" +
              path
                .split(/\{[^}]+\}/)
                .map(escape)
                .join("([^/]+?)") +
              "$",
          ),
          literals: path.split("/").filter((s) => s && !s.includes("{")).length,
        });
      }
    }
    if (!ops.length) return { problem: "The vendored spec has paths but no operations." };
    const v = d["x-vendored"];
    return {
      ops,
      schemas: components.schemas ?? {},
      server: server.replace(/\/+$/, ""),
      origin: `OpenAPI ${d.openapi ?? "?"} from ${v?.source ?? "an unknown source"}, retrieved ${v?.retrieved ?? "?"}`,
    };
  } catch (e) {
    return {
      problem: `The vendored spec could not be read: ${e instanceof Error ? e.message : e}`,
    };
  }
};

let cached: Loaded | undefined;
/** The vendored spec, indexed once per isolate. */
export const loadSpec = (): Loaded => (cached ??= buildIndex(vendored));

// ─── Finding an operation ──────────────────────────────────────────────────────────────────────

const deref = (s: Schema | undefined, ix: Index): Schema => {
  let at = s ?? {};
  for (let i = 0; at.$ref && i < 20; i++) at = ix.schemas[at.$ref.split("/").pop() ?? ""] ?? {};
  return at;
};

/** A schema with every `$ref` written out, so a reader needs nothing else. Cycles are cut. */
export const inline = (s: Schema | undefined, ix: Index, seen: string[] = []): Schema => {
  if (!s) return {};
  if (s.$ref) {
    const name = s.$ref.split("/").pop() ?? "";
    if (seen.includes(name)) return { description: `(${name}, as above)` };
    return inline(ix.schemas[name], ix, [...seen, name]);
  }
  const many = (list?: Schema[]) => list?.map((x) => inline(x, ix, seen));
  return {
    ...s,
    ...(s.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(s.properties).map(([k, v]) => [k, inline(v, ix, seen)]),
          ),
        }
      : {}),
    ...(s.items ? { items: inline(s.items, ix, seen) } : {}),
    ...(typeof s.additionalProperties === "object"
      ? { additionalProperties: inline(s.additionalProperties, ix, seen) }
      : {}),
    ...(s.oneOf ? { oneOf: many(s.oneOf)! } : {}),
    ...(s.anyOf ? { anyOf: many(s.anyOf)! } : {}),
    ...(s.allOf ? { allOf: many(s.allOf)! } : {}),
  };
};

/** Every property name a body schema mentions, at any depth: what a keyword may be hiding in. */
const propertyNames = (s: Schema | undefined, ix: Index, seen = new Set<Schema>()): string[] => {
  const at = deref(s, ix);
  if (seen.has(at)) return [];
  seen.add(at);
  return [
    ...Object.entries(at.properties ?? {}).flatMap(([k, v]) => [k, ...propertyNames(v, ix, seen)]),
    ...(at.items ? propertyNames(at.items, ix, seen) : []),
    ...[...(at.oneOf ?? []), ...(at.anyOf ?? []), ...(at.allOf ?? [])].flatMap((x) =>
      propertyNames(x, ix, seen),
    ),
  ];
};

/** camelCase and snake_case split apart, so "blueprint" finds blueprint_id and listBlueprints. */
const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
/** "variants" and "variant" should find each other. */
const stem = (w: string) => (w.length > 3 && !w.endsWith("ss") ? w.replace(/s$/, "") : w);

/**
 * Operations matching every keyword, best first. A word in the path or summary counts for more
 * than one buried in a description or a body field. With no keywords, every operation.
 */
export const search = (ix: Index, query: string): Operation[] => {
  const wanted = words(query).map(stem);
  if (!wanted.length) return ix.ops;
  const scored = ix.ops.map((op) => {
    const strong = words(`${op.method} ${op.path} ${op.summary} ${op.tag ?? ""}`).map(stem);
    const weak = words(
      [
        op.description ?? "",
        ...op.params.flatMap((p) => [p.name, p.description ?? ""]),
        ...propertyNames(op.body?.schema, ix),
      ].join(" "),
    ).map(stem);
    let score = 0;
    for (const w of wanted) {
      const hit = (list: string[]) =>
        list.some((x) => x.startsWith(w) || (x.length > 3 && w.startsWith(x)));
      if (hit(strong)) score += 3;
      else if (hit(weak)) score += 1;
      else return { op, score: 0 };
    }
    // Among equals, the shorter path is the more general operation, which is usually the one meant.
    return { op, score: score - op.path.length / 1000 };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.op);
};

export type Resolved = { op: Operation; fromPath: Record<string, string> };

/**
 * The operation a method and path name. The path may be the spec's template
 * (/v1/shops/{shop_id}/products.json, values in path_params) or already filled in
 * (/v1/shops/123/products.json), in which case the values are read back out of it.
 */
export const resolve = (
  ix: Index,
  method: string,
  path: string,
): Resolved | { problem: string } => {
  const m = method.trim().toUpperCase();
  const clean = "/" + (path.trim().split(/[?#]/)[0] ?? "").replace(/^\/+/, "");
  const exact = ix.ops.find((o) => o.method === m && o.path === clean);
  if (exact) return { op: exact, fromPath: {} };
  const fits = ix.ops.filter((o) => o.filled.test(clean)).sort((a, b) => b.literals - a.literals);
  const op = fits.find((o) => o.method === m);
  if (op) {
    const values = clean.match(op.filled)!.slice(1);
    const names = [...op.path.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]!);
    const fromPath: Record<string, string> = {};
    try {
      names.forEach((n, i) => (fromPath[n] = decodeURIComponent(values[i] ?? "")));
    } catch {
      return { problem: `${clean} has a malformed percent-escape.` };
    }
    return { op, fromPath };
  }
  const others = [...new Set(fits.map((o) => o.method))];
  return {
    problem: others.length
      ? `${clean} exists, but not with ${m}: it takes ${others.join(", ")}.`
      : `No operation at ${m} ${clean}. Find one with printify_search; paths look like ` +
        `/v1/shops/{shop_id}/products.json.`,
  };
};

// ─── Validating a call ─────────────────────────────────────────────────────────────────────────

const kind = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
const fitsType = (type: string, v: unknown) => {
  const k = kind(v);
  return type === "number" ? k === "integer" || k === "number" : type === k;
};

export type Findings = { errors: string[]; unknown: string[] };

/**
 * Checks a value against a schema, using the keywords Printify's spec actually uses. `errors`
 * are reasons not to send it. `unknown` are fields the spec does not describe: Printify's spec
 * does not forbid extra fields, so they are passed on, and reported so a typo does not go unseen.
 */
export const check = (schema: Schema | undefined, v: unknown, at: string, ix: Index): Findings => {
  const s = deref(schema, ix);
  const out: Findings = { errors: [], unknown: [] };
  const bad = (msg: string) => void out.errors.push(`${at}: ${msg}`);
  const merge = (f: Findings) => {
    out.errors.push(...f.errors);
    out.unknown.push(...f.unknown);
  };
  if (v === null) {
    if (!s.nullable && s.type && s.type !== "null") bad(`must be ${s.type}, not null`);
    return out;
  }
  for (const part of s.allOf ?? []) merge(check(part, v, at, ix));
  const alternatives = s.oneOf ?? s.anyOf;
  if (alternatives?.length) {
    // Printify's alternatives overlap (a line item by product, by blueprint or by SKU), so one
    // fitting is enough; when none does, the closest one's complaints are the useful ones.
    const tried = alternatives.map((a) => check(a, v, at, ix));
    const best = tried.reduce((a, b) => (b.errors.length < a.errors.length ? b : a));
    if (best.errors.length)
      bad(
        `fits none of the ${alternatives.length} accepted shapes. Closest: ` +
          best.errors.join("; "),
      );
    else out.unknown.push(...best.unknown);
  }
  const type = s.type ?? (s.properties ? "object" : s.items ? "array" : undefined);
  if (type && !fitsType(type, v)) {
    bad(`must be ${type}, got ${kind(v)}`);
    return out;
  }
  if (s.enum && !s.enum.includes(v))
    bad(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) bad(`must be at least ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) bad(`must be at most ${s.maximum}`);
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength)
      bad(`must be at least ${s.minLength} characters`);
    if (s.maxLength !== undefined && v.length > s.maxLength)
      bad(`must be at most ${s.maxLength} characters, is ${v.length}`);
    if (s.format === "uri" && !URL.canParse(v)) bad("must be an absolute URL");
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems)
      bad(`needs at least ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems)
      bad(`takes at most ${s.maxItems} items, has ${v.length}`);
    if (s.items) v.forEach((item, i) => merge(check(s.items, item, `${at}[${i}]`, ix)));
  } else if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    for (const name of s.required ?? [])
      if (obj[name] === undefined) bad(`is missing required "${name}"`);
    for (const [name, value] of Object.entries(obj)) {
      if (value === undefined) continue;
      const prop = s.properties?.[name];
      if (prop) merge(check(prop, value, `${at}.${name}`, ix));
      else if (typeof s.additionalProperties === "object")
        merge(check(s.additionalProperties, value, `${at}.${name}`, ix));
      else if (s.additionalProperties === false) bad(`does not take "${name}"`);
      else if (s.properties) out.unknown.push(`${at}.${name}`);
    }
  }
  return out;
};

/**
 * A path or query value arrives as whatever JSON type the caller found natural, and leaves in a
 * URL, so `5`, `"5"` and (for a "0"/"1" flag) `1` are all acceptable ways to say the same thing.
 * Returns the value as the schema types it, or the original for `check` to complain about.
 */
const coerce = (schema: Schema, v: unknown, ix: Index): unknown => {
  const s = deref(schema, ix);
  if ((s.type === "integer" || s.type === "number") && typeof v === "string") {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) ? n : v;
  }
  if (s.type === "string" && (typeof v === "number" || typeof v === "boolean")) return String(v);
  if (s.type === "boolean" && (v === "true" || v === "false")) return v === "true";
  return v;
};

export type Checked = {
  errors: string[];
  unknown: string[];
  /** The path with its placeholders filled, and the query string appended. Empty on error. */
  target: string;
  /** The same, without the query string: what a result restates as "the path". */
  path: string;
  query: Record<string, string>;
};

/** Everything about a call that the spec can judge, before a byte is sent. */
export const checkCall = (
  ix: Index,
  { op, fromPath }: Resolved,
  given: { pathParams?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown },
): Checked => {
  const errors: string[] = [];
  const unknown: string[] = [];
  const add = (f: Findings) => {
    errors.push(...f.errors);
    unknown.push(...f.unknown);
  };

  const inPath = op.params.filter((p) => p.in === "path");
  const values: Record<string, unknown> = { ...fromPath, ...given.pathParams };
  for (const name of Object.keys(given.pathParams ?? {})) {
    if (!inPath.some((p) => p.name === name))
      errors.push(
        `path_params.${name}: ${op.path} has no such placeholder` +
          (inPath.length ? ` (it has ${inPath.map((p) => p.name).join(", ")})` : ""),
      );
    else if (name in fromPath && String(fromPath[name]) !== String(given.pathParams![name]))
      errors.push(`path_params.${name}: the path already says ${fromPath[name]}`);
  }
  let path = op.path;
  for (const p of inPath) {
    const raw = values[p.name];
    if (raw === undefined || raw === null || raw === "") {
      errors.push(`path_params.${p.name}: required by ${op.path}`);
      continue;
    }
    const v = coerce(p.schema, raw, ix);
    add(check(p.schema, v, `path_params.${p.name}`, ix));
    const text = String(v);
    if (typeof v === "object" || /^\.{1,2}$/.test(text) || /[/\\?#\s]/.test(text))
      errors.push(`path_params.${p.name}: must be a plain ID`);
    path = path.replace(`{${p.name}}`, encodeURIComponent(text));
  }

  const inQuery = op.params.filter((p) => p.in === "query");
  const query: Record<string, string> = {};
  for (const [name, raw] of Object.entries(given.query ?? {})) {
    if (raw === undefined || raw === null) continue;
    const p = inQuery.find((q) => q.name === name);
    if (!p) {
      errors.push(
        `query.${name}: ${op.method} ${op.path} takes ` +
          (inQuery.length
            ? `only ${inQuery.map((q) => q.name).join(", ")}`
            : "no query parameters"),
      );
      continue;
    }
    const v = coerce(p.schema, raw, ix);
    add(check(p.schema, v, `query.${name}`, ix));
    if (typeof v === "object") errors.push(`query.${name}: must be a single value`);
    query[name] = String(v);
  }
  for (const p of inQuery)
    if (p.required && !(p.name in query)) errors.push(`query.${p.name}: required`);

  if (given.body !== undefined && !op.body)
    errors.push(`body: ${op.method} ${op.path} takes no body`);
  // A body left out is judged as an empty one, so "you forgot the body" names what it needs.
  else if (op.body) add(check(op.body.schema, given.body ?? {}, "body", ix));

  const qs = new URLSearchParams(query).toString();
  return { errors, unknown, path, target: errors.length ? "" : path + (qs ? `?${qs}` : ""), query };
};
