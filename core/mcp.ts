/**
 * Shared MCP plumbing. A worker is just `export default mcpWorker({ ...wranglerConfig, tools })`.
 *
 *  - `fetch`  : stateless Streamable-HTTP MCP endpoint (POST JSON-RPC, GET = info page)
 *  - `tools()` and `call()` : the same tools over RPC, so another worker can aggregate them
 *
 * Every tool name is prefixed with the worker's own name (`mcp-wp` -> `wp_`). A worker that
 * lists `services` in its wrangler config re-exports the tools of each bound worker, routing
 * calls by that prefix. `?tools=wp,acast_episodes` on the connector URL narrows the list
 * (an entry is a prefix or an exact tool name). The whole query string is forwarded to bound
 * workers, so each can read its own params (mcp-wp reads `?wp=site1,site2`).
 */
import { WorkerEntrypoint } from "cloudflare:workers";

// ─── JSON Schema -> TypeScript, just the subset MCP tools use ──────────────────────────────────
export type JSONSchema = {
  type?: string | readonly string[];
  description?: string;
  enum?: readonly unknown[];
  default?: unknown;
  properties?: Record<string, JSONSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JSONSchema;
  items?: JSONSchema;
  minimum?: number;
  maximum?: number;
};
type Prim = { string: string; number: number; integer: number; boolean: boolean; null: null };
type Flat<T> = { [K in keyof T]: T[K] } & {};
type Props<S> = S extends { properties: infer P } ? P : {};
type Req<S> = S extends { required: readonly (infer R)[] } ? R : never;
type Extra<S> = S extends { additionalProperties: infer A extends JSONSchema }
  ? Record<string, FromSchema<A>>
  : {};
type Obj<S> = Flat<
  { [K in keyof Props<S> as K extends Req<S> ? K : never]: FromSchema<Props<S>[K]> } & {
    [K in keyof Props<S> as K extends Req<S> ? never : K]?: FromSchema<Props<S>[K]>;
  } & Extra<S>
>;
/** The argument type a schema describes. */
export type FromSchema<S> = S extends { enum: readonly (infer E)[] }
  ? E
  : S extends { type: "array"; items: infer I }
    ? FromSchema<I>[]
    : S extends { type: "object" }
      ? Obj<S>
      : S extends { type: infer T extends keyof Prim }
        ? Prim[T]
        : S extends { type: readonly (infer T extends keyof Prim)[] }
          ? Prim[T]
          : unknown;

/**
 * What a tool's `run` receives besides its args: bindings, connector query string, exec ctx, and
 * who is signed in. `email()` is the Cloudflare Access identity, or undefined when Access is off.
 */
export type Ctx = {
  env: Env;
  params: URLSearchParams;
  exec: ExecutionContext;
  email(): Promise<string | undefined>;
  /**
   * The custom headers the connector sent, by lower-cased name. Connectors allow a handful, which
   * is how someone supplies a credential of their own without anything being stored here.
   */
  headers: Record<string, string>;
};

type Annotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** One tool. `run` may return a string, any JSON value, or a full MCP `{ content, isError }`. */
export type Tool<S extends JSONSchema = JSONSchema> = {
  description: string;
  /** JSON Schema of the arguments. Omit for "no arguments". */
  input?: S;
  annotations?: Annotations;
  /**
   * Anything that changes the world: adds a required `user_confirmed`, enforces it, and says so
   * in the description. `true` uses the worker's `confirmNote`; a string says it for this tool,
   * which is worth doing when "changes data" undersells what will happen.
   */
  confirm?: boolean | string;
  run(args: FromSchema<S>, c: Ctx): unknown;
};

/** Tools keyed by (unprefixed) name. The key *is* the name; nothing to keep in sync. */
export type Tools = Record<string, { run(args: never, c: Ctx): unknown } & Omit<Tool, "run">>;

/** Gives `run` typed args from `input` without writing the shape twice. */
export const tool = <const S extends JSONSchema>(t: Tool<S>) => t;

export type Spec = {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  annotations: Annotations;
};
export type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

