/**
 * The Senate's questions on notice database at aph.gov.au/qon, through the JSON endpoints its
 * own search page calls. Two databases share the API:
 *
 *   written questions   the Notice Paper: a senator asks a minister, numbered per Parliament
 *   estimates questions taken on notice at Senate estimates hearings, keyed by committee,
 *                       estimates round and portfolio
 *
 * Every endpoint is a form POST. Most answer `{ IsSuccess, Message }` where Message is itself a
 * JSON string (the page's `ei` helper); the attachment list and the estimates detail answer plain
 * JSON (its `ti`). The search bodies copy the DataTables form the page sends field for field,
 * since the server reads the column list to know what it may order by.
 *
 * Dates arrive as ASP.NET's `/Date(ms)/` and leave as Canberra calendar dates.
 */

export const BASE = "https://www.aph.gov.au";

// ─── calling the API ─────────────────────────────────────────────────────────────────────────

/** APH's firewall (Azure Front Door) answers some cloud IPs with an HTML block page. */
export class Blocked extends Error {}

const blockedMessage = (status: number, how?: string | null) =>
  `aph.gov.au's firewall refused the request (HTTP ${status}, "Page Blocked by WAF")` +
  (how ? ` (tried: ${how})` : "") +
  `. The same search works in a browser at ${BASE}/qon.`;

/**
 * What a failed answer means, in words. APH's estimates endpoints answer "Value cannot be null.
 * Parameter name: values" when its database is having trouble: on 28 Nov 2026 they answered it
 * for questions read without trouble the day before. It is not how APH says "no results", so it
 * is reported as a failure to retry later, never as an empty result.
 */
export const failureOf = (path: string, status: number, body: string) => {
  const title = /<title>([\s\S]*?)<\/title>/i
    .exec(body)?.[1]
    ?.replace(/<br\s*\/?>/gi, " ")
    .trim();
  if (status >= 500 && /Value cannot be null/i.test(body))
    return (
      `aph.gov.au ${path}: APH's server failed (HTTP ${status}, "${title ?? "Value cannot be null"}"). ` +
      "This is a fault at APH, not a lack of results; try again later. APH's own search " +
      "pages read the same database, so they may fail too; its download links and ParlWork " +
      "may still work in the meantime."
    );
  return `aph.gov.au ${path}: HTTP ${status} ${title ?? body.slice(0, 200)}`;
};

/** APH's own error page, as mcp-fetch hands it back when the plain fetch's answer stands. */
export const isAphErrorPage = (text: string) =>
  /There seems to be a problem with the page/i.test(text) ||
  /^---\s*\ndescription:\s*5\d\d\b/i.test(text);

const readJson = async (res: Response, path: string): Promise<unknown> => {
  const text = await res.text();
  // The attachment list answers a question with none by sending nothing at all.
  if (res.ok && !text.trim()) return null;
  if (/Page Blocked by WAF/i.test(text) || (res.status === 403 && !text.trim().startsWith("{")))
    throw new Blocked(blockedMessage(res.status, res.headers.get("x-egress-skipped")));
  if (!res.ok) throw new Error(failureOf(path, res.status, text));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`aph.gov.au ${path}: expected JSON, got ${text.slice(0, 200)}`);
  }
};

/**
 * How a request reaches aph.gov.au: a path on BASE, a method and a form body. The worker's own
 * is `direct`, falling back to mcp-fetch's smart route when APH's firewall says no (see
 * index.ts); tests pass their own.
 */
export type Net = (
  path: string,
  init: { method: "GET" | "POST"; body?: string | undefined },
) => Promise<Response>;

export const headersFor = (body?: string) => ({
  Accept: "application/json",
  ...(body !== undefined && { "Content-Type": "application/x-www-form-urlencoded" }),
});

/** Cloudflare's own fetch, from whichever colo runs the worker. */
export const direct: Net = (path, { method, body }) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: headersFor(body),
    ...(body !== undefined && { body }),
  });

/** The `{ IsSuccess, Message }` endpoints, with Message unwrapped. */
export const callWrapped = async <T>(net: Net, path: string, body: URLSearchParams): Promise<T> => {
  const res = await net(path, { method: "POST", body: body.toString() });
  const got = (await readJson(res, path)) as { IsSuccess?: boolean; Message?: string };
  if (!got.IsSuccess) throw new Error(`aph.gov.au ${path}: ${got.Message ?? "no Message"}`);
  try {
    return JSON.parse(got.Message ?? "null") as T;
  } catch {
    // A failure the server chose to word rather than encode.
    throw new Error(`aph.gov.au ${path}: ${got.Message}`);
  }
};

