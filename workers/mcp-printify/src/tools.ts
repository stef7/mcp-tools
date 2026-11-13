/**
 * The three tools, and the rules about what may be sent.
 *
 *   GET                 runs freely
 *   anything else       needs `confirm: true`, and the result restates what was sent
 *   the BLOCKED list    refused outright unless PRINTIFY_ALLOW_DESTRUCTIVE is "true"
 *
 * Every failure (a spec that will not load, a call the spec rejects, Printify saying no, the
 * network) comes back as a tool result with isError set. Nothing is thrown.
 */
import { tool, type Ctx, type Result, type Tools } from "../../../core/mcp";
import { NO_TOKEN, explain, send } from "./printify";
import {
  checkCall,
  inline,
  loadSpec,
  resolve,
  search,
  type Index,
  type Loaded,
  type Operation,
} from "./spec";

export const ALLOW = "PRINTIFY_ALLOW_DESTRUCTIVE";
const UPLOAD = "/v1/uploads/images.json";
/** Past this, a result is cut down: a catalogue listing runs to megabytes. */
const MAX_CHARS = 60_000;

/**
 * What stays off unless the variable says otherwise, written as rules rather than a list of
 * paths so that an endpoint Printify adds later lands on the safe side: every DELETE, every
 * write under /webhooks, every write to an order (placing, producing, cancelling, refunding,
 * reprinting, readdressing), unpublishing a product and archiving an upload. The one order
 * endpoint left open is the shipping calculator, which is a POST that changes nothing.
 */
export const blocked = (op: Pick<Operation, "method" | "path">): string | null => {
  if (op.method === "GET") return null;
  const p = op.path;
  if (/\/webhooks(\.json|\/|$)/.test(p)) return "changes webhooks";
  if (op.method === "DELETE")
    return p.endsWith("/connection.json")
      ? "disconnects (deletes) a shop"
      : /\/products\/[^/]+\.json$/.test(p)
        ? "deletes a product"
        : "deletes something";
  if (/\/orders(\.json|\/)/.test(p) && !p.endsWith("/orders/shipping.json"))
    return /\/orders(\/express)?\.json$/.test(p)
      ? "creates an order"
      : p.endsWith("/send_to_production.json")
        ? "sends an order to production"
        : p.endsWith("/cancel.json")
          ? "cancels an order or one of its line items"
          : p.endsWith("/support-requests/refund")
            ? "requests a refund"
            : p.endsWith("/support-requests/reprint")
              ? "requests a reprint"
              : /address[-_]change/.test(p)
                ? "changes an order's delivery address"
                : "changes an order";
  if (p.endsWith("/unpublish.json")) return "unpublishes a product";
  if (/\/uploads\/[^/]+\/archive\.json$/.test(p)) return "archives an uploaded image";
  return null;
};

const allowed = (env: Env) => env[ALLOW] === "true";
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });
const done = (v: unknown): Result => ({
  content: [{ type: "text", text: JSON.stringify(v, null, 2) }],
});
const specDown = (problem: string) =>
  fail(`mcp-printify cannot read its copy of Printify's API description. ${problem}`);

/** How an operation is shown: enough to build a correct printify_call from, and no more. */
const describe = (op: Operation, ix: Index, env: Env, full: boolean) => {
  const why = blocked(op);
  const rule =
    op.method === "GET"
      ? "runs freely"
      : why && !allowed(env)
        ? `blocked: ${why}. Off unless ${ALLOW} is "true".`
        : "needs confirm: true";
  if (!full) return `${op.method} ${op.path}  ${op.summary}  [${rule}]`;
  return {
    method: op.method,
    path: op.path,
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(op.deprecated ? { deprecated: true } : {}),
    rule,
    parameters: op.params.map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required,
      ...(p.description ? { description: p.description } : {}),
      schema: inline(p.schema, ix),
    })),
    ...(op.body
      ? {
          body: {
            schema: inline(op.body.schema, ix),
            ...(op.body.example === undefined ? {} : { example: op.body.example }),
          },
        }
      : {}),
  };
};

