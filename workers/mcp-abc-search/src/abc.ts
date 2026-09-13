/**
 * ABC's Algolia index, and the formatting of what comes back.
 *
 * The application ID and search key below are the ones abc.net.au ships to every visitor in its
 * own page source: public, read-only, and not a secret worth hiding in a binding.
 */
const APP_ID = "Y63Q32NVDL";
const API_KEY = "bcdf11ba901b780dc3c0a3ca677fbefc";
export const INDEX = "ABC_production_all";
const ENDPOINT = `https://${APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;

export type Hit = {
  title?: string;
  canonicalURL?: string;
  canonicalUrl?: string;
  url?: string;
  link?: { url?: string; permalink?: string };
  id?: string | number;
  docType?: string;
  site?: { title?: string };
  teaserTextPlain?: string;
  synopsis?: string;
  shortDescription?: string;
  description?: string;
  subjects?: unknown[];
  contributors?: unknown[];
  keywords?: string[];
  ml_sentiment?: { label?: string; score?: number };
  transcript?: string;
  dates?: Record<string, string | number | undefined>;
  displayDate?: string;
  publishedDate?: string;
  firstPublished?: string;
  date?: string | number;
} & Record<string, unknown>;

type Facets = Record<string, Record<string, number>>;
type Page = {
  hits?: Hit[];
  nbHits?: number;
  nbPages?: number;
  page?: number;
  hitsPerPage?: number;
  facets?: Facets;
  query?: string;
};

export type Options = {
  page?: number;
  hitsPerPage?: number;
  siteFilter?: string | undefined;
  docType?: string | undefined;
  typoTolerance?: string;
  filters?: string | undefined;
  facets?: string[];
  maxValuesPerFacet?: number;
};

/** One Algolia multi-query request. Returns the single result set it asked for. */
export const search = async (query: string, o: Options = {}): Promise<Page> => {
  const facetFilters = [
    ...(o.siteFilter ? [[`site.title:${o.siteFilter}`]] : []),
    ...(o.docType ? [[`docType:${o.docType}`]] : []),
  ];
  const params = new URLSearchParams({
    query,
    page: String(o.page ?? 0),
    hitsPerPage: String(o.hitsPerPage ?? 20),
    facets: JSON.stringify(o.facets ?? ["docType", "site.title"]),
    maxValuesPerFacet: String(o.maxValuesPerFacet ?? 50),
    getRankingInfo: "true",
    clickAnalytics: "false",
    analytics: "false",
  });
  if (o.typoTolerance && o.typoTolerance !== "true") params.set("typoTolerance", o.typoTolerance);
  if (facetFilters.length) params.set("facetFilters", JSON.stringify(facetFilters));
  if (o.filters) params.set("filters", o.filters);

  const url = `${ENDPOINT}?x-algolia-api-key=${API_KEY}&x-algolia-application-id=${APP_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: JSON.stringify({ requests: [{ indexName: INDEX, params: params.toString() }] }),
  });
  if (!res.ok) throw new Error(`Algolia ${res.status}: ${await res.text()}`);
  const { results } = (await res.json()) as { results?: Page[] };
  return results?.[0] ?? {};
};

const unix = (date: string | undefined, endOfDay: boolean) => {
  if (!date) return null;
  const at = new Date(`${date}T${endOfDay ? "23:59:59" : "00:00:00"}Z`);
  return isNaN(at.getTime()) ? null : Math.floor(at.getTime() / 1000);
};

/** The caller's own filter expression, ANDed with whatever date range they gave. */
export const filtersFor = (own?: string, from?: string, to?: string) => {
  const since = unix(from, false);
  const until = unix(to, true);
  return (
    [
      ...(since ? [`unixDates.displayPublished >= ${since}`] : []),
      ...(until ? [`unixDates.displayPublished <= ${until}`] : []),
      ...(own ? [own] : []),
    ].join(" AND ") || undefined
  );
};

// ─── Formatting ────────────────────────────────────────────────────────────────────────────────

/** Subjects and contributors arrive as either a bare string or an object naming itself. */
const nameOf = (v: unknown) =>
  typeof v === "string" ? v : String((v as { name?: string; title?: string })?.name ?? "");

const urlOf = (h: Hit) =>
  h.canonicalURL ??
  h.canonicalUrl ??
  h.link?.url ??
  h.url ??
  (h.link?.permalink ? `https://www.abc.net.au${h.link.permalink}` : "");

