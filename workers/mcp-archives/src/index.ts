/**
 * mcp-archives — the Wayback Machine, exposing only the endpoints that answer reliably.
 *
 *   archives_timemap          every snapshot of one URL, oldest first
 *   archives_nearest_capture  one snapshot: earliest, latest, or closest to a date
 *   archives_cdx_search       the full CDX index, for bulk and analytical queries
 *   archives_save_wayback     archive a URL via Save Page Now 2   (needs IA keys)
 *   archives_save_status      poll a save job                     (needs IA keys)
 *
 * Deliberately absent: the Availability API and Memento TimeGate (both return wrong answers),
 * MemGator (public instances have been down for years) and archive.today (blocks automation).
 */
import cfg from "../wrangler.json";
import pkg from "../package.json";
import { mcpWorker, tool } from "../../../core/mcp";
import { ICONS } from "../../../core/icons";
import { cdx, cdxOne, rowsOf, wbDate, TIMEMAP, UA, type Row } from "./cdx";

/** Tool arguments are snake_case; CDX wants camelCase. Only the names that actually differ. */
const CDX_NAME: Record<string, string> = {
  match_type: "matchType",
  fast_latest: "fastLatest",
  show_resume_key: "showResumeKey",
  resume_key: "resumeKey",
  resolve_revisits: "resolveRevisits",
  show_dupe_count: "showDupeCount",
  show_skip_count: "showSkipCount",
  last_skip_timestamp: "lastSkipTimestamp",
  page_size: "pageSize",
  show_num_pages: "showNumPages",
  show_paged_index: "showPagedIndex",
};

const noKeys = {
  error: true,
  message:
    "Internet Archive keys are not set on this worker. Add IA_ACCESS_KEY and IA_SECRET_KEY " +
    "(get a pair at https://archive.org/account/s3.php).",
};
/** The headers every Save Page Now call needs, or null when the worker has no keys. */
const iaAuth = (env: Env) =>
  env.IA_ACCESS_KEY && env.IA_SECRET_KEY
    ? {
        Accept: "application/json",
        Authorization: `LOW ${env.IA_ACCESS_KEY}:${env.IA_SECRET_KEY}`,
        "User-Agent": UA,
      }
    : null;

const snapshot = (row: Row) => ({
  url: row["url"],
  timestamp: row["timestamp"],
  datetime: row["datetime"],
  status: row["statuscode"],
  mimetype: row["mimetype"],
  digest: row["digest"],
  length: row["length"],
  original: row["original"],
});

