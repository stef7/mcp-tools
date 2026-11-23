/**
 * Happy House Sitters (happyhousesitters.com.au), read through the same endpoints its own search
 * page calls (/js/sitters-search.js):
 *
 *   GET /sits/results?page=&isList=true&state=&zoneId=&postcodeId=&sitLength=&startingIn=
 *       &startingDate=&endDate=&noGardenLawnCare=&animalTypeIds=&facilityIds=&orderBy=
 *     JSON: { Items, TotalCount, PageCount, PageSize (15), Page }. No login needed.
 *   GET /ajax/suburb-postcode?term=   select2 lookup: { results: [{ id, text }] }
 *   GET /sits/ad-<id>                 the full ad, HTML only
 *
 * Its own date filter (startingDate/endDate) only returns sits that sit wholly inside the range,
 * so a sit starting 18 Jan and ending 29 Jan is missing from 10–20 Jan. Ranking around a date is
 * therefore done here, over the pages sorted by start (orderBy=3).
 */
import { BROWSER_UA, stripHtml, truncate } from "../../../core/web";

export const BASE = "https://www.happyhousesitters.com.au";
/** Dates on the site are midnight in eastern Australian time, sent as epoch milliseconds. */
const TZ = "Australia/Sydney";

export const STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"] as const;

/** From the search page's "Filter by area" list: id, state, label. */
export const ZONES: [number, string, string][] = [
  [54, "ACT", "Canberra"],
  [23, "NSW", "Syd Lower N. Shore"],
  [24, "NSW", "Syd. Eastern suburbs"],
  [25, "NSW", "Syd. Southern suburbs"],
  [26, "NSW", "Syd. S.W. suburbs"],
  [27, "NSW", "Syd. N.W. suburbs"],
  [52, "NSW", "Syd. Upper N. Shore"],
  [36, "NSW", "Blue Mountains"],
  [35, "NSW", "Newcastle"],
  [28, "NSW", "Rural/Regional NSW"],
  [21, "NT", "Darwin"],
  [20, "NT", "Alice Springs"],
  [22, "NT", "Rural/Regional NT"],
  [14, "QLD", "Bris. Northern suburbs"],
  [15, "QLD", "Bris. Southern suburbs"],
  [16, "QLD", "Bris. S.W suburbs"],
  [17, "QLD", "Bris. Western suburbs"],
  [40, "QLD", "Gold Coast"],
  [18, "QLD", "Sunshine Coast"],
  [19, "QLD", "Rural/Regional QLD"],
  [9, "SA", "Adel. Inner suburbs"],
  [10, "SA", "Adel. Northern suburbs"],
  [11, "SA", "Adel. N.E suburbs"],
  [12, "SA", "Adel. Southern suburbs"],
  [13, "SA", "Rural/Regional SA"],
  [29, "TAS", "Launceston"],
  [30, "TAS", "Hobart"],
  [31, "TAS", "Burnie"],
  [32, "TAS", "Devonport"],
  [33, "TAS", "Rural/Regional TAS"],
  [42, "VIC", "Melb. Inner suburbs"],
  [43, "VIC", "Melb. N.W. suburbs"],
  [44, "VIC", "Melb. N. E suburbs"],
  [45, "VIC", "Melb. S. E suburbs"],
  [37, "VIC", "Geelong"],
  [38, "VIC", "Ballarat"],
  [39, "VIC", "Bendigo"],
  [51, "VIC", "Rural/Regional VIC"],
  [47, "WA", "Perth N.W. suburbs"],
  [48, "WA", "Perth S.W. suburbs"],
  [49, "WA", "Perth N.E. suburbs"],
  [50, "WA", "Perth S.E. suburbs"],
  [53, "WA", "Rural/Regional WA"],
];

export const ANIMALS: Record<string, number> = {
  dog: 1,
  cat: 2,
  fish: 3,
  bird: 4,
  "rabbit/guinea pig": 5,
  reptile: 6,
  cattle: 7,
  sheep: 8,
  chicken: 9,
  horse: 10,
  none: 11,
};

export const FACILITIES: Record<string, number> = {
  wifi: 1,
  "pay tv": 2,
  "pool/spa": 3,
  heating: 4,
  cooling: 5,
  "washing machine": 6,
  dryer: 7,
  car: 8,
  "room for caravan": 9,
  netflix: 18,
  bbq: 19,
  "kids welcome": 20,
  "pets welcome": 21,
  "wheelchair access": 22,
  bus: 10,
  tram: 11,
  train: 12,
  "local shops": 13,
  supermarket: 14,
  mall: 15,
  doctor: 16,
  vet: 17,
  golf: 23,
  "lawn bowls": 24,
  "gym/yoga": 25,
  "restaurant/cafes": 26,
  nightlife: 27,
  cinema: 28,
  "art/theatre": 29,
  parks: 30,
  beach: 31,
  "fishing/boating": 32,
};

