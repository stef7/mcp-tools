/**
 * Wayback CDX server plumbing. Every lookup here goes through CDX or the JSON TimeMap, the two
 * endpoints that behave. The Availability API returns empty for URLs with confirmed captures,
 * and Memento TimeGate hands back the Wayback homepage for out-of-range dates, so neither is
 * used — `nearest_capture` replaces both.
 */
export const UA = "WaybackMCP/3.0 (Cloudflare Worker; +https://archive.org)";
export const CDX = "https://web.archive.org/cdx/search/cdx";
export const TIMEMAP = "https://web.archive.org/web/timemap/json";

export type Row = Record<string, string>;

const pad = (ts: string, at: number, len: number, fill: string) => ts.slice(at, at + len) || fill;

/** A 1-14 digit Wayback timestamp as ISO. Short forms are padded rather than rejected. */
export const isoTs = (ts: string) =>
  ts.length < 8
    ? ts
    : `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T` +
      `${pad(ts, 8, 2, "00")}:${pad(ts, 10, 2, "00")}:${pad(ts, 12, 2, "00")}Z`;

/** The same timestamp as a Date, for comparing two candidates. Null if it will not parse. */
export const wbDate = (ts?: string): Date | null => {
  const s = (ts ?? "").replace(/\D/g, "");
  if (s.length < 4) return null;
  const at = new Date(isoTs(s.slice(0, 4) + pad(s, 4, 2, "01") + pad(s, 6, 2, "01") + s.slice(8)));
  return isNaN(at.getTime()) ? null : at;
};

/**
 * CDX and TimeMap both answer with a 2D array whose first row names the columns, so the shape
 * follows whatever `fl` asked for. Rows carrying a timestamp also get a clickable Wayback URL.
 */
export const rowsOf = (data: unknown): Row[] => {
  if (!Array.isArray(data) || data.length < 2) return [];
  const head = (data[0] as unknown[]).map(String);
  return data
    .slice(1)
    .filter<unknown[]>(Array.isArray)
    .map((cells) => {
      const row: Row = {};
      head.forEach((name, i) => cells[i] !== undefined && (row[name] = String(cells[i])));
      if (row["timestamp"] && row["original"]) {
        row["url"] = `https://web.archive.org/web/${row["timestamp"]}/${row["original"]}`;
        row["datetime"] = isoTs(row["timestamp"]);
      }
      return row;
    });
};

/**
 * One CDX request. Empty values are dropped, arrays become repeated params (CDX wants one
 * `filter=` per filter), and JSON is forced — `data` is undefined when the body was not JSON,
 * which the raw-index flags legitimately produce.
 */
export const cdx = async (params: Record<string, unknown>) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    for (const one of [v].flat()) qs.append(k, String(one));
  }
  qs.set("output", "json");
  qs.set("gzip", "false");
  const api_url = `${CDX}?${qs}`;
  const res = await fetch(api_url, { headers: { "User-Agent": UA }, redirect: "follow" });
  const body = await res.text();
  if (!res.ok) throw new Error(`CDX ${res.status}: ${body.slice(0, 500)}`);
  try {
    return { data: JSON.parse(body) as unknown, body, api_url };
  } catch {
    return { data: undefined, body, api_url };
  }
};

/** The first row of a one-result query, plus the URL it came from, so callers can show it. */
export const cdxOne = async (params: Record<string, unknown>) => {
  const { data, api_url } = await cdx({ resolveRevisits: "true", ...params });
  return { row: rowsOf(data)[0], api_url };
};