/** `initialize` extras: everything but `instructions` goes into `serverInfo`. */
type Icon = { src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" };
type Info = {
  title?: string;
  description?: string;
  /** Clients need only render png, jpeg, svg and webp, and prefer same-domain or data: URIs. */
  icons?: Icon[];
  websiteUrl?: string;
  instructions?: string;
};

type Config = {
  name: string;
  /**
   * What every tool name here starts with. Defaults to the worker's own name (`mcp-wp` gives
   * `wp_`). Set it to "" for a worker whose tools should read as their own thing rather than as
   * part of a set — mcp-toolkit does, so its local tools are `acast_episodes`, not
   * `toolkit_acast_episodes`. Bound workers keep their own prefixes either way.
   */
  prefix?: string;
  version?: string;
  services?: { binding: string; service: string }[];
  tools: Tools | ((c: Ctx) => Tools | Promise<Tools>);
  info?: (c: Ctx) => Info;
  /** What `confirm: true` appends to a description. Per-tool strings override it. */
  confirmNote?: string;
  /** Extra detail for the GET page: whatever a human opening the URL in a browser needs. */
  status?: (c: Ctx) => unknown | Promise<unknown>;
};

/**
 * Everything a call needs beyond its arguments: the connector's query string and the signed-in
 * user. Access does not propagate its identity over service bindings, so the worker facing the
 * browser resolves the email once and passes it on with every RPC.
 */
type Call = {
  search?: string | undefined;
  email?: string | undefined;
  /** Forwarded custom headers; see `carried` for which ones, and why not all of them. */
  headers?: Record<string, string> | undefined;
};

/**
 * The request headers worth passing on: the `x-` ones a connector was configured with. Cookies,
 * the Access assertion and the proxy's own forwarding headers are none of a tool's business, and
 * a bound worker that receives them can leak them somewhere this one cannot see.
 */
const PROXY_HEADERS = new Set([
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
]);
export const carried = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith("x-") && !PROXY_HEADERS.has(name)) out[name] = value;
  });
  return out;
};