// ─── Shrinking a response to what was asked for ────────────────────────────────────────────────

type Shaping = { find?: string | undefined; fields?: string[] | undefined };

/**
 * The list inside a response: the response itself (shops, blueprints), the `data` of a paginated
 * one (products, orders), or the one array a small wrapper exists to carry (a provider's
 * `{ id, title, variants }`). A product has a `variants` array too, but it is a single thing with
 * many fields, and is left whole.
 */
const listIn = (data: unknown): { items: unknown[]; put(items: unknown[]): unknown } | null => {
  if (Array.isArray(data)) return { items: data, put: (items) => items };
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const arrays = Object.keys(obj).filter((k) => Array.isArray(obj[k]));
  const key = Array.isArray(obj["data"])
    ? "data"
    : arrays.length === 1 && Object.keys(obj).length <= 3
      ? arrays[0]
      : undefined;
  return key ? { items: obj[key] as unknown[], put: (items) => ({ ...obj, [key]: items }) } : null;
};

const pick = (item: unknown, fields: string[]) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(fields.filter((f) => f in item).map((f) => [f, (item as never)[f]]))
    : item;

/**
 * Applies `find` and `fields`, then cuts a list that is still too long to hand back. The notes
 * say what was left out, so a short answer is never mistaken for a complete one.
 */
export const shape = (data: unknown, { find, fields }: Shaping, max = MAX_CHARS) => {
  const notes: string[] = [];
  const list = listIn(data);
  if (!list) {
    if (find) notes.push("find was ignored: the response is not a list.");
    const one = fields?.length ? pick(data, fields) : data;
    const size = JSON.stringify(one ?? null).length;
    if (size <= max) return { data: one, notes };
    notes.push(`The response is ${size} characters; only the start is shown. Use fields.`);
    return { data: JSON.stringify(one).slice(0, max) + "…", notes };
  }
  let items = list.items;
  const total = items.length;
  if (find) {
    const needle = find.toLowerCase();
    items = items.filter((i) => JSON.stringify(i).toLowerCase().includes(needle));
    notes.push(`find "${find}" kept ${items.length} of ${total} items.`);
  }
  if (fields?.length) items = items.map((i) => pick(i, fields));
  const kept = items.length;
  while (items.length > 1 && JSON.stringify(items).length > max)
    items = items.slice(0, Math.ceil(items.length / 2));
  if (items.length < kept)
    notes.push(
      `Too long to show in full: the first ${items.length} of ${kept} items are here. ` +
        "Narrow it with find (text an item must contain) or fields (the keys to keep).",
    );
  return { data: list.put(items), notes };
};

// ─── The tools ─────────────────────────────────────────────────────────────────────────────────

type CallArgs = {
  method: string;
  path: string;
  path_params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  confirm?: boolean;
  find?: string;
  fields?: string[];
};

