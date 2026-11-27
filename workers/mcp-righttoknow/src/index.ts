/**
 * mcp-righttoknow — FOI requests on Right to Know (righttoknow.org.au), read without a login.
 *
 *   righttoknow_search       the site's search, operators included: newest matching events
 *   righttoknow_request      one request: details, event history, every message, attachments
 *   righttoknow_authorities  every agency, by name and tag, from the site's CSV export
 *   righttoknow_authority    an agency's record and request counts, optionally its latest events
 *   righttoknow_user         a requester's profile and latest events
 *   righttoknow_feed         the latest events on a search, agency, requester or request
 *   righttoknow_attachment   a released document as text
 *
 * The site runs Alaveteli. Requests, agencies and users have a `.json` twin, but message bodies and
 * attachments are only in the HTML, and search is only an Atom feed; src/rtk.ts reads those.
 * Read-only: nothing here can make, reply to or classify a request.
 */
import cfg from "../wrangler.json";
import { version } from "../package.json";
import { mcpWorker, tool, type Result } from "../../../core/mcp";
import { BLOCKED } from "../../../core/egress";
import { BROWSER_UA } from "../../../core/web";
import {
  ORIGIN,
  findAuthorities,
  htmlToText,
  parseAuthorities,
  parseCorrespondence,
  parseFeed,
  requestRef,
  slugInPage,
  slugOf,
  tagCounts,
  type Authority,
  type FeedEntry,
} from "./rtk";

/** What mcp-fetch offers over RPC: its `egress` routes and its own tools. */
type FetchRpc = {
  egress(url: string, opts?: { headers?: Record<string, string> }): Promise<Response>;
  call(name: string, args: object, req?: object): Promise<Result>;
};
const rpc = (env: Env) => env.FETCH as unknown as FetchRpc;

/**
 * A plain fetch first, since it is free. Only if Right to Know turns a Cloudflare IP away does
 * the request go through mcp-fetch's egress routes (smart by default, billed per page).
 */
async function get(env: Env, path: string, accept = "text/html"): Promise<string> {
  const url = new URL(path, ORIGIN).href;
  const headers = { "User-Agent": BROWSER_UA, Accept: accept };
  let res = await fetch(url, { headers });
  if (BLOCKED.has(res.status) || res.headers.get("cf-mitigated") === "challenge")
    res = await rpc(env).egress(url, { headers });
  if (res.status === 404) throw new Error(`Not found on Right to Know: ${url}`);
  if (!res.ok) throw new Error(`Right to Know returned ${res.status} for ${url}`);
  return res.text();
}

const getJson = async (env: Env, path: string) =>
  JSON.parse(await get(env, path, "application/json"));

/** A request id or event URL redirects to the request; follow one hop by hand to get its slug. */
async function resolveSlug(env: Env, input: string): Promise<string> {
  const ref = requestRef(input);
  if ("slug" in ref) return ref.slug;
  const res = await fetch(new URL(ref.redirect, ORIGIN), {
    redirect: "manual",
    headers: { "User-Agent": BROWSER_UA },
  });
  const slug = res.headers.get("location")?.match(/\/request\/([a-z0-9_]+)/i)?.[1];
  if (slug && !/^\d+$/.test(slug)) return slug;
  // Challenged (the site often challenges these paths from data-centre IPs): fetch the page
  // through egress instead, and read the request it belongs to off the page.
  const found = slugInPage(await get(env, ref.redirect));
  if (!found) throw new Error(`Could not resolve ${input} to a request (HTTP ${res.status}).`);
  return found;
}

const FEEDS = {
  search: (v: string) => `/feed/search/${encodeURIComponent(v)}`,
  body: (v: string) => `/feed/body/${slugOf(v, "body")}`,
  user: (v: string) => `/feed/user/${slugOf(v, "user")}`,
  // /feed/request/<slug> answers with a 301 to this.
  request: (v: string) => `/request/${v}/feed`,
};
type FeedKind = keyof typeof FEEDS;