/** The endpoints that answer plain JSON. */
export const callPlain = async <T>(net: Net, path: string, body?: URLSearchParams): Promise<T> =>
  (await readJson(
    await net(path, body ? { method: "POST", body: body.toString() } : { method: "GET" }),
    path,
  )) as T;

// ─── lookup lists ────────────────────────────────────────────────────────────────────────────

export const LISTS = {
  senators: "/api/qon/GetSenators",
  ministries: "/api/qon/GetMinistries/",
  parliaments: "/api/qon/GetParliaments/",
  committees: "/api/qon/GetCommittees",
  portfolios: "/api/qon/GetPortfolios/",
  agencies: "/api/qon/GetAgencies",
  estimates_rounds: "/api/qon/GetEstimatesRounds/",
} as const;
export type ListName = keyof typeof LISTS;

export type Option = { id: string; name: string };

/** Lists change a few times a Parliament; an hour per isolate spares the site repeat calls. */
const LIST_TTL_MS = 60 * 60 * 1000;
const listCache = new Map<string, { at: number; options: Option[] }>();

export const resetCache = () => listCache.clear();

/**
 * One drop-down list. `current` is the page's "Only current …" box; off, it is every one the
 * database has ever had. The page's blank entry (`x`) is dropped, and so is parliaments' "All".
 */