export default mcpWorker({
  ...cfg,
  version: pkg.version,
  icon: ICONS.archives,
  info: () => ({
    title: "Wayback Machine",
    description: "Find, read and create Internet Archive snapshots.",
    websiteUrl: "https://archive.org/help/wayback_api.php",
    instructions:
      "Use nearest_capture for a single snapshot and cdx_search for anything analytical. " +
      "Always pass match_type to cdx_search rather than wildcards in the url.",
  }),
  tools: {
    timemap: tool({
      description:
        "List every archived snapshot of a URL, oldest first. " +
        "For one snapshot use nearest_capture; for bulk or filtered queries use cdx_search.",
      input: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "URL to look up." },
          limit: {
            type: "integer",
            default: 50,
            description:
              "Max snapshots, keeping the MOST RECENT N. For the earliest N use cdx_search " +
              "with a positive limit. 0 or negative returns everything. Default 50.",
          },
        },
      },
      async run({ url, limit = 50 }) {
        const api_url = `${TIMEMAP}/${url}`;
        const res = await fetch(api_url, { headers: { "User-Agent": UA }, redirect: "follow" });
        if (res.status === 404) return { results: [], count: 0, message: "No snapshots found." };
        const body = await res.text();
        if (!res.ok) return { error: true, status: res.status, message: body.slice(0, 500) };
        const all = rowsOf(JSON.parse(body));
        const results = limit > 0 ? all.slice(-limit) : all;
        return { results, count: results.length, total: all.length, api_url };
      },
    }),

    nearest_capture: tool({
      description:
        "Return a single Wayback snapshot for a URL — earliest, latest, or closest to a date. " +
        "Backed by CDX, so it works where the Availability API and Memento TimeGate do not.",
      input: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "URL to find a snapshot for." },
          prefer: {
            type: "string",
            enum: ["earliest", "latest", "closest"],
            default: "earliest",
            description:
              "'earliest' (default) is the first capture ever, which is what you want when " +
              "verifying an article near publication; 'latest' is the most recent; 'closest' " +
              "needs `timestamp` and compares the captures either side of it.",
          },
          timestamp: {
            type: "string",
            description:
              "Target timestamp, 1-14 digits YYYYMMDDhhmmss. Required for prefer='closest'.",
          },
        },
      },
      async run({ url, prefer = "earliest", timestamp }) {
        if (prefer === "closest" && !timestamp)
          return { error: true, message: "prefer='closest' needs a timestamp (YYYYMMDDhhmmss)." };
        const seen = (row: Row | undefined, extra: object = {}) =>
          row
            ? { available: true, url, prefer, ...extra, snapshot: snapshot(row) }
            : { available: false, url, prefer, ...extra, message: "No snapshots in Wayback." };

        if (prefer !== "closest") {
          const latest = { limit: -1, fastLatest: "true" };
          const { row, api_url } = await cdxOne({
            url,
            ...(prefer === "latest" ? latest : { limit: 1 }),
          });
          return { ...seen(row), api_url };
        }
        // CDX's own `closest` is broken, so ask either side of the target and compare here.
        const sides = await Promise.allSettled([
          cdxOne({ url, to: timestamp, limit: -1, fastLatest: "true" }),
          cdxOne({ url, from: timestamp, limit: 1 }),
        ]);
        const [before, after] = sides.map((s) => (s.status === "fulfilled" ? s.value : null));
        const target = wbDate(timestamp);
        const gap = (row?: Row) => {
          const at = wbDate(row?.["timestamp"]);
          return at && target ? Math.abs(at.getTime() - target.getTime()) : Infinity;
        };
        // Ties and unparseable timestamps both fall to `before`, the earlier capture.
        const winner =
          gap(before?.row) <= gap(after?.row) ? (before?.row ?? after?.row) : after?.row;
        const errors = sides.flatMap((s, i) =>
          s.status === "rejected" ? [`${i ? "after" : "before"}: ${String(s.reason)}`] : [],
        );
        return {
          ...seen(winner, { requested_timestamp: timestamp }),
          api_urls: { before: before?.api_url ?? null, after: after?.api_url ?? null },
          ...(errors.length && { errors }),
        };
      },
    }),

    cdx_search: tool({
      description:
        "The full Wayback CDX Server API: prefix/host/domain matching, date ranges, regex " +
        "filters on any field, server-side dedup (collapse), field selection and pagination. " +
        "Use it for bulk or analytical queries; for one snapshot use nearest_capture. " +
        "ALWAYS pass match_type — CDX's implicit wildcard parsing ('site.com/*', '*.site.com') " +
        "silently returns zero results in some cases. " +
        "See https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server",
      input: {
        type: "object",
        required: ["url"],
        properties: {
          url: {
            type: "string",
            description:
              "Bare URL to query, e.g. 'example.com/'. Do not use wildcards — set match_type.",
          },
          match_type: {
            type: "string",
            enum: ["exact", "prefix", "host", "domain"],
            description:
              "Match scope: exact (default) this URL only; prefix everything under this path; " +
              "host anything on this host; domain the host and all its subdomains.",
          },
          from: { type: "string", description: "Earliest timestamp, inclusive, 1-14 digits." },
          to: { type: "string", description: "Latest timestamp, inclusive, 1-14 digits." },
          filter: {
            type: "array",
            items: { type: "string" },
            description:
              "Regex filters, 'field:regex' or '!field:regex' to invert, ANDed together. " +
              "Fields: urlkey, timestamp, original, mimetype, statuscode, digest, length. " +
              "E.g. 'statuscode:200', '!mimetype:text/html', 'original:.*hind.*rajab.*'.",
          },
          collapse: {
            type: "array",
            items: { type: "string" },
            description:
              "Collapse adjacent duplicates by field, 'field' or 'field:N' for the first N " +
              "chars. E.g. 'digest' (unique content), 'timestamp:8' (one per day), 'urlkey'.",
          },
          fl: {
            type: "string",
            description:
              "Comma-separated fields to return. Default all: urlkey, timestamp, original, " +
              "mimetype, statuscode, digest, length.",
          },
          limit: {
            type: "integer",
            description:
              "Max results. Positive is the first N; negative the last N, slow unless " +
              "fast_latest. The server caps around 150000.",
          },
          offset: {
            type: "integer",
            description:
              "Skip the first M results. Fine for scrolling, but does not scale — prefer " +
              "show_resume_key for sequential pagination.",
          },
          fast_latest: {
            type: "boolean",
            description: "Faster 'last N' mode for exact matches. Implied by limit=-1.",
          },
          show_resume_key: {
            type: "boolean",
            description:
              "Return a resumption key when more results exist, to pass back as resume_key. " +
              "Preferred over page/page_size, which silently omits recent captures. CDX may " +
              "repeat 1-2 rows at the boundary; dedupe on (timestamp, digest) if that matters.",
          },
          resume_key: {
            type: "string",
            description: "Key from a previous query that ran with show_resume_key.",
          },
          resolve_revisits: {
            type: "boolean",
            default: true,
            description:
              "Resolve warc/revisit records to their real mimetype and length. On by default; " +
              "turn it off only to see raw revisit entries.",
          },
          show_dupe_count: {
            type: "boolean",
            description: "Add a dupecount column, tracking unique digests across the results.",
          },
          show_skip_count: {
            type: "boolean",
            description: "Add a skipcount column: rows dropped by filter or collapse.",
          },
          last_skip_timestamp: {
            type: "boolean",
            description: "With show_skip_count, also give the last skipped capture's timestamp.",
          },
          page: {
            type: "integer",
            description:
              "Zero-indexed page. Known to silently omit recent captures — prefer " +
              "show_resume_key unless you need parallel-safe pagination over old data.",
          },
          page_size: {
            type: "integer",
            description: "Zipnum blocks per page, each roughly 3000 results. Same caveat as page.",
          },
          show_num_pages: {
            type: "boolean",
            description: "Return the page count instead of results, to size up a query first.",
          },
          show_paged_index: {
            type: "boolean",
            description: "Return the raw secondary index. Often access-restricted.",
          },
          output: {
            type: "string",
            enum: ["json", "text"],
            default: "json",
            description: "json (default) returns parsed rows; text returns the raw CDX lines.",
          },
        },
      },
      async run({ output = "json", resolve_revisits = true, show_num_pages, ...rest }) {
        const params: Record<string, unknown> = {};
        if (resolve_revisits) params["resolveRevisits"] = "true";
        if (show_num_pages) params["showNumPages"] = "true";
        for (const [k, v] of Object.entries(rest)) {
          if (v === false) continue; // CDX booleans are flags: absent means off
          params[CDX_NAME[k] ?? k] = v === true ? "true" : v;
        }
        const { data, body, api_url } = await cdx(params);
        if (show_num_pages) {
          const n = Number(body.trim());
          return { num_pages: isNaN(n) ? null : n, raw: body.trim(), api_url };
        }
        if (!Array.isArray(data))
          return output === "text"
            ? { raw: body, api_url }
            : {
                error: true,
                message: "CDX did not return JSON",
                raw: body.slice(0, 1000),
                api_url,
              };

        // With showResumeKey on, CDX tacks `[], ["<key>"]` onto the end of the rows.
        let rows: unknown[] = data;
        const last = rows.at(-1);
        let resume_key: string | undefined;
        if (Array.isArray(last) && last.length === 1 && (rows.at(-2) as unknown[])?.length === 0) {
          resume_key = String(last[0]);
          rows = rows.slice(0, -2);
        }
        const results = rowsOf(rows);
        if (output === "text") return { raw: body, count: results.length, api_url };
        return { results, count: results.length, ...(resume_key && { resume_key }), api_url };
      },
    }),

    save_wayback: tool({
      description:
        "Archive a URL on the Wayback Machine via Save Page Now 2. Returns a job_id — poll it " +
        "with save_status. Needs IA_ACCESS_KEY and IA_SECRET_KEY on the worker.",
      // Creates a snapshot on archive.org, so not read-only, but it destroys nothing.
      annotations: { readOnlyHint: false, destructiveHint: false },
      input: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "URL to archive." },
          capture_all: {
            type: "boolean",
            description: "Also capture error pages (4xx/5xx), not just successful responses.",
          },
          capture_outlinks: {
            type: "boolean",
            description: "Also capture the page's outlinks. Slower, more thorough.",
          },
          capture_screenshot: { type: "boolean", description: "Save a screenshot as well." },
          delay_wb_availability: {
            type: "boolean",
            description: "Delay availability in Wayback so SPN2 can finish its async work first.",
          },
          force_get: {
            type: "boolean",
            description: "Force GET even if the server says otherwise.",
          },
          skip_first_archive: {
            type: "boolean",
            description: "Skip first-time archive work. Faster when the URL was archived before.",
          },
          if_not_archived_within: {
            type: "string",
            description:
              "Only archive if no snapshot exists within this window: '30d', '12h', '1y', or a " +
              "'min,max' range like '2d,1w'.",
          },
          outlinks_availability: {
            type: "boolean",
            description: "Include outlink availability in the response.",
          },
          email_result: { type: "boolean", description: "Email the result to the account owner." },
          js_behavior_timeout: {
            type: "integer",
            description: "Seconds to run JS behaviours during capture. Default 5, max 30.",
          },
          capture_cookie: {
            type: "string",
            description: "Cookie string to send with the capture, for pages behind a login.",
          },
          use_user_agent: { type: "string", description: "User agent SPN2 fetches the URL with." },
          target_username: { type: "string", description: "HTTP basic auth user for the target." },
          target_password: { type: "string", description: "HTTP basic auth password." },
        },
      },
      async run({ url, ...rest }, { env }) {
        const headers = iaAuth(env);
        if (!headers) return noKeys;
        const body = new URLSearchParams({ url });
        for (const [k, v] of Object.entries(rest)) {
          if (v === undefined || v === null || v === "" || v === false) continue;
          body.set(k, v === true ? "1" : String(v)); // SPN2 wants "1", not "true"
        }
        const res = await fetch("https://web.archive.org/save", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        if (!res.ok)
          return { error: true, status: res.status, message: (await res.text()).slice(0, 500) };
        return res.json();
      },
    }),

    save_status: tool({
      description:
        "Check a Save Page Now job. Returns 'pending', 'success' or 'error', and on success the " +
        "archived URL. Needs the same IA keys as save_wayback.",
      input: {
        type: "object",
        required: ["job_id"],
        properties: { job_id: { type: "string", description: "Job ID from save_wayback." } },
      },
      async run({ job_id }, { env }) {
        const headers = iaAuth(env);
        if (!headers) return noKeys;
        const at = `${encodeURIComponent(job_id)}?_t=${Date.now()}`; // _t defeats SPN2's caching
        const res = await fetch(`https://web.archive.org/save/status/${at}`, { headers });
        if (!res.ok)
          return { error: true, status: res.status, message: (await res.text()).slice(0, 500) };
        const job = (await res.json()) as {
          status?: string;
          timestamp?: string;
          original_url?: string;
        };
        if (job.status !== "success" || !job.timestamp || !job.original_url) return job;
        const wayback_url = `https://web.archive.org/web/${job.timestamp}/${job.original_url}`;
        return { ...job, wayback_url };
      },
    }),
  },
});