/** What a bound worker looks like over RPC (it is another `mcpWorker`). */
type Remote = {
  tools(req: Call): Promise<Spec[]>;
  call(name: string, args: unknown, req: Call): Promise<Result>;
};
type Msg = { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
/** `ctx.access` exists only when Cloudflare Access authenticated this very invocation. */
type WithAccess = { access?: { getIdentity(): Promise<{ email?: string } | null> } };

const prefixOf = (workerName: string) => workerName.replace(/^mcp-/, "").replaceAll("-", "_") + "_";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // `*` covers the custom x- headers a connector may send; Authorization is named because the
  // wildcard deliberately does not cover it.
  "Access-Control-Allow-Headers": "Authorization, *",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
const err = (message: string): Result => ({
  content: [{ type: "text", text: message }],
  isError: true,
});
const isResult = (v: unknown): v is Result => typeof v === "object" && v !== null && "content" in v;
const DEFAULT_NOTE = "Changes data rather than only reading it.";

const CONFIRM = {
  type: "boolean",
  description: "Must be true. Set it only once the user has agreed to this exact change.",
} as const;
/** Adds the confirmation argument to a write tool's schema, so the client knows to ask. */
const withConfirm = (input: JSONSchema = { type: "object", properties: {} }): JSONSchema => ({
  ...input,
  properties: { ...input.properties, user_confirmed: CONFIRM },
  required: [...(input.required ?? []), "user_confirmed"],
});

export const mcpWorker = (cfg: Config) => {
  const prefix = cfg.prefix ?? prefixOf(cfg.name);
  /** What this tool warns about, in the description and again if it is called unconfirmed. */
  const note = (confirm: boolean | string | undefined) =>
    typeof confirm === "string" ? confirm : (cfg.confirmNote ?? DEFAULT_NOTE);
  const local = (c: Ctx) => (typeof cfg.tools === "function" ? cfg.tools(c) : cfg.tools);

  return class extends WorkerEntrypoint<Env> {
    /** Resolved at most once per request, and only if a tool actually asks who is signed in. */
    #email = (given?: string) => {
      let asked: Promise<string | undefined> | undefined;
      return () =>
        (asked ??= given
          ? Promise.resolve(given)
          : Promise.resolve((this.ctx as WithAccess).access?.getIdentity()).then((i) => i?.email));
    };
    #ctx = ({ search, email, headers }: Call): Ctx => ({
      env: this.env,
      params: new URLSearchParams(search),
      exec: this.ctx,
      email: this.#email(email),
      headers: headers ?? {},
    });
    /** Bound workers that failed during this request, reported on the GET page. */
    #unreachable: string[] = [];
    #remotes = () =>
      (cfg.services ?? [])
        .map((s) => ({
          prefix: prefixOf(s.service),
          rpc: (this.env as unknown as Record<string, unknown>)[s.binding] as Remote,
        }))
        .sort((a, b) => b.prefix.length - a.prefix.length);

    /** Every tool this worker offers: its own, then each bound worker's. */
    async tools(req: Call = {}): Promise<Spec[]> {
      const c = this.#ctx(req);
      const sel = c.params.get("tools")?.split(",");
      const own = Object.entries(await local(c)).map(([k, t]) => ({
        name: prefix + k,
        description: t.confirm ? `${t.description} ${note(t.confirm)}` : t.description,
        // Clients group tools by these, so they follow `confirm` rather than being restated.
        annotations: {
          readOnlyHint: !t.confirm,
          destructiveHint: !!t.confirm,
          openWorldHint: true,
          ...t.annotations,
        },
        inputSchema: t.confirm
          ? withConfirm(t.input)
          : (t.input ?? { type: "object", properties: {} }),
      }));
      const wantedRemotes = this.#remotes().filter(
        (r) => !sel || sel.some((s) => (s + "_").startsWith(r.prefix)),
      );
      const onward = wantedRemotes.length ? await this.#pass(req) : req;
      // One bound worker being down should cost its own tools, not everybody else's, so a
      // failure is recorded for the GET page and skipped rather than thrown. The callback is
      // async so that a binding that is missing outright throws into the promise, not out of
      // the map.
      const asked = await Promise.allSettled(wantedRemotes.map(async (r) => r.rpc.tools(onward)));
      const remote = asked.flatMap((r, i) => {
        if (r.status === "fulfilled") return r.value;
        const name = wantedRemotes[i]!.prefix.slice(0, -1);
        this.#unreachable.push(
          `${name}: ${r.reason instanceof Error ? r.reason.message : r.reason}`,
        );
        return [];
      });
      return [...own, ...remote].filter(
        (t) => !sel || sel.some((s) => t.name === s || t.name.startsWith(s + "_")),
      );
    }

    async call(name: string, args: unknown = {}, req: Call = {}): Promise<Result> {
      const c = this.#ctx(req);
      const own = name.startsWith(prefix) && (await local(c))[name.slice(prefix.length)];
      if (own) {
        if (own.confirm && (args as { user_confirmed?: unknown })?.user_confirmed !== true) {
          const why = note(own.confirm);
          return err(`${name}: ${why} Confirm with the user, then pass user_confirmed.`);
        }
        try {
          const v = await own.run(args as never, c);
          return isResult(v) ? v : { content: [{ type: "text", text: text(v) }] };
        } catch (e) {
          return err(`Error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const r = this.#remotes().find((r) => name.startsWith(r.prefix));
      return r ? r.rpc.call(name, args, await this.#pass(req)) : err(`Unknown tool: ${name}`);
    }

    /** Resolve the identity before handing the request on: RPC cannot see Access itself. */
    #pass = async (req: Call): Promise<Call> => ({ ...req, email: await this.#ctx(req).email() });

    override async fetch(request: Request): Promise<Response> {
      const req: Call = { search: new URL(request.url).search, headers: carried(request.headers) };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (request.method === "GET") {
        const tools = (await this.tools(req)).map((t) => t.name);
        return json({
          name: cfg.name,
          version: cfg.version,
          endpoint: "POST JSON-RPC here",
          tools,
          ...(this.#unreachable.length ? { unreachable: this.#unreachable } : {}),
          ...(cfg.status ? { status: await cfg.status(this.#ctx(req)) } : {}),
        });
      }
      if (request.method !== "POST")
        return new Response("POST only", { status: 405, headers: CORS });
      const body = (await request.json().catch(() => null)) as Msg | Msg[] | null;
      if (!body)
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          400,
        );
      const out = (await Promise.all([body].flat().map((m) => this.#rpc(m, req)))).filter(Boolean);
      if (!out.length) return new Response(null, { status: 202, headers: CORS });
      return json(Array.isArray(body) ? out : out[0]);
    }

    async #rpc({ id, method, params }: Msg, req: Call) {
      if (id == null) return null; // a notification: nothing to answer
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
      const fail = (code: number, message: string) => ({
        jsonrpc: "2.0",
        id,
        error: { code, message },
      });
      try {
        switch (method) {
          case "initialize": {
            const { instructions, ...info } = cfg.info?.(this.#ctx(req)) ?? {};
            return ok({
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: cfg.name, version: cfg.version ?? "0.0.0", ...info },
              ...(instructions && { instructions }),
            });
          }
          case "ping":
            return ok({});
          case "tools/list":
            return ok({ tools: await this.tools(req) });
          case "tools/call":
            return ok(await this.call(params?.name ?? "", params?.arguments, req));
          case "resources/list":
            return ok({ resources: [] });
          case "prompts/list":
            return ok({ prompts: [] });
          default:
            return fail(-32601, `Method not found: ${method}`);
        }
      } catch (e) {
        return fail(-32603, e instanceof Error ? e.message : String(e)); // e.g. site not WordPress
      }
    }
  };
};
