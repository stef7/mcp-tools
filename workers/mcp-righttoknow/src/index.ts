/**
 * mcp-righttoknow — FOI requests on Right to Know (righttoknow.org.au), read without a login.
 *
 *   righttoknow_search            the site's search, operators included: newest matching events
 *   righttoknow_request           one request: details, history, each message from a kept page
 *                                 if there is one, else a snippet
 *   righttoknow_feed              the latest events on a search, agency, requester or request
 *   righttoknow_authority         an agency's record and request counts, optionally its events
 *   righttoknow_user              a requester's profile and latest events
 *   righttoknow_authorities       every agency, by name and tag, from the site's CSV export
 *   righttoknow_site              the site's totals, league tables of agencies and requesters
 *   righttoknow_citations         where requests have been cited (news, research)
 *   righttoknow_link              a pre-filled link for the user: new request, reply, alerts…
 *   righttoknow_full_request      every message in full, with attachments     (challenged page)
 *   righttoknow_full_attachment   a released document as text                 (challenged page)
 *
 * Right to Know is run by a small charity, and puts its HTML pages behind a Cloudflare challenge.
 * Everything but the `full_` tools reads the JSON the site serves without one. The `full_` tools
 * load challenged pages, so each needs `user_confirmed`, and what they load is kept by mcp-fetch
 * and reused until the request changes (or, for documents, for good). The authority list is a
 * challenged CSV too, kept for a week.
 */
import cfg from "../wrangler.json";
import { version } from "../package.json";
import { mcpWorker, tool, type Result } from "../../../core/mcp";
import { BLOCKED } from "../../../core/egress";
import { BROWSER_UA } from "../../../core/web";
import {
  ORIGIN,
  anchorOf,
  cleanSnippet,
  findAuthorities,
  parseAuthorities,
  parseCorrespondence,
  requestRef,
  slugOf,
  tagCounts,
  toEntry,
  type Authority,
  type RawEvent,
} from "./rtk";

/** What mcp-fetch offers over RPC: its `egress` routes and its own tools. */
type FetchRpc = {
  egress(url: string, opts?: { headers?: Record<string, string> }): Promise<Response>;
  call(name: string, args: object, req?: object): Promise<Result>;
};
const rpc = (env: Env) => env.FETCH as unknown as FetchRpc;

/**
 * JSON the site serves without a challenge. A plain fetch, since it is free; mcp-fetch's egress
 * only if Cloudflare starts challenging a Worker's IP for it after all.
 */