/** The site's "Starting In" and "Sit Length" buckets share these values. */
export const BUCKETS = { "1-7": 7, "8-14": 14, "15-30": 30, "31-60": 60, "60+": 61 } as const;

export const SORTS = {
  recent: 1,
  closest: 2,
  starting_soonest: 3,
  longest: 4,
  shortest: 5,
  suburb: 6,
} as const;

export type Query = {
  state?: string;
  zone?: string | number;
  postcode_id?: number;
  animals?: string[];
  facilities?: string[];
  sit_length?: (keyof typeof BUCKETS)[];
  starting_in?: (keyof typeof BUCKETS)[];
  start_date?: string;
  end_date?: string;
  no_garden_lawn_care?: boolean;
  sort?: keyof typeof SORTS;
};

/** One item as /sits/results sends it (the fields used here). */
export type RawSit = {
  Sittingid: number;
  Title?: string;
  Region?: string;
  Rating?: number;
  ReducedContact?: boolean;
  PropertyType?: string;
  Length?: number;
  Pets?: string | null;
  dtSittingStart?: string;
  dtSittingEnd?: string;
  Dates?: string;
  Description?: string;
  ApplicationClose?: string;
  dtApplicationClose?: string;
  PostedAge?: string;
  StartingIn?: string;
  Distance?: number;
  Latitude?: number;
  Longitude?: number;
  IsNew?: boolean;
};
export type Page = {
  Items: RawSit[];
  TotalCount: number;
  PageCount: number;
  PageSize: number;
  Page: number;
};

export type Sit = {
  id: number;
  url: string;
  title: string;
  region: string;
  property_type: string;
  start: string | null;
  end: string | null;
  length_days: number | null;
  dates: string;
  pets: string | null;
  response_rating: number | "reduced contact" | null;
  applications_close: string | null;
  posted: string;
  is_new: boolean;
  distance_km?: number;
  lat?: number;
  lng?: number;
  description: string;
};

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "/Date(1796389200000)/" -> "2026-12-05", read in eastern Australian time. */
export const msDate = (s?: string | null): string | null => {
  const m = s ? /\/Date\((-?\d+)\)\//.exec(s) : null;
  return m ? fmt.format(new Date(Number(m[1]))) : null;
};

/** Whole days from a to b, both YYYY-MM-DD. */
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

/** Today in eastern Australian time, YYYY-MM-DD. */
export const today = () => fmt.format(new Date());

export const normalise = (r: RawSit, descMax = 400): Sit => ({
  id: r.Sittingid,
  url: `${BASE}/sits/ad-${r.Sittingid}`,
  title: r.Title ?? "",
  region: r.Region ?? "",
  property_type: r.PropertyType ?? "",
  start: msDate(r.dtSittingStart),
  end: msDate(r.dtSittingEnd),
  length_days: r.Length ?? null,
  dates: r.Dates ?? "",
  pets: r.Pets || null,
  response_rating: r.ReducedContact ? "reduced contact" : (r.Rating ?? null),
  applications_close: msDate(r.dtApplicationClose),
  posted: r.PostedAge ?? "",
  is_new: !!r.IsNew,
  ...(r.Distance ? { distance_km: Math.round(r.Distance * 10) / 10 } : {}),
  ...(r.Latitude ? { lat: r.Latitude, lng: r.Longitude } : {}),
  description: truncate((r.Description ?? "").replace(/\r\n/g, "\n").trim(), descMax),
});

const pick = (names: string[] | undefined, table: Record<string, number>, what: string) =>
  (names ?? []).map((n) => {
    const key = n
      .toLowerCase()
      .replace(/\(s\)/g, "")
      .replace(/\s*\/\s*/g, "/")
      .trim();
    const hit =
      table[key] ??
      table[key.replace(/s$/, "")] ??
      Object.entries(table).find(([k]) => k.startsWith(key) || key.startsWith(k))?.[1];
    if (hit === undefined)
      throw new Error(`Unknown ${what} "${n}". Known: ${Object.keys(table).join(", ")}`);
    return hit;
  });