async function feed(env: Env, kind: FeedKind, value: string, since?: string) {
  const v = kind === "request" ? await resolveSlug(env, value) : value;
  const entries: FeedEntry[] = parseFeed(await get(env, FEEDS[kind](v), "application/atom+xml"));
  const after = since ? Date.parse(since) : NaN;
  return Number.isNaN(after) ? entries : entries.filter((e) => Date.parse(e.published) > after);
}

const CSV_URL = `${ORIGIN}/body/all-authorities.csv`;
let authorityCache: { at: number; list: Authority[] } | undefined;

/**
 * Every authority, from the site's CSV export. The site challenges that file from data-centre
 * IPs, so it comes through mcp-fetch's fetch_url, which keeps it: one paid fetch, then free until
 * `refresh`. Parsed once per isolate for an hour on top of that.
 */
async function authorities(env: Env, refresh = false): Promise<Authority[]> {
  if (!refresh && authorityCache && Date.now() - authorityCache.at < 3_600_000)
    return authorityCache.list;
  const out = await rpc(env).call("fetch_url", { url: CSV_URL, format: "raw", force: refresh });
  const text = out.content[0]?.text ?? "";
  if (out.isError || !/^\s*"?Internal ID"?,/i.test(text))
    throw new Error(`Could not get the authorities list: ${text.slice(0, 200)}`);
  authorityCache = { at: Date.now(), list: parseAuthorities(text) };
  return authorityCache.list;
}

const SINCE = {
  type: "string",
  description:
    "Only events published after this ISO date or date-time, e.g. '2026-11-20'. Lets a " +
    "scheduled check report just what is new.",
} as const;

const STATES =
  "waiting_response, waiting_clarification, gone_postal, not_held, rejected, successful, " +
  "partially_successful, internal_review, error_message, requires_admin, user_withdrawn, " +
  "attention_requested, vexatious, not_foi";

type RawEvent = {
  id: number;
  event_type: string;
  created_at: string;
  described_state: string | null;
  calculated_state: string | null;
  incoming_message_id: number | null;
  outgoing_message_id: number | null;
};