export const list = async (net: Net, name: ListName, current = true): Promise<Option[]> => {
  const key = `${name}:${current}`;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.options;
  const raw = await callWrapped<{ Id: string; Description: string }[]>(
    net,
    LISTS[name],
    new URLSearchParams({ isCurrent: String(current) }),
  );
  const options = (raw ?? [])
    .filter((o) => o.Id !== "x")
    .map((o) => ({ id: String(o.Id), name: o.Description }));
  listCache.set(key, { at: Date.now(), options });
  return options;
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "Shoebridge, David" also answers to "David Shoebridge". */
const namesFor = (name: string) => {
  const [last, first] = name.split(/,\s*/);
  return first ? [norm(name), norm(`${first} ${last}`)] : [norm(name)];
};

/**
 * The options a name picks: an exact match if there is one (so "Defence" is Defence, not also
 * Defence Industry), and otherwise every option holding all its words.
 */
export const matching = (options: Option[], wanted: string): Option[] => {
  const w = norm(wanted);
  const exact = options.filter((o) => namesFor(o.name).includes(w));
  if (exact.length) return exact;
  const words = w.split(" ").filter(Boolean);
  return options.filter((o) => {
    const n = norm(o.name);
    return words.every((word) => n.split(" ").includes(word) || n.includes(word));
  });
};

/**
 * The ID the API wants for a name or an ID. Current entries are searched first and then former
 * ones, so a senator who has left can still be named. Ambiguity is an error naming the
 * candidates, never a guess.
 */
export const resolve = async (net: Net, name: ListName, value: string): Promise<string> => {
  const v = value.trim();
  if (/^\d+$/.test(v)) return v;
  for (const current of [true, false]) {
    const found = matching(await list(net, name, current), v);
    if (found.length === 1) return found[0]!.id;
    if (found.length > 1)
      throw new Error(
        `"${v}" matches ${found.length} ${name}: ` +
          found
            .slice(0, 12)
            .map((o) => `${o.name} (${o.id})`)
            .join("; ") +
          (found.length > 12 ? "; …" : "") +
          ". Be more specific or pass the ID.",
      );
  }
  throw new Error(`No ${name} matches "${v}". qon_list shows the names and IDs.`);
};

// ─── dates ───────────────────────────────────────────────────────────────────────────────────

const canberra = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `/Date(1656424800000)/` → `2022-06-29`, the calendar date in Canberra. */
export const aphDate = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const ms = /\/Date\((-?\d+)/.exec(v)?.[1];
  if (ms) return canberra.format(new Date(Number(ms)));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : canberra.format(d);
};

/**
 * A date filter as the API takes it. The page sends whatever its date picker's `toISOString()`
 * gives; a bare calendar date parses the same way on a .NET server without any time-zone shift,
 * so that is what goes.
 */
export const dateParam = (v?: string | undefined) => {
  if (!v) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Dates are YYYY-MM-DD; got "${v}".`);
  return v;
};

// ─── HTML → text ─────────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  sbquo: "‚",
  bdquo: "„",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  deg: "°",
  copy: "©",
  reg: "®",
  trade: "™",
  sect: "§",
  para: "¶",
  times: "×",
  divide: "÷",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  pound: "£",
  euro: "€",
  cent: "¢",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  aacute: "á",
  agrave: "à",
  acirc: "â",
  iacute: "í",
  oacute: "ó",
  ouml: "ö",
  uuml: "ü",
  auml: "ä",
  ccedil: "ç",
  ntilde: "ñ",
  laquo: "«",
  raquo: "»",
  shy: "",
};

export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

const roman = (n: number) => {
  const table: [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let out = "";
  for (const [v, s] of table) while (n >= v) ((out += s), (n -= v));
  return out;
};

type Style = "decimal" | "lower-alpha" | "upper-alpha" | "lower-roman" | "upper-roman" | "bullet";

const styleOf = (attrs: string): Style | undefined => {
  const css = /list-style-type\s*:\s*([a-z-]+)/i.exec(attrs)?.[1]?.toLowerCase();
  const type = /\btype\s*=\s*["']?([1aAiI])/.exec(attrs)?.[1];
  const v = css ?? type;
  switch (v) {
    case "decimal":
    case "1":
      return "decimal";
    case "lower-alpha":
    case "lower-latin":
    case "a":
      return "lower-alpha";
    case "upper-alpha":
    case "upper-latin":
    case "A":
      return "upper-alpha";
    case "lower-roman":
    case "i":
      return "lower-roman";
    case "upper-roman":
    case "I":
      return "upper-roman";
    case "disc":
    case "circle":
    case "square":
      return "bullet";
  }
  return undefined;
};

/** The parliamentary convention when nothing says otherwise: 1. then (a) then (i). */
const DEPTH_DEFAULT: Style[] = ["decimal", "lower-alpha", "lower-roman"];

const marker = (style: Style, n: number) => {
  switch (style) {
    case "decimal":
      return `${n}.`;
    case "lower-alpha":
      return `(${String.fromCharCode(96 + ((n - 1) % 26) + 1)})`;
    case "upper-alpha":
      return `(${String.fromCharCode(64 + ((n - 1) % 26) + 1)})`;
    case "lower-roman":
      return `(${roman(n)})`;
    case "upper-roman":
      return `(${roman(n).toUpperCase()})`;
    case "bullet":
      return "•";
  }
};

const BLOCK = new Set([
  "p",
  "div",
  "br",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "table",
]);

/**
 * Question and answer HTML as plain text that keeps the numbering, so "question 3(b)" can be
 * cited. Each list item's marker comes from its own style, else its list's, else the item
 * before it, else 1. / (a) / (i) by depth. That last-but-one step follows what a drafter meant
 * when one item in an (a)–(c) run lost its style, which a browser would number 3.
 */
export const htmlToText = (html = ""): string => {
  if (!html) return "";
  const lines: string[] = [];
  // A list marker's indent is kept apart from the text, whose runs of spaces collapse.
  let indent = "";
  let line = "";
  const flush = () => {
    const t = line.replace(/[ \t\u00a0]+/g, " ").trim();
    if (t) lines.push(indent + t);
    indent = line = "";
  };
  type List = { style?: Style | undefined; ordered: boolean; count: number; last?: Style };
  const stack: List[] = [];
  const tokens = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g);
  for (const [, close, rawTag, attrs = "", text] of tokens) {
    if (text !== undefined) {
      const t = decodeEntities(text).replace(/\s+/g, " ");
      line += line.trim() ? t : t.trimStart();
      continue;
    }
    const tag = rawTag!.toLowerCase();
    if (tag === "ol" || tag === "ul") {
      flush();
      if (close) stack.pop();
      else stack.push({ ordered: tag === "ol", style: styleOf(attrs), count: 0 });
    } else if (tag === "li" && !close) {
      flush();
      const list = stack[stack.length - 1];
      const depth = Math.max(stack.length - 1, 0);
      if (!list) {
        line = "• ";
        continue;
      }
      list.count += 1;
      const style =
        styleOf(attrs) ??
        list.style ??
        list.last ??
        (list.ordered ? DEPTH_DEFAULT[depth % DEPTH_DEFAULT.length]! : "bullet");
      list.last = style;
      indent = "  ".repeat(depth);
      line = `${marker(style, list.count)} `;
    } else if (tag === "li" || BLOCK.has(tag)) {
      flush();
    } else if (tag === "td" || tag === "th") {
      line += close ? "" : line.trim() ? " | " : "";
    }
  }
  flush();
  return lines.join("\n");
};

// ─── searching ───────────────────────────────────────────────────────────────────────────────

/** What the status box sends. "overdue" is unanswered for more than 30 days. */
export const STATUS = { all: "0", answered: "1", unanswered: "2", overdue: "3", withdrawn: "4" };
export type Status = keyof typeof STATUS;

/** DataTables columns, exactly as the page lists them. Orderable up to and including the index. */
const WRITTEN_COLUMNS = [
  "Number",
  "Senators",
  "Ministry",
  "Status",
  "AskedDate",
  "AnsweredDate",
  "IsMultiPortfolioQuestion",
  "IsTransferred",
  "QuestionText",
  "AnswerText",
  "10",
];
const WRITTEN_ORDERABLE = 5;
const ESTIMATES_COLUMNS = [
  "Number",
  "Senators",
  "Committee",
  "EstimatesRoundName",
  "Portfolio",
  "BroadTopic",
  "Agency",
  "Status",
  "AskedDate",
  "Overdue",
  "IsMultiPortfolioQuestion",
  "IsTransferred",
  "ProofHansardPage",
  "PortfolioQuestionNumber",
  "QuestionText",
  "AnswerText",
  "",
];
const ESTIMATES_ORDERABLE = 9;

export const WRITTEN_ORDER = [
  "number",
  "senator",
  "ministry",
  "status",
  "asked",
  "answered",
] as const;
export const ESTIMATES_ORDER = [
  "number",
  "senator",
  "committee",
  "round",
  "portfolio",
  "topic",
  "agency",
  "status",
  "asked",
  "overdue",
] as const;

const tableForm = (
  columns: string[],
  orderable: number,
  order: { column: number; dir: "asc" | "desc" },
  start: number,
  length: number,
) => {
  const f = new URLSearchParams();
  f.set("draw", "1");
  columns.forEach((c, i) => {
    f.set(`columns[${i}][data]`, c);
    f.set(`columns[${i}][name]`, "");
    f.set(`columns[${i}][searchable]`, "true");
    f.set(`columns[${i}][orderable]`, String(i <= orderable));
    f.set(`columns[${i}][search][value]`, "");
    f.set(`columns[${i}][search][regex]`, "false");
  });
  f.set("order[0][column]", String(order.column));
  f.set("order[0][dir]", order.dir);
  f.set("start", String(start));
  f.set("length", String(length));
  f.set("search[value]", "");
  f.set("search[regex]", "false");
  f.set("questionTextId", "");
  return f;
};

/** Optional fields that may also be passed as undefined, as tool arguments are. */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };

export type WrittenQuery = Loose<{
  keywords?: string;
  senator?: string; // IDs by now
  ministry?: string;
  parliament?: string; // a number, or "x" for all
  questionNumber?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: Status;
  orderBy?: (typeof WRITTEN_ORDER)[number];
  dir?: "asc" | "desc";
}>;

export const writtenForm = (q: WrittenQuery, start: number, length: number) => {
  const f = tableForm(
    WRITTEN_COLUMNS,
    WRITTEN_ORDERABLE,
    { column: Math.max(WRITTEN_ORDER.indexOf(q.orderBy ?? "number"), 0), dir: q.dir ?? "desc" },
    start,
    length,
  );
  f.set("fieldKeywords", q.keywords ?? "");
  f.set("fieldParliament", q.parliament || "x");
  f.set("fieldSenator", q.senator || "x");
  f.set("fieldMinistry", q.ministry || "x");
  f.set("fieldQuestionNumber", q.questionNumber ?? "");
  f.set("fieldDateFrom", dateParam(q.dateFrom));
  f.set("fieldDateTo", dateParam(q.dateTo));
  f.set("fieldStatus", STATUS[q.status ?? "all"]);
  return f;
};

export type EstimatesQuery = Loose<{
  keywords?: string;
  senator?: string;
  committee?: string;
  round?: string;
  portfolio?: string;
  agency?: string;
  questionNumber?: string;
  portfolioQuestionNumber?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: Status;
  orderBy?: (typeof ESTIMATES_ORDER)[number];
  dir?: "asc" | "desc";
}>;

export const estimatesForm = (q: EstimatesQuery, start: number, length: number) => {
  const f = tableForm(
    ESTIMATES_COLUMNS,
    ESTIMATES_ORDERABLE,
    { column: Math.max(ESTIMATES_ORDER.indexOf(q.orderBy ?? "number"), 0), dir: q.dir ?? "desc" },
    start,
    length,
  );
  f.set("fieldKeywords", q.keywords ?? "");
  f.set("fieldCommittee", q.committee || "x");
  f.set("fieldEstimatesRound", q.round || "x");
  f.set("fieldSenator", q.senator || "x");
  f.set("fieldPortfolio", q.portfolio || "x");
  f.set("fieldAgency", q.agency || "x");
  f.set("fieldQuestionNumber", q.questionNumber ?? "");
  f.set("fieldPortfolioQuestionNumber", q.portfolioQuestionNumber ?? "");
  f.set("fieldDateFrom", dateParam(q.dateFrom));
  f.set("fieldDateTo", dateParam(q.dateTo));
  f.set("fieldStatus", STATUS[q.status ?? "all"]);
  return f;
};

type Table<R> = { recordsTotal?: number; recordsFiltered?: number; data?: R[] };

/** The API serves at most a page at a time; the page itself offers 100 as its largest. */
export const PAGE = 100;

/**
 * Up to `limit` rows from `offset`, a page of at most 100 at a time, stopping early when the
 * server runs out.
 */
export const searchTable = async <R>(
  net: Net,
  path: string,
  form: (start: number, length: number) => URLSearchParams,
  offset: number,
  limit: number,
): Promise<{ total: number; rows: R[] }> => {
  const rows: R[] = [];
  let total = 0;
  while (rows.length < limit) {
    const length = Math.min(PAGE, limit - rows.length);
    const got = await callWrapped<Table<R>>(net, path, form(offset + rows.length, length));
    total = got.recordsFiltered ?? got.recordsTotal ?? 0;
    const data = got.data ?? [];
    rows.push(...data);
    if (data.length < length || offset + rows.length >= total) break;
  }
  return { total, rows };
};

/** Scanning stops here unless told otherwise: ten pages of 100. */
export const SCAN_DEFAULT = 1000;
export const SCAN_MAX = 5000;

/**
 * Rows that pass `keep`, read a page of 100 at a time from `offset`, until `limit` have passed,
 * `scan` rows have been read, or the server runs out. For a filter the server cannot apply
 * itself: written questions' Keywords box matches minister and portfolio names, not the text.
 * `next_offset` is where to carry on, when there is more to read.
 */
export const scanTable = async <R>(
  net: Net,
  path: string,
  form: (start: number, length: number) => URLSearchParams,
  keep: (row: R) => boolean,
  offset: number,
  limit: number,
  scan: number,
): Promise<{ total: number; scanned: number; rows: R[]; next_offset?: number }> => {
  const rows: R[] = [];
  let total = 0;
  let at = offset;
  while (rows.length < limit && at - offset < scan) {
    const length = Math.min(PAGE, scan - (at - offset));
    const got = await callWrapped<Table<R>>(net, path, form(at, length));
    total = got.recordsFiltered ?? got.recordsTotal ?? 0;
    const data = got.data ?? [];
    for (const row of data) {
      at += 1;
      if (keep(row)) rows.push(row);
      if (rows.length >= limit) break;
    }
    if (data.length < length) break;
  }
  return { total, scanned: at - offset, rows, ...(at < total && { next_offset: at }) };
};

/**
 * Terms as a list, however they came: a list, a JSON list in a string, or comma-separated words.
 * A client holding a tool list from before `contains` existed sends it as a string.
 */
export const termsOf = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== "string") return [];
  const s = v.trim();
  if (s.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Not JSON after all: read it as words.
    }
  }
  return s.split(",");
};

/** True when any of the terms appears in the question or answer, ignoring case. */
export const mentions = (terms: unknown) => {
  const wanted = termsOf(terms)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return (r: { QuestionText?: string; AnswerText?: string }) => {
    const text = `${htmlToText(r.QuestionText)}\n${htmlToText(r.AnswerText)}`.toLowerCase();
    return wanted.some((t) => text.includes(t));
  };
};

// ─── rows ────────────────────────────────────────────────────────────────────────────────────

export type WrittenRow = {
  Id: number;
  Number: number;
  AskedDate?: string;
  AnsweredDate?: string | null;
  Surname?: string;
  Firstname?: string;
  Title?: string;
  Ministry?: string;
  Prefix?: string;
  Answered?: boolean;
  Status?: string;
  Overdue?: string;
  ParliamentNumber?: number;
  QuestionText?: string;
  AnswerText?: string;
  IsTransferred?: boolean;
  IsMultiPortfolioQuestion?: boolean;
};

export type TextMode = "full" | "snippet" | "none";
export const SNIPPET = 600;

export const textFor = (html: string | undefined, mode: TextMode) => {
  if (mode === "none") return undefined;
  const t = htmlToText(html);
  if (!t) return mode === "full" ? "" : undefined;
  return mode === "snippet" && t.length > SNIPPET ? `${t.slice(0, SNIPPET).trimEnd()}…` : t;
};

export const writtenDownload = (parliament: number | string, number: number | string) =>
  `${BASE}/api/qon/downloadquestions/Question-ParliamentNumber${parliament}-QuestionNumber${number}`;

// ─── links to APH's own pages ────────────────────────────────────────────────────────────────

/** The parameters APH's search pages read from their address, empty ones left out. */
const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  return q.toString();
};

/**
 * APH's written-questions search page, filled in and run. The page reads keywords, senator and
 * ministry (as IDs), parliament, questionNumber, dateFrom, dateTo and status from its address,
 * and ticking off "only current" lets a former senator or ministry show.
 */
export const writtenSearchPage = (q: WrittenQuery) =>
  `${BASE}/qon?${query({
    keywords: q.keywords,
    senator: q.senator,
    ministry: q.ministry,
    parliament: q.parliament,
    questionNumber: q.questionNumber,
    dateFrom: q.dateFrom,
    dateTo: q.dateTo,
    status: q.status && q.status !== "all" ? q.status : undefined,
    onlyCurrentSenators: "false",
    onlyCurrentMinistries: "false",
  })}`;

export const writtenPage = (parliament: number | string, number: number | string) =>
  writtenSearchPage({ parliament: String(parliament), questionNumber: String(number) });

/**
 * ParlWork, the Senate's own system, which shows a current question at
 * parlwork.aph.gov.au/senate/questions/<number>. Numbers restart each Parliament, so the link
 * is only given for the current one.
 */
export const parlworkPage = (number: number | string) =>
  `https://parlwork.aph.gov.au/senate/questions/${number}`;

/** The Senate Estimates page, whose question search reads these from its address. */
const ESTIMATES_PAGE = `${BASE}/Parliamentary_Business/Senate_Estimates`;

export const estimatesSearchPage = (q: EstimatesQuery) =>
  `${ESTIMATES_PAGE}?${query({
    keywords: q.keywords,
    senator: q.senator,
    committee: q.committee,
    estimatesRound: q.round,
    portfolio: q.portfolio,
    agency: q.agency,
    questionNumber: q.questionNumber,
    portfolioQuestionNumber: q.portfolioQuestionNumber,
    dateFrom: q.dateFrom,
    dateTo: q.dateTo,
    status: q.status && q.status !== "all" ? q.status : undefined,
    onlyCurrentSenators: "false",
    onlyCurrentCommittees: "false",
    onlyCurrentPortfolios: "false",
    onlyCurrentAgencies: "false",
  })}`;

export const estimatesPage = (r: {
  CommitteeId?: number | string;
  EstimatesRoundId?: number | string;
  PortfolioId?: number | string;
  Number?: number | string;
}) =>
  estimatesSearchPage({
    committee: r.CommitteeId === undefined ? undefined : String(r.CommitteeId),
    round: r.EstimatesRoundId === undefined ? undefined : String(r.EstimatesRoundId),
    portfolio: r.PortfolioId === undefined ? undefined : String(r.PortfolioId),
    questionNumber: r.Number === undefined ? undefined : String(r.Number),
  });

/** The Parliament ParlWork covers; written results from it get a ParlWork link. */
export const PARLWORK_FROM = 48;

export const asWritten = (r: WrittenRow, text: TextMode) => {
  const p = r.ParliamentNumber;
  const who = [r.Title, r.Firstname, r.Surname].filter(Boolean).join(" ");
  return {
    id: r.Id,
    parliament: p,
    number: r.Number,
    senator: who,
    asked_of: [r.Prefix, r.Ministry].filter(Boolean).join(" "),
    ministry: r.Ministry,
    status: r.Status,
    overdue: r.Overdue === "Yes",
    asked: aphDate(r.AskedDate),
    answered: aphDate(r.AnsweredDate),
    transferred: r.IsTransferred ?? false,
    multi_portfolio: r.IsMultiPortfolioQuestion ?? false,
    has_answer: Boolean(r.AnswerText?.trim()),
    question: textFor(r.QuestionText, text),
    answer: textFor(r.AnswerText, text),
    page: p ? writtenPage(p, r.Number) : undefined,
    parlwork: p && p >= PARLWORK_FROM ? parlworkPage(r.Number) : undefined,
    download: p ? writtenDownload(p, r.Number) : undefined,
  };
};

type Asker = { Title?: string; FirstName?: string; Surname?: string };

export type EstimatesRow = {
  Id: number;
  Number?: number;
  PortfolioQuestionNumber?: string | number;
  Senators?: Asker[];
  Committee?: string;
  CommitteeId?: number;
  EstimatesRoundName?: string;
  EstimatesRoundId?: number;
  Portfolio?: string;
  PortfolioId?: number;
  BroadTopic?: string;
  Agency?: string;
  Status?: string;
  AskedDate?: string;
  AnsweredDate?: string | null;
  Overdue?: string;
  ProofHansardPage?: string | number | null;
  IsTransferred?: boolean;
  IsMultiPortfolioQuestion?: boolean;
  QuestionText?: string;
  AnswerText?: string;
};

export const estimatesDownload = (r: {
  CommitteeId?: number | string;
  EstimatesRoundId?: number | string;
  PortfolioId?: number | string;
  Number?: number | string;
}) =>
  `${BASE}/api/qon/downloadestimatesquestions/EstimatesQuestion-CommitteeId${r.CommitteeId}` +
  `-EstimatesRoundId${r.EstimatesRoundId}-PortfolioId${r.PortfolioId}-QuestionNumber${r.Number}`;

export const asEstimates = (r: EstimatesRow, text: TextMode) => ({
  id: r.Id,
  committee_id: r.CommitteeId,
  round_id: r.EstimatesRoundId,
  portfolio_id: r.PortfolioId,
  number: r.Number,
  portfolio_question_number: r.PortfolioQuestionNumber,
  senators: (r.Senators ?? []).map((s) =>
    [s.Title, s.FirstName, s.Surname].filter(Boolean).join(" "),
  ),
  committee: r.Committee,
  round: r.EstimatesRoundName,
  portfolio: r.Portfolio,
  topic: r.BroadTopic,
  agency: r.Agency,
  status: r.Status,
  overdue: r.Overdue === "Yes",
  asked: aphDate(r.AskedDate),
  answered: aphDate(r.AnsweredDate),
  hansard_page: r.ProofHansardPage ?? undefined,
  transferred: r.IsTransferred ?? false,
  multi_portfolio: r.IsMultiPortfolioQuestion ?? false,
  question: textFor(r.QuestionText, text),
  answer: textFor(r.AnswerText, text),
  page:
    r.CommitteeId && r.EstimatesRoundId && r.PortfolioId && r.Number ? estimatesPage(r) : undefined,
  download:
    r.CommitteeId && r.EstimatesRoundId && r.PortfolioId && r.Number
      ? estimatesDownload(r)
      : undefined,
});

// ─── one question's extras ───────────────────────────────────────────────────────────────────

export type Transfer = {
  TransferredOnDate?: string;
  TransferredFrom?: string;
  TransferredTo?: string;
};
export type Attachment = { Id: number | string; Attachment_FileName?: string };

export const transfers = async (net: Net, questionId: number | string) =>
  (
    (await callWrapped<Transfer[] | null>(
      net,
      "/api/qon/gettransfer",
      new URLSearchParams({ questionId: String(questionId) }),
    )) ?? []
  ).map((t) => ({
    date: aphDate(t.TransferredOnDate),
    from: t.TransferredFrom ?? null,
    to: t.TransferredTo ?? null,
  }));

export const attachments = async (net: Net, questionId: number | string) =>
  (
    (await callPlain<Attachment[] | null>(
      net,
      "/api/qon/getattachmentlist",
      new URLSearchParams({ questionId: String(questionId) }),
    )) ?? []
  ).map((a) => ({
    file: a.Attachment_FileName ?? String(a.Id),
    url: `${BASE}/api/qon/downloadattachment?attachmentId=${a.Id}`,
  }));