export const zoneId = (zone: string | number | undefined, state?: string): number => {
  if (zone === undefined || zone === "" || zone === 0) return 0;
  const n = Number(zone);
  if (Number.isInteger(n) && ZONES.some(([id]) => id === n)) return n;
  const q = String(zone).toLowerCase();
  const hits = ZONES.filter(
    ([, s, name]) => name.toLowerCase().includes(q) && (!state || s === state),
  );
  if (hits.length === 1) return hits[0]![0];
  const list = (hits.length ? hits : ZONES).map(([id, s, name]) => `${id} ${s} ${name}`).join("; ");
  throw new Error(`Zone "${zone}" is ${hits.length ? "ambiguous" : "unknown"}. Zones: ${list}`);
};

/** The query string the site's own page would send for these filters. */
export const searchParams = (q: Query, page: number): URLSearchParams => {
  const state = (q.state ?? "").toUpperCase();
  if (state && !(STATES as readonly string[]).includes(state))
    throw new Error(`Unknown state "${q.state}". Use one of ${STATES.join(", ")}.`);
  const zone = zoneId(q.zone, state || undefined);
  // The site sends the zone's state alongside it; fill it in when only the zone was given.
  const zoneState = zone ? ZONES.find(([id]) => id === zone)![1] : "";
  const buckets = (b?: (keyof typeof BUCKETS)[]) =>
    b?.length ? b.map((k) => BUCKETS[k]).join(",") : "0";
  return new URLSearchParams({
    page: String(page),
    isList: "true",
    state: state || zoneState,
    zoneId: String(zone),
    postcodeId: String(q.postcode_id ?? 0),
    sitLength: buckets(q.sit_length),
    startingIn: buckets(q.starting_in),
    startingDate: q.start_date ?? "",
    endDate: q.end_date ?? "",
    noGardenLawnCare: String(!!q.no_garden_lawn_care),
    animalTypeIds: pick(q.animals, ANIMALS, "animal").join(","),
    facilityIds: pick(q.facilities, FACILITIES, "facility").join(","),
    orderBy: String(SORTS[q.sort ?? "starting_soonest"]),
  });
};

const get = async (path: string, accept = "application/json") => {
  const res = await fetch(BASE + path, {
    headers: {
      "user-agent": BROWSER_UA,
      accept,
      "x-requested-with": "XMLHttpRequest",
      referer: `${BASE}/sits/search`,
    },
  });
  if (!res.ok) throw new Error(`Happy House Sitters answered ${res.status} for ${path}`);
  return res;
};

export const fetchPage = async (q: Query, page: number): Promise<Page> => {
  const res = await get(`/sits/results?${searchParams(q, page)}`);
  const text = await res.text();
  try {
    return JSON.parse(text) as Page;
  } catch {
    throw new Error(`Expected JSON from /sits/results, got: ${text.slice(0, 300)}`);
  }
};

/**
 * Pages 1.. in order, a few at a time, until the last page or `maxPages`. `stop` sees each batch
 * and can end it early, e.g. once a start-sorted list is past the dates wanted.
 */
export const fetchAll = async (
  q: Query,
  maxPages: number,
  stop?: (items: RawSit[]) => boolean,
): Promise<{ items: RawSit[]; total: number; pages: number; read: number }> => {
  const first = await fetchPage(q, 1);
  const items = [...first.Items];
  const pages = first.PageCount;
  let read = 1;
  const BATCH = 5;
  while (read < Math.min(pages, maxPages) && !stop?.(items)) {
    const next = Array.from(
      { length: Math.min(BATCH, Math.min(pages, maxPages) - read) },
      (_, i) => read + 1 + i,
    );
    const got = await Promise.all(next.map((p) => fetchPage(q, p)));
    for (const g of got) items.push(...g.Items);
    read += next.length;
  }
  // A listing added between page reads can push one onto the next page twice.
  const seen = new Set<number>();
  const unique = items.filter((s) => !seen.has(s.Sittingid) && seen.add(s.Sittingid));
  return { items: unique, total: first.TotalCount, pages, read };
};

export type Ranked = Sit & {
  /** Start minus target, in days: negative began before the target date. */
  start_offset_days: number;
  /** The sit is under way on the target date. */
  covers_target: boolean;
  /** Days of the sit left from the target date on (0 if it ends before). */
  days_from_target: number;
};

export type AroundOpts = {
  target: string;
  before_days: number;
  after_days: number;
  include_covering: boolean;
  min_days_from_target: number;
  include_closed: boolean;
  today: string;
};

/**
 * Keep sits that start within [target - before, target + after], plus (optionally) sits already
 * under way on the target date. Closest start first; on a tie, the one lasting longer past the
 * target.
 */