export default mcpWorker({
  ...cfg,
  version,
  info: () => ({
    instructions:
      "Right to Know (righttoknow.org.au) is the OpenAustralia Foundation's public FOI request " +
      "site. righttoknow_search finds requests; righttoknow_authorities finds an agency's slug; righttoknow_request reads one in full; " +
      "righttoknow_authority and righttoknow_user give an agency's or requester's record; " +
      "righttoknow_feed gives the latest events, and with `since` only the new ones; " +
      "righttoknow_attachment reads a released document. Read-only.",
  }),
  tools: {
    search: tool({
      description:
        "Search Right to Know requests and responses. Returns the newest ~25 matching events, " +
        "each with the request title, authority, requester, status and a snippet; pass an " +
        "event's url to righttoknow_request to read it. The query takes Alaveteli's operators " +
        "alongside words and quoted phrases: requested_from:<authority slug>, " +
        `requested_by:<user slug>, status:<state> (one of: ${STATES}), ` +
        "variety:<sent|response|comment|followup_sent>, tag:<tag>, and a date range written " +
        "YYYYMMDD..YYYYMMDD. Example: '\"Royal Commission\" requested_from:anu 20260301..20261127'.",
      input: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search terms and operators." },
          since: SINCE,
        },
      },
      async run({ query, since }, { env }) {
        const entries = await feed(env, "search", query, since);
        return { query, count: entries.length, entries };
      },
    }),

    request: tool({
      description:
        "Read one Right to Know request: title, authority, requester, status, the dated event " +
        "history, and the full text of each message with its attachments. Accepts a slug " +
        "('internal_anu_correspondence_conc'), a numeric request id, or any request or " +
        "/request_event/ URL, such as one from righttoknow_search.",
      input: {
        type: "object",
        required: ["request"],
        properties: {
          request: { type: "string", description: "Slug, numeric id or URL." },
          messages: {
            type: "string",
            enum: ["all", "latest", "none"],
            description:
              "Which message bodies to include (default all). 'none' gives the details and " +
              "event history only.",
          },
          unfold: {
            type: "boolean",
            description:
              "Include the quoted earlier emails the site folds under 'show quoted sections'. " +
              "Default false.",
          },
          max_chars: {
            type: "integer",
            description:
              "Cut each message body to this many characters; 0 for no limit. Default 6000. " +
              "Cut messages are marked truncated.",
          },
        },
      },
      async run({ request, messages = "all", unfold = false, max_chars = 6000 }, { env }) {
        const slug = await resolveSlug(env, request);
        const page = `/request/${slug}`;
        const [meta, html] = await Promise.all([
          getJson(env, `${page}.json`),
          messages === "none" ? "" : get(env, unfold ? `${page}?unfold=1` : page),
        ]);
        let msgs = parseCorrespondence(html, ORIGIN + page);
        if (messages === "latest") msgs = msgs.slice(-1);
        if (max_chars > 0)
          msgs = msgs.map((m) =>
            m.text.length > max_chars
              ? { ...m, text: m.text.slice(0, max_chars) + " […]", truncated: true }
              : m,
          );
        return {
          url: ORIGIN + page,
          id: meta.id,
          title: meta.title,
          law_used: meta.law_used,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
          status: meta.described_state,
          display_status: meta.display_status,
          awaiting_description: meta.awaiting_description,
          tags: meta.tags,
          authority: meta.public_body && {
            slug: meta.public_body.url_name,
            name: meta.public_body.name,
            short_name: meta.public_body.short_name,
          },
          requester: meta.user && { slug: meta.user.url_name, name: meta.user.name },
          events: ((meta.info_request_events ?? []) as RawEvent[]).map((e) => ({
            id: e.id,
            type: e.event_type,
            at: e.created_at,
            status: e.described_state ?? e.calculated_state ?? undefined,
            message: e.incoming_message_id
              ? `incoming-${e.incoming_message_id}`
              : e.outgoing_message_id
                ? `outgoing-${e.outgoing_message_id}`
                : undefined,
          })),
          ...(messages === "none" ? {} : { messages: msgs }),
        };
      },
    }),

    authorities: tool({
      description:
        "Find authorities on Right to Know by name and tag, from the site's full list (its CSV " +
        "export). Matches every word of `query` against name, short name and slug, so 'home " +
        "affairs' or 'ANU' both work; `tags` keeps only authorities carrying all of them, e.g. " +
        "['federal'], ['university'], ['council', 'vic'], ['foi_no']. Returns each one's slug " +
        "(for righttoknow_authority, and requested_from: in righttoknow_search), names, tags, " +
        "home page and disclosure log. With neither query nor tags, returns the tags in use and " +
        "how many authorities carry each.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to match in the name, e.g. 'health'." },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags every result must carry (without any ':value' part).",
          },
          limit: { type: "integer", description: "Most results to return. Default 50." },
          notes: { type: "boolean", description: "Include each authority's notes. Default false." },
          refresh: {
            type: "boolean",
            description: "Download the list again rather than use the kept copy. Default false.",
          },
        },
      },
      async run({ query = "", tags = [], limit = 50, notes = false, refresh = false }, { env }) {
        const all = await authorities(env, refresh);
        if (!query.trim() && !tags.length) return { total: all.length, tags: tagCounts(all) };
        const found = findAuthorities(all, query, tags);
        return {
          total: all.length,
          matched: found.length,
          authorities: found
            .slice(0, Math.max(1, limit))
            .map(({ notes: n, ...a }) => ({ ...a, ...(notes && n ? { notes: n } : {}) })),
        };
      },
    }),

    authority: tool({
      description:
        "An authority's Right to Know record: name, notes, home page, disclosure log, " +
        "information publication scheme, tags, and request counts (total, successful, not " +
        "held, overdue). Pass recent: true for its latest ~25 events as well. Accepts a slug " +
        "('oaic', 'home_affairs') or a /body/ URL.",
      input: {
        type: "object",
        required: ["authority"],
        properties: {
          authority: { type: "string", description: "Authority slug or URL." },
          recent: { type: "boolean", description: "Also return its latest events." },
          since: SINCE,
        },
      },
      async run({ authority, recent = false, since }, { env }) {
        const slug = slugOf(authority, "body");
        const [body, events] = await Promise.all([
          getJson(env, `/body/${slug}.json`),
          recent || since ? feed(env, "body", slug, since) : undefined,
        ]);
        return {
          url: `${ORIGIN}/body/${slug}`,
          slug: body.url_name,
          name: body.name,
          short_name: body.short_name,
          home_page: body.home_page,
          disclosure_log: body.disclosure_log,
          publication_scheme: body.publication_scheme,
          notes: body.notes,
          tags: Object.fromEntries(
            ((body.tags ?? []) as [string, string | null][]).map(([k, v]) => [k, v ?? true]),
          ),
          counts: body.info,
          ...(events ? { events } : {}),
        };
      },
    }),

    user: tool({
      description:
        "A requester's public Right to Know profile and their latest ~25 events (requests " +
        "made, responses received). Accepts a user slug ('s_p') or a /user/ URL.",
      input: {
        type: "object",
        required: ["user"],
        properties: { user: { type: "string", description: "User slug or URL." }, since: SINCE },
      },
      async run({ user, since }, { env }) {
        const slug = slugOf(user, "user");
        const [profile, events] = await Promise.all([
          getJson(env, `/user/${slug}.json`).catch(() => null),
          feed(env, "user", slug, since),
        ]);
        return { url: `${ORIGIN}/user/${slug}`, profile, events };
      },
    }),

    feed: tool({
      description:
        "The latest ~25 events, newest first, from one Right to Know feed: a search, an " +
        "authority, a user, or a single request. With `since`, only what is new, which suits " +
        "a scheduled watch.",
      input: {
        type: "object",
        required: ["kind", "value"],
        properties: {
          kind: { type: "string", enum: ["search", "body", "user", "request"] },
          value: {
            type: "string",
            description: "Search query, authority slug, user slug, or request slug, id or URL.",
          },
          since: SINCE,
        },
      },
      async run({ kind, value, since }, { env }) {
        const entries = await feed(env, kind, value, since);
        return { kind, value, count: entries.length, entries };
      },
    }),

    attachment: tool({
      description:
        "Read a document attached to a Right to Know response: a decision letter, schedule or " +
        "released documents. Pass an attachment `url` from righttoknow_request. PDFs and Word " +
        "files are converted to markdown by mcp-fetch, which keeps them; if that fails, the " +
        "site's own HTML rendering is used.",
      input: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "Attachment download URL, or its 'View' URL." },
        },
      },
      async run({ url }, { env }) {
        const u = new URL(url, ORIGIN);
        if (u.hostname !== new URL(ORIGIN).hostname || !u.pathname.includes("/attach/"))
          throw new Error("Not a Right to Know attachment URL.");
        // The same attachment as a download and as the site's HTML rendering ("View").
        const download = u.pathname.replace("/attach/html/", "/attach/").replace(/\.html$/, "");
        const view = download.replace("/attach/", "/attach/html/") + ".html";
        try {
          const out = await rpc(env).call("fetch_url", {
            url: ORIGIN + download,
            format: "markdown",
          });
          if (!out.isError) return { url: ORIGIN + download, text: out.content[0]?.text ?? "" };
        } catch {
          // mcp-fetch unreachable: fall through to the site's own rendering.
        }
        const html = await get(env, view);
        const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
        return { url: ORIGIN + download, text: htmlToText(body) };
      },
    }),
  },
});
