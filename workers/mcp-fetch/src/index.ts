/**
 * mcp-fetch — fetch one URL, in the format you ask for, and remember it.
 *
 * No crawling, no sitemaps, no following attachments, no guessing what a page "really" wants:
 * you name a URL and a format, you get that URL in that format. Everything fetched is kept, so
 * `search` can look across whatever you have fetched before without going back to the network.
 *
 * Every download goes out through core/egress.ts — by default Cloudflare itself, then Apify's
 * Unblocker if the site blocks it; `via` picks the routes and their order — and `egress` offers the same to
 * other workers.
 *
 * Storage (unchanged from the previous version, so existing cached documents still work):
 *   KV  raw:<url>   the original bytes, forever — re-formatting never re-downloads
 *   D1  docs        one row per URL: the extracted text and where it came from
 *   D1  docs_fts    FTS5 index over docs.text, for ranked search
 */
import cfg from "../wrangler.json";
import { version } from "../package.json";
import { mcpWorker, tool, type Ctx } from "../../../core/mcp";
import { BROWSER_UA as UA, stripHtml, withBase } from "../../../core/web";
import { egress, ROUTES, type Via } from "../../../core/egress";

const FORMATS = ["auto", "markdown", "text", "raw"] as const;
type Format = (typeof FORMATS)[number];

/** Kept byte-for-byte from the previous version so no migration is needed. */
const DDL = `
CREATE TABLE IF NOT EXISTS docs (
  url TEXT PRIMARY KEY CHECK (url LIKE 'http%'),
  kind TEXT NOT NULL CHECK (kind IN ('docx','pdf','html','sitemap','other')),
  content_type TEXT CHECK (content_type IS NULL OR
    (content_type = lower(content_type) AND instr(content_type,';') = 0)),
  source TEXT CHECK (source IS NULL OR source LIKE 'http%'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','error')),
  error TEXT, title TEXT,
  published_at TEXT CHECK (published_at IS NULL OR
    published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  text TEXT, bytes_len INTEGER CHECK (bytes_len IS NULL OR bytes_len >= 0),
  meta_json TEXT CHECK (meta_json IS NULL OR json_valid(meta_json)),
  fetched_at INTEGER CHECK (fetched_at IS NULL OR fetched_at >= 0),
  updated_at INTEGER CHECK (updated_at IS NULL OR updated_at >= 0)
);
CREATE INDEX IF NOT EXISTS docs_kind ON docs(kind);
CREATE INDEX IF NOT EXISTS docs_status ON docs(status);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts
  USING fts5(url UNINDEXED, text, tokenize = 'unicode61');
`;

let ready = false;
const ensureSchema = async (env: Env) => {
  if (ready) return;
  await env.DB.exec(DDL.replace(/\n\s*/g, " ").replace(/; /g, ";\n").trim());
  ready = true;
};

// ─── Fetching ──────────────────────────────────────────────────────────────────────────────────
const basename = (u: string) => {
  const last = u.split("?")[0]?.split("/").pop() ?? u;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};
const normCt = (ct: string | null) => ct?.split(";")[0]?.trim().toLowerCase() ?? null;

/** What the bytes are, from the content type first and the extension only as a fallback. */
const kindOf = (url: string, ct: string | null) => {
  if (ct?.includes("pdf")) return "pdf";
  if (ct?.includes("wordprocessingml") || ct?.includes("msword")) return "docx";
  if (ct?.includes("html")) return "html";
  const ext = basename(url).toLowerCase();
  if (ext.endsWith(".pdf")) return "pdf";
  if (ext.endsWith(".docx")) return "docx";
  if (ext.endsWith(".html") || ext.endsWith(".htm")) return "html";
  return "other";
};
const isBinary = (kind: string) => kind === "pdf" || kind === "docx";

const browserHeaders = (url: string) => ({
  "User-Agent": UA,
  Accept: "*/*",
  Referer: new URL(url).origin + "/",
});