/** Runs one operation: resolve, refuse what is blocked, validate, ask, send, restate. */
const run = async (ix: Index, args: CallArgs, c: Ctx): Promise<Result> => {
  if (typeof args.method !== "string" || typeof args.path !== "string")
    return fail("printify_call needs a method and a path. Find them with printify_search.");
  const found = resolve(ix, args.method, args.path);
  if ("problem" in found) return fail(found.problem);
  const { op } = found;
  const name = `${op.method} ${op.path}`;

  const why = blocked(op);
  if (why && !allowed(c.env))
    return fail(
      `Refused: ${name} ${why}. That is blocked on this connector unless the ${ALLOW} ` +
        `variable on the worker is "true", and it is not. Nothing was sent to Printify.`,
    );

  const checked = checkCall(ix, found, {
    ...(args.path_params ? { pathParams: args.path_params } : {}),
    ...(args.query ? { query: args.query } : {}),
    ...(args.body === undefined ? {} : { body: args.body }),
  });
  if (checked.errors.length)
    return fail(
      `${name} was not sent: it does not match Printify's API description.\n` +
        checked.errors.map((e) => `- ${e}`).join("\n") +
        `\nprintify_search shows the parameters and body this operation takes.`,
    );

  const sent = {
    method: op.method,
    path: checked.path,
    ...(Object.keys(checked.query).length ? { query: checked.query } : {}),
    ...(args.body === undefined ? {} : { body: args.body }),
  };
  if (op.method !== "GET" && args.confirm !== true)
    return fail(
      `${name} changes the Printify account, so it needs confirm: true. Nothing was sent. ` +
        "Show the user exactly this request, and call again with confirm: true once they " +
        `agree:\n${JSON.stringify(sent, null, 2)}`,
    );

  const res = await send(c.env, ix.server, op.method, checked.target, args.body);
  if ("problem" in res) return fail(res.problem);
  const notes = [
    ...(checked.unknown.length
      ? [
          `Sent as given, but not in Printify's API description: ${checked.unknown.join(", ")}. ` +
            "Printify may have ignored them; check for a typo.",
        ]
      : []),
    ...(res.retried
      ? [`Printify rate-limited this; it went through on try ${res.retried + 1}.`]
      : []),
  ];
  if (!res.ok)
    return fail(
      `${explain(res)}\nSent: ${JSON.stringify(sent)}` +
        (notes.length ? `\n${notes.join("\n")}` : ""),
    );
  const shaped = shape(res.data, { find: args.find, fields: args.fields });
  notes.push(...shaped.notes);
  return done({
    sent,
    status: res.status,
    ...(notes.length ? { notes } : {}),
    response: shaped.data,
  });
};