async function getJson<T = any>(env: Env, path: string): Promise<T> {
  const url = new URL(path, ORIGIN).href;
  const headers = { "User-Agent": BROWSER_UA, Accept: "application/json" };
  let res = await fetch(url, { headers });
  if (BLOCKED.has(res.status) || res.headers.get("cf-mitigated") === "challenge")
    res = await rpc(env).egress(url, { headers });
  if (res.status === 404) throw new Error(`Not found on Right to Know: ${url}`);
  if (!res.ok) throw new Error(`Right to Know returned ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

/**
 * A challenged page, through mcp-fetch's fetch_url, which keeps it: `force` loads it again,
 * `max_age` (seconds) loads it again once the kept copy is that old.
 */
async function kept(
  env: Env,
  url: string,
  opts: { format?: "raw" | "markdown"; force?: boolean; max_age?: number } = {},
): Promise<string> {
  const out = await rpc(env).call("fetch_url", { url, format: "raw", ...opts });
  const text = out.content[0]?.text ?? "";
  if (out.isError) throw new Error(`Could not load ${url}: ${text}`);
  return text;
}

/** A page mcp-fetch already keeps, or undefined. Never goes to the network. */
async function keptOnly(env: Env, url: string): Promise<string | undefined> {
  try {
    const out = await rpc(env).call("fetch_url", { url, format: "raw", cache_only: true });
    return out.isError ? undefined : out.content[0]?.text;
  } catch {
    return undefined; // mcp-fetch unreachable: snippets only.
  }
}

const cut = (text: string, max: number) =>
  max > 0 && text.length > max
    ? { text: text.slice(0, max) + " […]", truncated: true as const }
    : { text };

type RequestJson = {
  id: number;
  url_title: string;
  title: string;
  law_used?: string;
  created_at: string;
  updated_at: string;
  described_state?: string;
  display_status?: string;
  awaiting_description?: boolean;
  tags?: unknown;
  user?: { url_name: string; name: string };
  public_body?: { url_name: string; name: string; short_name?: string };
  info_request_events?: RawEvent[];
};

/** The request's details, by slug or by numeric id (which the site redirects, unchallenged). */
async function requestMeta(env: Env, input: string) {
  const ref = requestRef(input);
  return getJson<RequestJson>(env, `/request/${"slug" in ref ? ref.slug : ref.id}.json`);
}

const summary = (m: RequestJson) => ({
  url: `${ORIGIN}/request/${m.url_title}`,
  slug: m.url_title,
  id: m.id,
  title: m.title,
  law_used: m.law_used,
  created_at: m.created_at,
  updated_at: m.updated_at,
  status: m.described_state,
  display_status: m.display_status,
  awaiting_description: m.awaiting_description,
  tags: m.tags,
  authority: m.public_body && {
    slug: m.public_body.url_name,
    name: m.public_body.name,
    short_name: m.public_body.short_name || undefined,
  },
  requester: m.user && { slug: m.user.url_name, name: m.user.name },
});

const FEEDS = {
  // Alaveteli strips a trailing `.json` off the query and answers in JSON.
  search: (v: string) => `/feed/search/${encodeURIComponent(v)}.json`,
  body: (v: string) => `/feed/body/${slugOf(v, "body")}.json`,
  user: (v: string) => `/feed/user/${slugOf(v, "user")}.json`,
  // The site-wide lists: `recent` (all new requests) or `successful`.
  list: (v: string) => `/feed/list/${v === "successful" ? "successful" : "recent"}.json`,
  // /feed/request/<slug> answers with a 301 to this.
  request: (v: string) => `/request/${v}/feed.json`,
};
type FeedKind = keyof typeof FEEDS;

async function feed(env: Env, kind: FeedKind, value: string, since?: string) {
  let v = value;
  if (kind === "request") {
    const ref = requestRef(value);
    v = "slug" in ref ? ref.slug : (await requestMeta(env, ref.id)).url_title;
  }
  const entries = (await getJson<RawEvent[]>(env, FEEDS[kind](v))).map(toEntry);
  const after = since ? Date.parse(since) : NaN;
  return Number.isNaN(after) ? entries : entries.filter((e) => Date.parse(e.at) > after);
}

const SINCE = {
  type: "string",
  description:
    "Only events after this ISO date or date-time, e.g. '2026-11-20T00:00:00+11:00'. Lets a " +
    "scheduled check report just what is new.",
} as const;

const STATES =
  "waiting_response, waiting_clarification, gone_postal, not_held, rejected, successful, " +
  "partially_successful, internal_review, error_message, requires_admin, user_withdrawn, " +
  "attention_requested, vexatious, not_foi";

const CSV_URL = `${ORIGIN}/body/all-authorities.csv`;
const WEEK = 7 * 24 * 3600;
let authorityCache: { at: number; list: Authority[] } | undefined;

/**
 * Every authority, from the site's CSV export: challenged, so kept by mcp-fetch and loaded again
 * only once the kept copy is a week old (or on `refresh`). Parsed once per isolate per hour.
 */
async function authorities(env: Env, refresh = false): Promise<Authority[]> {
  if (!refresh && authorityCache && Date.now() - authorityCache.at < 3_600_000)
    return authorityCache.list;
  const text = await kept(env, CSV_URL, { max_age: WEEK, force: refresh });
  if (!/^\s*"?Internal ID"?,/i.test(text))
    throw new Error(`The authorities list did not come back as CSV: ${text.slice(0, 200)}`);
  authorityCache = { at: Date.now(), list: parseAuthorities(text) };
  return authorityCache.list;
}

/** Query string from the set values only, `+` for spaces as the site's own examples write it. */
const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

const LINKS = [
  "new_request",
  "reply",
  "internal_review",
  "annotate",
  "report",
  "add_citation",
  "download_zip",
  "track",
  "change_request",
  "select_authority",
  "contact",
] as const;

/** Said in each `full_` tool's description, and again if it is called unconfirmed. */
const CHALLENGED =
  "Loads a page Right to Know protects with a Cloudflare challenge: load on a small charity's " +
  "server, and a paid proxy fetch here. Ask the user first, each time.";

export default mcpWorker({
  ...cfg,
  version,
  info: () => ({
    instructions:
      "Right to Know (righttoknow.org.au) is the OpenAustralia Foundation's public FOI request " +
      "site, run by a small charity. Prefer the light tools: righttoknow_search, " +
      "righttoknow_request (details, history and a snippet of each message), righttoknow_feed, " +
      "righttoknow_authority, righttoknow_user, righttoknow_authorities, righttoknow_site and " +
      "righttoknow_citations. righttoknow_link builds links (a new request, a reply, alerts) " +
      "for the user to open; nothing is sent. The righttoknow_full_* " +
      "tools load pages the site protects with a challenge; use one only when the user needs " +
      "full message text or a document, and only after they agree.",
  }),
  tools: {
    search: tool({
      description:
        "Search Right to Know requests and responses. Returns the newest ~25 matching events, " +
        "each with its request (slug, title, status), authority, requester and a snippet. The " +
        "query takes Alaveteli's operators alongside words and quoted phrases: " +
        "requested_from:<authority slug>, requested_by:<user slug>, " +
        `status:<state> (one of: ${STATES}), variety:<sent|response|comment|followup_sent>, ` +
        "tag:<tag>, and a date range written YYYYMMDD..YYYYMMDD. Example: " +
        "'\"Royal Commission\" requested_from:anu 20260301..20261127'.",
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
        "One Right to Know request without loading a challenged page: title, authority, " +
        "requester, status, and its dated event history. Each message comes in full if " +
        "righttoknow_full_request has loaded the page before (that copy is kept), with its " +
        "attachments; otherwise as a ~150-character snippet, marked with `more` where " +
        "righttoknow_full_request would give the rest. Accepts a slug " +
        "('internal_anu_correspondence_conc'), a numeric request id, or a request URL.",
      input: {
        type: "object",
        required: ["request"],
        properties: {
          request: { type: "string", description: "Slug, numeric id or URL." },
          max_chars: {
            type: "integer",
            description:
              "Cut each kept message to this many characters; 0 for no limit. Default 4000. " +
              "Cut messages are marked truncated; asking again with 0 costs nothing.",
          },
        },
      },
      async run({ request, max_chars = 4000 }, { env }) {
        const meta = await requestMeta(env, request);
        const page = `${ORIGIN}/request/${meta.url_title}`;
        const [events, html] = await Promise.all([
          getJson<RawEvent[]>(env, FEEDS.request(meta.url_title)),
          keptOnly(env, page).then((h) => h ?? keptOnly(env, `${page}?unfold=1`)),
        ]);
        const snippets = new Map(events.map((e) => [e.id, e.snippet]));
        const bodies = new Map(html ? parseCorrespondence(html, page).map((m) => [m.id, m]) : []);
        let missing = 0;
        const out = (meta.info_request_events ?? []).map((e) => {
          const message = anchorOf(e);
          const base = {
            id: e.id,
            type: e.event_type,
            at: e.created_at,
            status: e.described_state ?? e.calculated_state ?? undefined,
            message,
          };
          const m = message ? bodies.get(message) : undefined;
          if (m)
            return {
              ...base,
              author: m.author,
              ...cut(m.text, max_chars),
              ...(m.attachments.length ? { attachments: m.attachments } : {}),
            };
          const snippet = snippets.get(e.id);
          const isMessage = !!(e.incoming_message_id || e.outgoing_message_id);
          if (isMessage) missing++;
          return {
            ...base,
            snippet: snippet ? cleanSnippet(snippet) : undefined,
            ...(isMessage ? { more: "righttoknow_full_request" } : {}),
          };
        });
        return {
          ...summary(meta),
          full_text: !html
            ? "No kept copy of the page: snippets only. righttoknow_full_request loads it."
            : missing
              ? `From the kept copy of the page; ${missing} newer message(s) are snippets, ` +
                "which righttoknow_full_request would load."
              : "Every message, from the kept copy of the page.",
          events: out,
        };
      },
    }),

    feed: tool({
      description:
        "The latest ~25 events, newest first, from one Right to Know feed: a search, an " +
        "authority, a user, a single request, or the site-wide list of new or successful " +
        "requests. With `since`, only what is new, which suits a scheduled watch.",
      input: {
        type: "object",
        required: ["kind", "value"],
        properties: {
          kind: { type: "string", enum: ["search", "body", "user", "request", "list"] },
          value: {
            type: "string",
            description:
              "Search query, authority slug, user slug, request slug/id/URL, or for `list`: " +
              "'recent' (every new request) or 'successful'.",
          },
          since: SINCE,
        },
      },
      async run({ kind, value, since }, { env }) {
        const entries = await feed(env, kind, value, since);
        return { kind, value, count: entries.length, entries };
      },
    }),

    authority: tool({
      description:
        "An authority's Right to Know record: name, notes, home page, disclosure log, " +
        "information publication scheme, tags, and request counts (total, successful, not " +
        "held, overdue). Pass recent: true for its latest ~25 events as well. Accepts a slug " +
        "('oaic', 'home_affairs') or a /body/ URL; righttoknow_authorities finds slugs.",
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
          getJson(env, `/user/${slug}.json`),
          feed(env, "user", slug, since),
        ]);
        return { url: `${ORIGIN}/user/${slug}`, profile, events };
      },
    }),

    authorities: tool({
      description:
        "Find authorities on Right to Know by name and tag, from the site's full list (its CSV " +
        "export, kept for a week). Matches every word of `query` against name, short name and " +
        "slug, so 'home affairs' or 'ANU' both work; `tags` keeps only authorities carrying " +
        "all of them, e.g. ['federal'], ['university'], ['council', 'vic'], ['foi_no']. " +
        "Returns each one's slug (for righttoknow_authority, and requested_from: in " +
        "righttoknow_search), names, tags, home page and disclosure log. With neither query " +
        "nor tags, returns the tags in use and how many authorities carry each.",
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
            description:
              "Load the list again even if the kept copy is under a week old. It is a " +
              "challenged page: only when the user asks for it. Default false.",
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

    site: tool({
      description:
        "Right to Know's own numbers: totals (authorities, requests, users, annotations, " +
        "citations, Alaveteli version), the authorities with the most requests, the most and " +
        "fewest successful requests, the most overdue and the most 'not held' replies, and " +
        "the most active requesters and annotators, all time and the last 28 days.",
      async run(_args, { env }) {
        type Chart = {
          id: string;
          title: string;
          y_axis: string;
          y_values: number[];
          totals: number[];
          public_bodies: { name: string; url: string }[];
        };
        type Board = { user: { url_name: string; name: string }; count: number }[];
        const [version, stats] = await Promise.all([
          getJson<Record<string, unknown>>(env, "/version.json"),
          getJson<{ public_bodies: Chart[]; users: Record<string, Board> }>(
            env,
            "/statistics.json",
          ),
        ]);
        const { alaveteli_git_commit: _commit, ruby_version: _ruby, ...totals } = version;
        return {
          totals,
          authorities: stats.public_bodies.map((c) => ({
            id: c.id,
            title: c.title,
            measure: c.y_axis,
            ranking: c.public_bodies.map((b, i) => ({
              slug: b.url.split("/body/")[1],
              name: b.name,
              value: Math.round((c.y_values[i] ?? 0) * 10) / 10,
              requests: c.totals[i],
            })),
          })),
          users: Object.fromEntries(
            Object.entries(stats.users).map(([k, board]) => [
              k,
              board.map((r) => ({ slug: r.user.url_name, name: r.user.name, count: r.count })),
            ]),
          ),
        };
      },
    }),

    citations: tool({
      description:
        "Where Right to Know requests have been cited: news stories, research and the like, " +
        "newest first, 10 a page, each with its source URL and the request or batch it cites.",
      input: {
        type: "object",
        properties: { page: { type: "integer", description: "Page number, from 1. Default 1." } },
      },
      async run({ page = 1 }, { env }) {
        type Citation = {
          source_url: string;
          type: string;
          created_at: string;
          title: string | null;
          description: string | null;
          citable_path: string;
        };
        const list = await getJson<Citation[]>(
          env,
          `/citations.json${page > 1 ? `?page=${page}` : ""}`,
        );
        return {
          page,
          citations: list.map((c) => ({
            source_url: c.source_url,
            type: c.type,
            at: c.created_at,
            title: c.title ?? undefined,
            description: c.description ?? undefined,
            cites: ORIGIN + c.citable_path,
          })),
        };
      },
    }),

    link: tool({
      description:
        "Build a Right to Know link for the user to open: nothing is fetched or sent, and " +
        "every form needs them signed in on the site. Actions: new_request (to `authority`, " +
        "pre-filled with `title`, and `default_letter` or `body`, plus `tags`), reply (a " +
        "follow-up on `request`, to one `incoming_message_id` if given), internal_review, " +
        "annotate, report, add_citation, download_zip (every message and attachment), track " +
        "(email alerts for a `request`, `authority`, `user` or `query`), change_request " +
        "(update an `authority`'s FOI address, or suggest a new authority), select_authority " +
        "(start a request by choosing an authority, optionally from `query`), contact.",
      input: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: [...LINKS] },
          authority: { type: "string", description: "Authority slug or URL." },
          request: { type: "string", description: "Request slug or request URL." },
          user: { type: "string", description: "User slug or URL (track only)." },
          query: { type: "string", description: "Search query (track, select_authority)." },
          title: { type: "string", description: "new_request: the request's summary." },
          default_letter: {
            type: "string",
            description:
              "new_request: the letter's text; the site wraps its own 'Dear…' and sign-off " +
              "around it.",
          },
          body: {
            type: "string",
            description: "new_request: the whole letter instead, salutation and sign-off included.",
          },
          tags: {
            type: "string",
            description:
              "new_request: space-separated tags, machine tags as key:value, to find the " +
              "request later.",
          },
          incoming_message_id: {
            type: "integer",
            description: "reply: the response being answered (the number in `incoming-<n>`).",
          },
        },
      },
      run(a) {
        const need = <T>(v: T | undefined, what: string): T => {
          if (!v) throw new Error(`${a.action} needs \`${what}\`.`);
          return v;
        };
        const slug = () => {
          const ref = requestRef(need(a.request, "request"));
          if (!("slug" in ref)) throw new Error("Pass the request's slug, not its numeric id.");
          return ref.slug;
        };
        const body = () => slugOf(need(a.authority, "authority"), "body");
        const url = (() => {
          switch (a.action) {
            case "new_request":
              if (a.default_letter && a.body)
                throw new Error("Give `default_letter` or `body`, not both.");
              return `/new/${body()}${qs({ title: a.title, default_letter: a.default_letter, body: a.body, tags: a.tags })}`;
            case "reply":
              return `/request/${slug()}/followups/new${a.incoming_message_id ? `/${a.incoming_message_id}` : ""}`;
            case "internal_review":
              return `/request/${slug()}/followups/new?internal_review=1`;
            case "annotate":
              return `/request/${slug()}/annotate`;
            case "report":
              return `/request/${slug()}/report/new`;
            case "add_citation":
              return `/request/${slug()}/citations/new`;
            case "download_zip":
              return `/request/${slug()}/download`;
            case "track":
              if (a.request) return `/request/${slug()}/track`;
              if (a.authority) return `/track/body/${body()}`;
              if (a.user) return `/track/user/${slugOf(a.user, "user")}`;
              return `/track/search/${encodeURIComponent(need(a.query, "request, authority, user or query"))}`;
            case "change_request":
              return a.authority ? `/change_request/new/${body()}` : "/change_request/new";
            case "select_authority":
              return `/select_authority${qs({ query: a.query })}`;
            case "contact":
              return "/help/contact";
          }
        })();
        return { action: a.action, url: ORIGIN + url };
      },
    }),

    full_request: tool({
      description:
        "Every message of one Right to Know request in full, with its attachments (name, size, " +
        "and a url for righttoknow_full_attachment). The page is kept: a later call reuses it " +
        "unless the request has a newer message, which the free JSON shows. Try " +
        "righttoknow_request first; its snippets are often enough.",
      confirm: CHALLENGED,
      input: {
        type: "object",
        required: ["request"],
        properties: {
          request: { type: "string", description: "Slug, numeric id or request URL." },
          unfold: {
            type: "boolean",
            description:
              "Include the quoted earlier emails folded under 'show quoted sections'. A " +
              "separate page from the folded one, kept separately. Default false.",
          },
          messages: {
            type: "string",
            enum: ["all", "latest"],
            description: "Which messages to return. Default all.",
          },
          max_chars: {
            type: "integer",
            description:
              "Cut each message body to this many characters; 0 for no limit. Default 6000. " +
              "Cut messages are marked truncated.",
          },
          force: {
            type: "boolean",
            description: "Load the page again even if the kept copy is current. Default false.",
          },
        },
      },
      async run(
        { request, unfold = false, messages = "all", max_chars = 6000, force = false },
        { env },
      ) {
        const meta = await requestMeta(env, request);
        const page = `${ORIGIN}/request/${meta.url_title}${unfold ? "?unfold=1" : ""}`;
        // The newest message the JSON knows of. If the kept page lacks it, the page is stale.
        const newest = (meta.info_request_events ?? [])
          .filter((e) => e.incoming_message_id || e.outgoing_message_id)
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
          .map(anchorOf)[0];
        let all = parseCorrespondence(await kept(env, page, { force }), page);
        let reloaded = force;
        if (!force && newest && !all.some((m) => m.id === newest)) {
          all = parseCorrespondence(await kept(env, page, { force: true }), page);
          reloaded = true;
        }
        let msgs = messages === "latest" ? all.slice(-1) : all;
        if (max_chars > 0)
          msgs = msgs.map((m) =>
            m.text.length > max_chars
              ? { ...m, text: m.text.slice(0, max_chars) + " […]", truncated: true }
              : m,
          );
        return {
          ...summary(meta),
          page: reloaded ? "loaded from Right to Know" : "kept copy, current",
          ...(newest && !all.some((m) => m.id === newest)
            ? { note: `${newest} is in the event history but not on the page (hidden?).` }
            : {}),
          messages: msgs,
        };
      },
    }),

    full_attachment: tool({
      description:
        "Read a document attached to a Right to Know response: a decision letter, schedule or " +
        "released documents, converted to markdown. Pass an attachment `url` from " +
        "righttoknow_full_request. A document is kept for good once loaded, so asking again " +
        "costs nothing.",
      confirm: CHALLENGED,
      input: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "Attachment download URL, or its 'View' URL." },
          force: {
            type: "boolean",
            description: "Load it again even though a copy is kept. Default false.",
          },
        },
      },
      async run({ url, force = false }, { env }) {
        const u = new URL(url, ORIGIN);
        if (u.hostname !== new URL(ORIGIN).hostname || !u.pathname.includes("/attach/"))
          throw new Error("Not a Right to Know attachment URL.");
        // One download per document: the "View" form maps onto the download form.
        const path = u.pathname.replace("/attach/html/", "/attach/").replace(/\.html$/, "");
        const download = ORIGIN + path;
        return { url: download, text: await kept(env, download, { format: "markdown", force }) };
      },
    }),
  },
});