const download = async (env: Env, url: string, via?: Via) => {
  const got = await egress(env, url, { headers: browserHeaders(url), ...(via && { via }) });
  const res = got.response;
  const route = got.skipped.length ? `${got.via} (${got.skipped.join("; ")})` : got.via;
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url} via ${route}`);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    ct: normCt(res.headers.get("content-type")),
    route,
  };
};

/** Original bytes, from KV unless `force` says to go back to the origin. */
const bytesFor = async (env: Env, url: string, force: boolean, via?: Via) => {
  if (!force) {
    const hit = await env.CACHE.get(`raw:${url}`, "arrayBuffer");
    const ct = await env.CACHE.get(`ct:${url}`);
    if (hit) return { bytes: new Uint8Array(hit), ct, cached: true, route: "cache" };
  }
  const { bytes, ct, route } = await download(env, url, via);
  await env.CACHE.put(`raw:${url}`, bytes);
  if (ct) await env.CACHE.put(`ct:${url}`, ct);
  return { bytes, ct, cached: false, route };
};

// ─── Formatting ───────────────────────────────────────────────────────────────────────────────
/**
 * The converter decides what a file is from its name alone, and hands an HTML page named
 * `publications` or `index.php` back unconverted. So an HTML page is always named .html, and a
 * PDF or Word file with no extension at all gets the one its content type says.
 */
const nameFor = (url: string, kind: string) => {
  const base = basename(url) || "document";
  if (kind === "html") return /\.html$/i.test(base) ? base : base + ".html";
  if (isBinary(kind) && !/\.\w{2,5}$/.test(base)) return `${base}.${kind}`;
  return base;
};

const toMarkdown = async (env: Env, bytes: Uint8Array, url: string, kind: string) => {
  const name = nameFor(url, kind);
  const html = kind === "html";
  const body = html ? withBase(new TextDecoder().decode(bytes), url) : bytes;
  const out = await env.AI.toMarkdown(
    [
      {
        name,
        blob: new Blob([body as string | BufferSource], { type: "application/octet-stream" }),
      },
    ],
    // Left to itself the converter drops every <header> and <footer>, including an article's
    // own, which is where its headline and date usually are. Selecting the body keeps them.
    html ? { conversionOptions: { html: { cssSelector: "body" } } } : undefined,
  );
  const first = Array.isArray(out) ? out[0] : out;
  if (!first || first.format === "error") throw new Error(first?.error ?? "conversion failed");
  return first.data;
};

/** Turn the bytes into text the way the caller asked. Nothing here inspects the URL. */
const render = async (env: Env, bytes: Uint8Array, url: string, kind: string, format: Format) => {
  const decoded = () => new TextDecoder().decode(bytes);
  if (format === "raw") {
    if (isBinary(kind)) throw new Error(`${kind} is binary; ask for markdown or auto instead.`);
    return { text: decoded(), via: "raw" };
  }
  if (format === "markdown") {
    return { text: await toMarkdown(env, bytes, url, kind), via: "toMarkdown" };
  }
  if (format === "text") {
    if (isBinary(kind)) throw new Error(`${kind} is binary; ask for markdown or auto instead.`);
    return kind === "html"
      ? { text: stripHtml(decoded()), via: "html-strip" }
      : { text: decoded(), via: "plain" };
  }
  // auto: whatever reads best for this content type. HTML goes to markdown so its links
  // survive, falling back to stripped text rather than failing if the converter does.
  if (isBinary(kind)) return { text: await toMarkdown(env, bytes, url, kind), via: "toMarkdown" };
  if (kind === "html") {
    try {
      return { text: await toMarkdown(env, bytes, url, kind), via: "toMarkdown" };
    } catch (e) {
      return { text: stripHtml(decoded()), via: `html-strip (toMarkdown failed: ${String(e)})` };
    }
  }
  return { text: decoded(), via: "plain" };
};

// ─── Storage ───────────────────────────────────────────────────────────────────────────────────
type Row = {
  url: string;
  kind: string;
  content_type: string | null;
  status: "ok" | "error";
  error?: string;
  text?: string;
  bytes_len?: number;
  meta_json?: string;
};

const store = async (env: Env, r: Row) => {
  const now = Math.floor(Date.now() / 1000);
  const upsert = env.DB.prepare(
    `INSERT INTO docs (url,kind,content_type,status,error,text,bytes_len,meta_json,
       fetched_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET
       kind=excluded.kind,
       content_type=COALESCE(excluded.content_type,docs.content_type),
       status=excluded.status, error=excluded.error, text=excluded.text,
       bytes_len=COALESCE(excluded.bytes_len,docs.bytes_len),
       meta_json=excluded.meta_json,
       fetched_at=COALESCE(excluded.fetched_at,docs.fetched_at),
       updated_at=excluded.updated_at`,
  ).bind(
    r.url,
    r.kind,
    r.content_type ?? null,
    r.status,
    r.error ?? null,
    r.text ?? null,
    r.bytes_len ?? null,
    r.meta_json ?? null,
    r.status === "ok" ? now : null,
    now,
  );
  await env.DB.batch([
    upsert,
    env.DB.prepare(`DELETE FROM docs_fts WHERE url = ?`).bind(r.url),
    env.DB.prepare(
      `INSERT INTO docs_fts(url,text) SELECT url,text FROM docs WHERE url = ? AND text IS NOT NULL`,
    ).bind(r.url),
  ]);
};

/** Lines around each hit, so a match arrives with enough context to judge it. */
const grep = (text: string, q: string, ctx: number) => {
  if (ctx < 0) return [text];
  const lines = text.split("\n");
  const needle = q.toLowerCase();
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!line.toLowerCase().includes(needle)) return;
    out.push(lines.slice(Math.max(0, i - ctx), i + ctx + 1).join("\n"));
  });
  return out;
};

const range = (prefix: string) => [prefix, prefix + "￿"] as const;

// ─── Tools ─────────────────────────────────────────────────────────────────────────────────────
const schema = async (c: Ctx) => {
  await ensureSchema(c.env);
  return c.env;
};

const Tools = mcpWorker({
  ...cfg,
  version,
  tools: {
    url: tool({
      description:
        "Fetch one URL and return its content. The original bytes are cached forever, so asking " +
        "for a different format later never re-downloads. PDFs and Word documents are converted " +
        "with Workers AI. Nothing is followed, crawled or inferred: you get the URL you asked for.",
      input: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "Absolute URL." },
          format: {
            type: "string",
            enum: [...FORMATS],
            description:
              "auto (default): markdown for HTML, PDF and Word, so links are kept; as-is for " +
              "anything else. markdown: always convert with Workers AI. text: plain text with " +
              "tags and links stripped, no conversion. raw: exactly what the server sent.",
          },
          force: {
            type: "boolean",
            description: "Re-download instead of using the cached bytes. Default false.",
          },
          via: {
            type: "array",
            items: { type: "string", enum: [...ROUTES] },
            description:
              "Routes to try, in order. The next is tried when one cannot connect or the site " +
              "answers 403, 429, 451 or 503 or with a challenge header. `direct`: Cloudflare's " +
              "own fetch. `unblocker`: gets past bot checks and CAPTCHAs, paid per page. " +
              "`tunnel`: an Australian home connection, only while that Mac is on. `browser`: " +
              "the same Mac's browser (Brave), for challenge pages and sign-ins, only for domains the " +
              "Mac allows. One route " +
              'means no fallback. Default ["direct", "unblocker"].',
          },
        },
      },
      async run({ url, format, force, via }, c) {
        const env = await schema(c);
        const fmt: Format = FORMATS.includes(format as Format) ? (format as Format) : "auto";
        try {
          const { bytes, ct, cached, route } = await bytesFor(env, url, force === true, via);
          const kind = kindOf(url, ct ?? null);
          const { text, via: how } = await render(env, bytes, url, kind, fmt);
          await store(env, {
            url,
            kind,
            content_type: ct ?? null,
            status: "ok",
            text,
            bytes_len: bytes.length,
            meta_json: JSON.stringify({ format: fmt, via: how, cached, route }),
          });
          return text;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await store(env, {
            url,
            kind: "other",
            content_type: null,
            status: "error",
            error: message,
          });
          return { content: [{ type: "text", text: message }], isError: true };
        }
      },
    }),

    list: tool({
      description:
        "List what has been fetched, optionally narrowed to URLs starting with a prefix.",
      input: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "URL prefix. Omit for everything." },
          limit: { type: "integer", description: "Rows to return (default 200)." },
        },
      },
      async run({ prefix, limit }, c) {
        const env = await schema(c);
        const [lo, hi] = range(prefix ?? "");
        const { results } = await env.DB.prepare(
          `SELECT url, kind, status, bytes_len, updated_at FROM docs
           WHERE url >= ? AND url < ? ORDER BY updated_at DESC LIMIT ?`,
        )
          .bind(lo, hi, Math.min(limit ?? 200, 1000))
          .all<{ url: string; kind: string; status: string; bytes_len: number | null }>();
        if (!results.length) return "Nothing fetched yet under that prefix.";
        const lines = results.map(
          (r) => `${r.status === "ok" ? "✓" : "✗"} ${r.kind.padEnd(5)} ${r.url}`,
        );
        return `${results.length} document(s):\n\n${lines.join("\n")}\n`;
      },
    }),

    search: tool({
      description:
        "Full-text search across everything already fetched. Ranked, with the matching lines in " +
        "context. Never goes to the network — fetch a URL first to make it searchable.",
      input: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Phrase to find, case-insensitive." },
          prefix: { type: "string", description: "Only search URLs starting with this." },
          context_lines: {
            type: "integer",
            description: "Lines of context around each hit (default 2). -1 for whole documents.",
          },
        },
      },
      async run({ query, prefix, context_lines }, c) {
        const env = await schema(c);
        const [lo, hi] = range(prefix ?? "");
        const ctx = context_lines ?? 2;
        const { results } = await env.DB.prepare(
          `SELECT d.url, d.text, snippet(docs_fts,1,'»','«','…',12) AS snip
           FROM docs_fts f JOIN docs d ON d.url = f.url
           WHERE docs_fts MATCH ? AND d.url >= ? AND d.url < ?
           ORDER BY bm25(docs_fts) LIMIT 50`,
        )
          .bind(`"${query.replace(/"/g, "")}"`, lo, hi)
          .all<{ url: string; text: string | null; snip: string }>();
        if (!results.length) return `No matches for "${query}".`;
        let hits = 0;
        const blocks = results.map((r) => {
          const found = grep(r.text ?? "", query, ctx);
          hits += found.length;
          const body = found.length
            ? found.map((h) => "  " + h.replace(/\n/g, "\n  ")).join("\n  …\n")
            : "  " + r.snip;
          return `▸ ${r.url}\n${body}`;
        });
        return (
          `${hits} line match(es) for "${query}" across ${results.length} document(s):\n\n` +
          blocks.join("\n\n")
        );
      },
    }),

    otter_poll: tool({
      description:
        "Poll a live or public Otter.ai transcript by otid. Returns only the lines after `since` " +
        "seconds, plus `next` to pass back on the following call. Start with since=0.",
      input: {
        type: "object",
        required: ["otid"],
        properties: {
          otid: { type: "string", description: "Otter share id, from the otter.ai/u/… link." },
          since: {
            type: "integer",
            description: "Only lines starting after this many seconds. Pass the previous `next`.",
          },
        },
      },
      async run({ otid, since }) {
        const from = since ?? 0;
        const res = await fetch(
          `https://otter.ai/forward/api/v1/speech?otid=${encodeURIComponent(otid)}`,
          { headers: { "User-Agent": UA, Accept: "application/json" } },
        );
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Otter said HTTP ${res.status}` }],
            isError: true,
          };
        }
        type Line = { start_offset?: number; transcript?: string; speaker_model_label?: string };
        const speech = ((await res.json()) as { speech?: { transcripts?: Line[] } }).speech ?? {};
        const lines = (speech.transcripts ?? [])
          // start_offset is in 1/16 ms units (16000 per second).
          .map((t) => ({
            at: Math.round((t.start_offset ?? 0) / 16000),
            text: (t.transcript ?? "").trim(),
            who: t.speaker_model_label ?? null,
          }))
          .filter((l) => l.text && l.at > from)
          .sort((a, b) => a.at - b.at);
        const mmss = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
        const next = lines.at(-1)?.at ?? from;
        const body = lines.map((l) => `[${mmss(l.at)}]${l.who ? ` ${l.who}:` : ""} ${l.text}`);
        return `next:${next} new_lines:${lines.length}\n${body.join("\n") || "(no new speech)"}`;
      },
    }),
  },
  info: () => ({
    title: "Cached Fetch",
    description: "Fetch a URL in the format you ask for, keep it, and search what you have kept.",
    instructions:
      "Fetch one URL at a time with `url`. Formats: auto, markdown, text, raw. Everything " +
      "fetched stays searchable through `search` without hitting the network again.",
  }),
});

/**
 * The same routes for any worker that binds this one — `{ "binding": "FETCH", "service":
 * "mcp-fetch" }` — and calls `await env.FETCH.egress(url, { via: ["tunnel", "direct"] })`. It
 * gets the site's Response back, uncached and untouched, with `x-egress-via` saying which route
 * served it and `x-egress-skipped` why the ones before it did not. The tunnel, the proxy password
 * and the cost of both stay here.
 */
export default class extends Tools {
  async egress(url: string, opts: { headers?: Record<string, string>; via?: Via } = {}) {
    const { response, via, skipped } = await egress(this.env, url, opts);
    const out = new Response(response.body, response);
    out.headers.set("x-egress-via", via);
    if (skipped.length) out.headers.set("x-egress-skipped", skipped.join("; "));
    return out;
  }
}
