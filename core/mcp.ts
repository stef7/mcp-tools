/**
 * Shared MCP plumbing. A worker is just `export default mcpWorker({ ...wranglerConfig, tools })`.
 *
 *  - `fetch`  : stateless Streamable-HTTP MCP endpoint (POST JSON-RPC, GET = info page)
 *  - `tools()` and `call()` : the same tools over RPC, so another worker can aggregate them
 *
 * Every tool name is prefixed with the worker's own name (`mcp-wp` -> `wp_`). A worker that
 * lists `services` in its wrangler config re-exports the tools of each bound worker, routing
 * calls by that prefix. `?tools=wp,toolkit_acast_episodes` on the connector URL narrows the list
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

/** What a tool's `run` receives besides its args: bindings, connector query string, exec ctx. */
export type Ctx = { env: Env; params: URLSearchParams; exec: ExecutionContext };

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
  run(args: FromSchema<S>, c: Ctx): unknown;
};

/** Tools keyed by (unprefixed) name. The key *is* the name; nothing to keep in sync. */
export type Tools = Record<string, { run(args: never, c: Ctx): unknown } & Omit<Tool, "run">>;

/** Gives `run` typed args from `input` without writing the shape twice. */
export const tool = <const S extends JSONSchema>(t: Tool<S>) => t;

export type Spec = { name: string; description: string; inputSchema: JSONSchema } & Annotations;
export type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

/** `initialize` extras: everything but `instructions` goes into `serverInfo`. */
type Info = {
  title?: string;
  description?: string;
  icons?: { src: string }[];
  websiteUrl?: string;
  instructions?: string;
};

type Config = {
  name: string;
  version?: string;
  services?: { binding: string; service: string }[];
  tools: Tools | ((c: Ctx) => Tools | Promise<Tools>);
  info?: (c: Ctx) => Info;
};

/** What a bound worker looks like over RPC (it is another `mcpWorker`). */
type Remote = {
  tools(search: string): Promise<Spec[]>;
  call(name: string, args: unknown, search: string): Promise<Result>;
};
type Msg = { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };

const prefixOf = (workerName: string) => workerName.replace(/^mcp-/, "").replaceAll("-", "_") + "_";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
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

export const mcpWorker = (cfg: Config) => {
  const prefix = prefixOf(cfg.name);
  const local = (c: Ctx) => (typeof cfg.tools === "function" ? cfg.tools(c) : cfg.tools);

  return class extends WorkerEntrypoint<Env> {
    #ctx = (search: string): Ctx => ({
      env: this.env,
      params: new URLSearchParams(search),
      exec: this.ctx,
    });
    #remotes = () =>
      (cfg.services ?? [])
        .map((s) => ({
          prefix: prefixOf(s.service),
          rpc: (this.env as unknown as Record<string, unknown>)[s.binding] as Remote,
        }))
        .sort((a, b) => b.prefix.length - a.prefix.length);

    /** Every tool this worker offers: its own, then each bound worker's. */
    async tools(search = ""): Promise<Spec[]> {
      const c = this.#ctx(search);
      const sel = c.params.get("tools")?.split(",");
      const own = Object.entries(await local(c)).map(([k, t]) => ({
        name: prefix + k,
        description: t.description,
        ...t.annotations,
        inputSchema: t.input ?? { type: "object", properties: {} },
      }));
      const wantedRemotes = this.#remotes().filter(
        (r) => !sel || sel.some((s) => (s + "_").startsWith(r.prefix)),
      );
      const remote = await Promise.all(wantedRemotes.map((r) => r.rpc.tools(search)));
      return [...own, ...remote.flat()].filter(
        (t) => !sel || sel.some((s) => t.name === s || t.name.startsWith(s + "_")),
      );
    }

    async call(name: string, args: unknown = {}, search = ""): Promise<Result> {
      const c = this.#ctx(search);
      const own = name.startsWith(prefix) && (await local(c))[name.slice(prefix.length)];
      if (own) {
        try {
          const v = await own.run(args as never, c);
          return isResult(v) ? v : { content: [{ type: "text", text: text(v) }] };
        } catch (e) {
          return err(`Error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const r = this.#remotes().find((r) => name.startsWith(r.prefix));
      return r ? r.rpc.call(name, args, search) : err(`Unknown tool: ${name}`);
    }

    override async fetch(req: Request): Promise<Response> {
      const { search } = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (req.method === "GET") {
        const tools = (await this.tools(search)).map((t) => t.name);
        return json({
          name: cfg.name,
          version: cfg.version,
          endpoint: "POST JSON-RPC here",
          tools,
        });
      }
      if (req.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });
      const body = (await req.json().catch(() => null)) as Msg | Msg[] | null;
      if (!body)
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          400,
        );
      const out = (await Promise.all([body].flat().map((m) => this.#rpc(m, search)))).filter(
        Boolean,
      );
      if (!out.length) return new Response(null, { status: 202, headers: CORS });
      return json(Array.isArray(body) ? out : out[0]);
    }

    async #rpc({ id, method, params }: Msg, search: string) {
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
            const { instructions, ...info } = cfg.info?.(this.#ctx(search)) ?? {};
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
            return ok({ tools: await this.tools(search) });
          case "tools/call":
            return ok(await this.call(params?.name ?? "", params?.arguments, search));
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
