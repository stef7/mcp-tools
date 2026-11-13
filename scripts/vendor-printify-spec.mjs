#!/usr/bin/env node
/**
 * Builds workers/mcp-printify/src/spec.json: Printify's published OpenAPI document, cut down to
 * what mcp-printify needs to search operations and validate a call before sending it. The worker
 * imports the result, so the spec rides in the bundle and is never fetched per request.
 *
 *   node scripts/vendor-printify-spec.mjs               from developers.printify.com
 *   node scripts/vendor-printify-spec.mjs openapi.json  from a copy already downloaded
 *
 * Kept: every operation's method, path, summary, description, tag, parameters and request body
 * (with its first example), and the schemas those reach. Dropped: responses, webhook event
 * payloads, schema examples, security blocks and the second server (enterprise.printful.com,
 * which this worker does not talk to). What is kept stays OpenAPI-shaped, `$ref`s included, so
 * the worker resolves it the way any reader of the original would.
 *
 * Re-run it when Printify changes its API, read the diff, and commit the result.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "https://developers.printify.com/openapi.json";
const OUT = "workers/mcp-printify/src/spec.json";
const METHODS = ["get", "post", "put", "patch", "delete"];

const from = process.argv[2];
const raw = from
  ? readFileSync(from, "utf8")
  : await fetch(SOURCE, { headers: { "User-Agent": "mcp-printify-vendor" } }).then((r) => {
      if (!r.ok) throw new Error(`${SOURCE} answered HTTP ${r.status}`);
      return r.text();
    });
const doc = JSON.parse(raw);
if (!/^3\./.test(doc.openapi ?? "")) throw new Error(`Not OpenAPI 3: openapi=${doc.openapi}`);
if (!doc.paths || !Object.keys(doc.paths).length) throw new Error("The document has no paths.");

/** A copy without `example`/`examples`, at any depth. A property *named* example survives. */
const bare = (v, inProps = false) => {
  if (Array.isArray(v)) return v.map((x) => bare(x));
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => inProps || (k !== "example" && k !== "examples"))
      .map(([k, x]) => [k, bare(x, !inProps && k === "properties")]),
  );
};

const components = { parameters: {}, requestBodies: {}, schemas: {} };
/** Copies everything a `$ref` reaches into `components`, once. */
const reach = (v) => {
  if (Array.isArray(v)) return v.forEach(reach);
  if (!v || typeof v !== "object") return;
  if (typeof v.$ref === "string") {
    const [, , section, name] = v.$ref.split("/");
    if (!(section in components)) throw new Error(`Unexpected $ref target: ${v.$ref}`);
    if (name in components[section]) return;
    const target = doc.components?.[section]?.[name];
    if (!target) throw new Error(`Dangling $ref: ${v.$ref}`);
    components[section][name] = section === "requestBodies" ? body(target) : bare(target);
    return reach(components[section][name]);
  }
  Object.values(v).forEach(reach);
};

/** A request body keeps its schema and the first example, which shows a call that works. */
const body = (b) => ({
  ...(b.description ? { description: b.description } : {}),
  ...(b.required ? { required: true } : {}),
  content: Object.fromEntries(
    Object.entries(b.content ?? {}).map(([type, c]) => {
      const example = c.example ?? Object.values(c.examples ?? {})[0]?.value;
      return [type, { schema: bare(c.schema), ...(example === undefined ? {} : { example }) }];
    }),
  ),
});

const paths = {};
for (const [path, item] of Object.entries(doc.paths)) {
  const kept = {};
  if (item.parameters) kept.parameters = bare(item.parameters);
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    kept[method] = {
      ...(op.operationId ? { operationId: op.operationId } : {}),
      ...(op.summary ? { summary: op.summary } : {}),
      ...(op.description && op.description !== op.summary ? { description: op.description } : {}),
      ...(op.tags ? { tags: op.tags } : {}),
      ...(op.deprecated ? { deprecated: true } : {}),
      ...(op.parameters ? { parameters: bare(op.parameters) } : {}),
      ...(op.requestBody
        ? { requestBody: op.requestBody.$ref ? op.requestBody : body(op.requestBody) }
        : {}),
    };
  }
  paths[path] = kept;
}
reach(paths);

const out = {
  openapi: doc.openapi,
  info: { title: doc.info?.title, version: doc.info?.version },
  "x-vendored": {
    source: SOURCE,
    retrieved: new Date().toISOString().slice(0, 10),
    // Of the document as published, so a later run says at a glance whether anything moved.
    sha256: createHash("sha256").update(raw).digest("hex"),
    by: "scripts/vendor-printify-spec.mjs",
  },
  servers: doc.servers?.slice(0, 1),
  paths,
  components,
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
const count = Object.values(paths).flatMap((p) => METHODS.filter((m) => p[m])).length;
console.log(
  `${OUT}: ${count} operations, ${Object.keys(components.schemas).length} schemas, ` +
    `${(JSON.stringify(out).length / 1024).toFixed(0)} KB (from ${(raw.length / 1024).toFixed(0)} KB)`,
);
