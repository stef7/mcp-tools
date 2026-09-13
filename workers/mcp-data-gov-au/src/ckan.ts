/**
 * The CKAN Action API behind data.gov.au, and the formatting of what it returns.
 *
 * Everything is a POST to /api/action/<action> with a JSON body, and every answer is wrapped
 * in `{success, result}` — including the failures, which come back as HTTP 200 with
 * success: false, so the status code alone tells you nothing.
 */
const DEFAULT_BASE = "https://data.gov.au/data";
/** The ACNC main register: https://data.gov.au/data/dataset/acnc-register */
export const ACNC = "8fb32972-24e9-4c95-885e-7140be51be8a";
const UA = "datagov-mcp/1.0 (+https://workers.dev)";

export type Field = { id: string; type: string };
export type Records = Record<string, unknown>[];
export type Result = {
  records?: Records;
  fields?: Field[];
  total?: number;
  records_truncated?: boolean;
  count?: number;
  results?: Dataset[];
};
export type Dataset = {
  title?: string;
  name?: string;
  resources?: { id?: string; name?: string; format?: string; datastore_active?: boolean }[];
};

export const ckan = async (env: Env, action: string, payload: object): Promise<Result> => {
  const base = (env.CKAN_BASE || DEFAULT_BASE).replace(/\/+$/, "");
  const token = env.CKAN_API_TOKEN || env.DATA_GOV_AU_TOKEN;
  const res = await fetch(`${base}/api/action/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": UA,
      ...(token ? { authorization: token } : {}),
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let data: { success?: boolean; result?: Result; error?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${res.status}) from ${action}: ${raw.slice(0, 800)}`);
  }
  if (data?.success !== true) {
    const why = JSON.stringify(data?.error ?? { message: `HTTP ${res.status}` });
    throw new Error(`CKAN ${action} failed (HTTP ${res.status}): ${why}`);
  }
  return data.result ?? {};
};

export const fieldLine = (fields: Field[] = []) =>
  fields.map((f) => `${f.id}:${f.type}`).join(", ");

/** Echo at most `maxRows` records, saying so when the rest were fetched but not shown. */
export const echoRecords = (records: Records, maxRows: number) => {
  const shown = records.slice(0, maxRows);
  const note =
    records.length > shown.length
      ? `\n\n[showing ${shown.length} of ${records.length} fetched — raise max_rows, ` +
        `or add LIMIT/OFFSET to the query]`
      : "";
  return JSON.stringify(shown, null, 2) + note;
};

export const describeDatasets = (r: Result, q: string, start: number) => {
  const datasets = r.results ?? [];
  const blocks = datasets.map((d) => {
    const rows = (d.resources ?? []).map(
      (res) =>
        `      - ${res.name || res.format || "(unnamed)"} [${res.format || "?"}]  ` +
        `resource_id=${res.id}  datastore_active=${!!res.datastore_active}`,
    );
    const listed = rows.join("\n") || "      (none)";
    return `• ${d.title}\n    dataset_id=${d.name}\n    resources:\n${listed}`;
  });
  return (
    `${r.count} dataset(s) match "${q}". Showing ${datasets.length} (start=${start}).\n` +
    `(the ones with datastore_active=true can be queried by datastore_sql / datastore_search)\n\n` +
    blocks.join("\n\n")
  );
};