/** The tools, over whichever spec `load` yields. The tests hand in one that fails. */
export const printifyTools = (load: () => Loaded = loadSpec): Tools => ({
  search: tool({
    description:
      "Search Printify's API description for operations by keyword: 'shops', 'blueprints', " +
      "'variants', 'shipping', 'create product', 'publish', 'orders', 'upload'. Returns each " +
      "match's method, path, summary, parameters and request-body schema (with an example), " +
      "which is what printify_call needs. Leave query empty to list every operation in one " +
      "line each.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords; an operation must match all of them." },
        limit: { type: "integer", description: "Most matches to return in full (default 5)." },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: ({ query, limit }, c) => {
      const ix = load();
      if ("problem" in ix) return specDown(ix.problem);
      const hits = search(ix, query ?? "");
      if (!query?.trim())
        return [`${hits.length} operations (${ix.origin}):`]
          .concat(hits.map((op) => describe(op, ix, c.env, false) as string))
          .join("\n");
      if (!hits.length)
        return fail(
          `No operation matches "${query}". Try fewer or different words, or an empty query ` +
            "to list them all.",
        );
      const n = Math.min(Math.max(limit ?? 5, 1), 20);
      return done({
        matches: hits.slice(0, n).map((op) => describe(op, ix, c.env, true)),
        ...(hits.length > n
          ? { more: hits.slice(n).map((op) => describe(op, ix, c.env, false)) }
          : {}),
      });
    },
  }),

  call: {
    description:
      "Run one Printify API operation, by method and path as printify_search gives them. " +
      "Path parameters, query and body are checked against Printify's API description before " +
      "anything is sent. GET runs freely. Any other method changes the account: it needs " +
      "confirm: true, set only once the user has agreed to this exact request, and the result " +
      "restates the method, path and body sent. Creating orders, sending them to production, " +
      "cancelling, refunding, reprinting or readdressing them, deleting or unpublishing a " +
      `product, deleting a shop, archiving an upload and changing webhooks are refused unless ${ALLOW} is ` +
      "enabled on the worker. Prices are in cents. Lists can be huge (the blueprint catalogue " +
      "is over a thousand items): use find and fields.",
    input: {
      type: "object",
      required: ["method", "path"],
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: {
          type: "string",
          description:
            "The path, as the template (/v1/shops/{shop_id}/products.json, with path_params) " +
            "or filled in (/v1/shops/123/products.json).",
        },
        path_params: {
          type: "object",
          description: 'Values for the {placeholders} in path, e.g. {"shop_id": 123}.',
          additionalProperties: true,
        },
        query: {
          type: "object",
          description: 'Query parameters the operation accepts, e.g. {"page": 2, "limit": 20}.',
          additionalProperties: true,
        },
        body: { type: "object", description: "The JSON body, for operations that take one." },
        confirm: {
          type: "boolean",
          description:
            "Required and true for anything but GET. Set it only once the user has agreed to " +
            "this exact request.",
        },
        find: {
          type: "string",
          description:
            "Keep only the items of a list response that contain this text, in any field, " +
            'ignoring case: "Bumper Stickers" on the blueprint list.',
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description: 'Keep only these keys of each item (or of a single object): ["id","title"].',
        },
      },
    },
    // It can write, and with the variable on it can delete; a client should treat it as such.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: (args: CallArgs, c: Ctx) => {
      const ix = load();
      return "problem" in ix ? specDown(ix.problem) : run(ix, args, c);
    },
  },

  upload_image: {
    description:
      "Upload artwork to the Printify media library from a URL. Printify fetches the URL " +
      "itself, so it must be publicly reachable (PNG, JPEG or SVG). Returns the image's id, " +
      "which goes in a product's print_areas[].placeholders[].images[].id. Adds to the " +
      "account, so it needs confirm: true once the user has agreed.",
    input: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Public https URL of the image." },
        file_name: {
          type: "string",
          description: "Name to store it under, with its extension. Defaults to the URL's own.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true. Set it only once the user has agreed to this upload.",
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (args: { url: string; file_name?: string; confirm?: boolean }, c: Ctx) => {
      const ix = load();
      if ("problem" in ix) return specDown(ix.problem);
      let url: URL;
      try {
        url = new URL(String(args.url));
      } catch {
        return fail(`"${args.url}" is not an absolute URL.`);
      }
      if (!/^https?:$/.test(url.protocol)) return fail("The image URL must be http or https.");
      const fromUrl = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const file_name = args.file_name?.trim() || fromUrl || "image.png";
      return run(
        ix,
        {
          method: "POST",
          path: UPLOAD,
          body: { file_name, url: url.href },
          ...(args.confirm === undefined ? {} : { confirm: args.confirm }),
        },
        c,
      );
    },
  },
});

/** What the GET page says: is the spec readable, is there a token, does Printify answer. */
export const report = async (c: Ctx, load: () => Loaded = loadSpec) => {
  const ix = load();
  const out: Record<string, string> = {
    spec: "problem" in ix ? `FAILED. ${ix.problem}` : `${ix.ops.length} operations. ${ix.origin}`,
    token: c.env.PRINTIFY_TOKEN?.trim() ? "PRINTIFY_TOKEN is set." : NO_TOKEN,
    destructive: allowed(c.env)
      ? `ALLOWED: ${ALLOW} is "true". Order writes, deletions, unpublishing, archiving and webhook changes run once confirmed.`
      : `Blocked: ${ALLOW} is not "true". No order writes, deletions, unpublishing, archiving or webhook changes.`,
  };
  if ("problem" in ix || !c.env.PRINTIFY_TOKEN?.trim()) return out;
  try {
    const res = await send(c.env, ix.server, "GET", "/v1/shops.json");
    out["printify"] =
      "problem" in res
        ? res.problem
        : res.ok
          ? `Reachable. The token sees ${Array.isArray(res.data) ? res.data.length : "?"} shop(s).`
          : explain(res);
  } catch (e) {
    out["printify"] = `The check itself failed: ${e instanceof Error ? e.message : e}`;
  }
  return out;
};