export const rankAround = (sits: Sit[], o: AroundOpts): Ranked[] =>
  sits
    .filter((s): s is Sit & { start: string; end: string } => !!s.start && !!s.end)
    .filter((s) => o.include_closed || !s.applications_close || s.applications_close >= o.today)
    .map((s) => {
      const off = daysBetween(o.target, s.start);
      const left = daysBetween(o.target, s.end);
      return {
        ...s,
        start_offset_days: off,
        covers_target: off <= 0 && left >= 0,
        days_from_target: Math.max(0, Math.min(left, left - off)),
      };
    })
    .filter(
      (s) =>
        ((s.start_offset_days >= -o.before_days && s.start_offset_days <= o.after_days) ||
          (o.include_covering && s.covers_target)) &&
        s.days_from_target >= o.min_days_from_target,
    )
    .sort(
      (a, b) =>
        Math.abs(a.start_offset_days) - Math.abs(b.start_offset_days) ||
        b.days_from_target - a.days_from_target,
    );

export const suburbs = async (term: string) => {
  const res = await get(`/ajax/suburb-postcode?${new URLSearchParams({ term })}`);
  const data = (await res.json()) as { results?: { id: string; text: string }[] };
  return (data.results ?? []).map((r) => ({ postcode_id: Number(r.id), suburb: r.text }));
};

// ─── The ad page ─────────────────────────────────────────────────────────────────────────────

const text = (html = "") =>
  stripHtml(html)
    .replace(/\s*\n\s*/g, "\n")
    .trim();

/** Everything the public ad page shows, minus the "Suggested for you" strip. */
export const parseAd = (html: string, id: number) => {
  const body = html.split(/class="suggestions"/)[0]!;
  const head = /<p class="h-details">([\s\S]*?)<\/p>/.exec(body)?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const m of head.matchAll(
    /<span class="base medium">\s*([^<]+?)\s*:?\s*<\/span>([\s\S]*?)(?=<span class="base medium">|$)/g,
  )) {
    fields[m[1]!.replace(/:$/, "").toLowerCase()] = text(m[2]).replace(/^-\s*/, "");
  }
  const rating = /Response Rating<\/span>([\s\S]*?)<br/.exec(head)?.[1] ?? "";
  const section = (label: RegExp) => {
    const m = new RegExp(
      `<p class="large medium">\\s*${label.source}\\s*</p>\\s*<p>([\\s\\S]*?)</p>`,
      "i",
    ).exec(body);
    return m ? text(m[1]) : "";
  };
  const box = (label: string) =>
    text(
      new RegExp(`<strong>${label}:</strong></p>\\s*<p[^>]*>([\\s\\S]*?)</p>`, "i").exec(body)?.[1],
    );
  const photos = [
    ...new Set([...body.matchAll(/data-images="([\d,]+)"/g)].flatMap((m) => m[1]!.split(","))),
  ]
    .map(Number)
    .sort((a, b) => a - b)
    .map(
      (n) =>
        `https://cdn.happyhousesitters.com.au/prod/content/images/sits/desktop/IMG_${id}_${n}.jpg`,
    );
  const centre = /staticmap\?center=(-?[\d.]+),(-?[\d.]+)/.exec(body);
  const title = text(/<h3>([\s\S]*?)<\/h3>/.exec(body)?.[1]);
  if (!title && !head) return null;
  return {
    id,
    url: `${BASE}/sits/ad-${id}`,
    title,
    region: fields["region"] ?? "",
    owner: fields["owner"] ?? "",
    response_rating: /reduced contact/i.test(rating)
      ? "reduced contact"
      : (rating.match(/star\.svg/g) ?? []).length || null,
    property_type: fields["property type"] ?? "",
    dates: fields["dates"] ?? "",
    applications_close: fields["application close"] ?? "",
    length: fields["length"] ?? "",
    pets: fields["pets to care for"] ?? null,
    about: section(/About/),
    pets_and_farm_animals: section(/Pets &amp; farm animals|Pets & farm animals/),
    house_tasks: section(/House Tasks/),
    property_facilities: box("Property Facilities"),
    neighbourhood_facilities: box("Neighbourhood Facilities"),
    garden_lawn_care: box("Garden/Lawn Care"),
    ...(centre ? { lat: Number(centre[1]), lng: Number(centre[2]) } : {}),
    photos,
    note: "Replying needs a paid sitter membership on the site.",
  };
};

export const fetchAd = async (id: number) => {
  const html = await (await get(`/sits/ad-${id}`, "text/html")).text();
  return parseAd(html, id);
};