const dateOf = (h: Hit) => {
  const raw =
    h.dates?.["displayPublished"] ??
    h.dates?.["displayDate"] ??
    h.displayDate ??
    h.publishedDate ??
    h.dates?.["published"] ??
    h.firstPublished ??
    h.date;
  if (raw === undefined || raw === null) return "";
  // Some records carry seconds, some milliseconds; anything past 1e12 is already in ms.
  if (typeof raw === "number")
    return new Date(raw > 1e12 ? raw : raw * 1000).toISOString().slice(0, 10);
  return raw.includes("T") ? raw.split("T")[0]! : raw;
};

const line = (label: string, v: string) => (v ? `    ${label}: ${v}\n` : "");

export const formatHit = (h: Hit, num: number, withTranscript: boolean) => {
  const teaser = h.teaserTextPlain ?? h.synopsis ?? h.shortDescription ?? h.description ?? "";
  const transcript = h.transcript ?? "";
  const sentiment = h.ml_sentiment
    ? `${h.ml_sentiment.label} (${h.ml_sentiment.score?.toFixed(2)})`
    : "";
  const words = transcript ? transcript.split(/\s+/).length : 0;
  return (
    `[${num}] ${h.title ?? "Untitled"}\n` +
    line("URL", urlOf(h)) +
    line("Date", dateOf(h)) +
    line("Type", h.docType ?? "") +
    line("Site", h.site?.title ?? "") +
    line("By", (h.contributors ?? []).map(nameOf).filter(Boolean).join(", ")) +
    line("Subjects", (h.subjects ?? []).map(nameOf).filter(Boolean).join(", ")) +
    line("Keywords", (h.keywords ?? []).slice(0, 8).join(", ")) +
    line("Sentiment", sentiment) +
    (teaser ? `    ${teaser.slice(0, 300)}${teaser.length > 300 ? "…" : ""}\n` : "") +
    (transcript && withTranscript
      ? `\n    ── Transcript ──\n${transcript}\n    ── End transcript ──\n`
      : transcript
        ? `    [Transcript available (${transcript.length} chars, ~${words} words). ` +
          `Set include_transcript=true to retrieve.]\n`
        : "") +
    "\n"
  );
};

const topFacets = (facets: Facets, limit = 10) =>
  Object.entries(facets)
    .map(([field, values]) => {
      const top = Object.entries(values)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([k, v]) => `${k} (${v})`);
      return `${field}: ${top.join(", ")}\n`;
    })
    .join("");

export const formatResults = (r: Page, withTranscript: boolean) => {
  const { hits = [], nbHits = 0, nbPages = 0, page = 0, hitsPerPage = 20 } = r;
  const head =
    `Found ${nbHits} results (page ${page + 1} of ${nbPages})\n` +
    (r.facets ? topFacets(r.facets) : "") +
    "\n";
  if (!hits.length) return head + "No matching articles found.";
  const body = hits
    .map((h, i) => formatHit(h, page * hitsPerPage + i + 1, withTranscript))
    .join("");
  const more = page + 1 < nbPages ? `\nMore results available — ask for page ${page + 1}.\n` : "";
  return head + body + more;
};

export const formatFacets = (r: Page) => {
  const head = `Facets for query "${r.query || "*"}" (${r.nbHits ?? 0} total hits):\n\n`;
  if (!r.facets || !Object.keys(r.facets).length)
    return (
      head +
      "No facet data. Those field names may not exist, or may not be faceted in this index.\n"
    );
  return (
    head +
    Object.entries(r.facets)
      .map(([field, values]) => {
        const sorted = Object.entries(values).sort((a, b) => b[1] - a[1]);
        const rows = sorted.map(([v, n]) => `  ${v}: ${n}\n`).join("");
        return `── ${field} (${sorted.length} values) ──\n${rows}\n`;
      })
      .join("")
  );
};

/** Every field of one hit, so a caller can work out what a filter expression may refer to. */
const fieldList = (obj: object, prefix = ""): string =>
  Object.entries(obj)
    .map(([key, val]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(val)) return `${path}: array[${val.length}]\n`;
      if (val && typeof val === "object") return `${path}: object\n` + fieldList(val, path);
      const preview =
        typeof val === "string" ? val.slice(0, 80) + (val.length > 80 ? "…" : "") : String(val);
      return `${path}: ${val === null ? "null" : typeof val} = ${preview}\n`;
    })
    .join("");

export const formatSchema = (r: Page) => {
  const hit = r.hits?.[0];
  if (!hit) return "No results — cannot discover schema.";
  const { _highlightResult, _snippetResult, _rankingInfo, ...clean } = hit;
  return (
    `Sample hit from index "${INDEX}":\n\n${JSON.stringify(clean, null, 2)}\n\n` +
    `--- Field summary ---\n${fieldList(clean)}`
  );
};
