/**
 * mcp-data-gov-au — a thin proxy over the data.gov.au CKAN Action API.
 *
 *   data_gov_au_datastore_sql      raw read-only SELECT against a datastore resource
 *   data_gov_au_datastore_search   the structured equivalent: q, filters, sort, paging
 *   data_gov_au_datastore_fields   a resource's columns and types — run this before SQL
 *   data_gov_au_package_search     find datasets and read off their resource IDs
 *
 * No credentials for public resources. CKAN_API_TOKEN and CKAN_BASE are optional; see
 * secrets.d.ts.
 */
import cfg from "../wrangler.json";
import pkg from "../package.json";
import { mcpWorker, tool } from "../../../core/mcp";
import { ACNC, ckan, describeDatasets, echoRecords, fieldLine } from "./ckan";

const RESOURCE_ID = {
  type: "string",
  description: `Datastore resource UUID. Defaults to the ACNC main register, ${ACNC}.`,
} as const;
const MAX_ROWS = {
  type: "integer",
  default: 200,
  description: "Max records echoed back. The query itself still runs in full.",
} as const;

export default mcpWorker({
  ...cfg,
  version: pkg.version,
  info: () => ({
    title: "data.gov.au",
    description: "Query Australian government open data through CKAN.",
    websiteUrl: "https://data.gov.au/data",
    instructions:
      "Column IDs are case-sensitive: run datastore_fields before writing SQL. Resource IDs " +
      "contain hyphens and must be double-quoted in a FROM clause.",
  }),
  tools: {
    datastore_sql: tool({
      description:
        "Run a read-only SQL SELECT against a data.gov.au datastore resource (PostgreSQL " +
        "dialect). Resource IDs contain hyphens, so they MUST be double-quoted:\n" +
        '  SELECT "ABN", "Charity_Legal_Name" FROM "' +
        ACNC +
        '"\n  WHERE "Charity_Legal_Name" ILIKE \'%jewish national fund%\'\n' +
        "ILIKE '%term%' is a case-insensitive contains; COUNT/SUM/GROUP BY aggregate; " +
        "LIMIT/OFFSET page. One SELECT per call. Column IDs are case-sensitive — run " +
        'datastore_fields first. Every resource also has an implicit "_id" column and a ' +
        '"_full_text" tsvector.',
      input: {
        type: "object",
        required: ["sql"],
        properties: {
          sql: {
            type: "string",
            description: "A single read-only SELECT. Double-quote the resource ID in FROM.",
          },
          max_rows: MAX_ROWS,
        },
      },
      async run({ sql, max_rows = 200 }, { env }) {
        const r = await ckan(env, "datastore_search_sql", { sql });
        const records = r.records ?? [];
        const capped = r.records_truncated
          ? "  (records_truncated — the server's row cap was hit; add LIMIT/OFFSET)"
          : "";
        return (
          `${records.length} record(s)${capped}\nfields: ${fieldLine(r.fields)}\n\n` +
          echoRecords(records, max_rows)
        );
      },
    }),

    datastore_search: tool({
      description:
        "Structured, non-SQL search of a datastore resource. Good for paging, and for when " +
        "SQL is gated. Returns the total match count plus one page of records; limit: 0 " +
        "returns the field schema alone.",
      input: {
        type: "object",
        properties: {
          resource_id: RESOURCE_ID,
          q: { type: "string", description: "Full-text query across all fields." },
          filters: {
            type: "object",
            description: 'Exact matches, e.g. {"State":"NSW"} or {"Town_City":["SYDNEY","BONDI"]}.',
          },
          fields: { type: "string", description: "Comma-separated columns. Default all." },
          sort: { type: "string", description: 'e.g. "Registration_Date desc".' },
          distinct: { type: "boolean", description: "Only distinct rows for the chosen fields." },
          limit: { type: "integer", default: 100, description: "Rows to fetch. 0 = schema only." },
          offset: { type: "integer", default: 0, description: "Row offset for paging." },
          max_rows: MAX_ROWS,
        },
      },
      async run({ resource_id, max_rows = 200, limit = 100, offset = 0, ...rest }, { env }) {
        const id = resource_id ?? ACNC;
        const payload: Record<string, unknown> = { resource_id: id, limit, offset };
        for (const [k, v] of Object.entries(rest)) if (v !== undefined) payload[k] = v;
        const r = await ckan(env, "datastore_search", payload);
        const records = r.records ?? [];
        return (
          `resource ${id}\n` +
          `total matching: ${r.total}  ·  returned: ${records.length}  ·  ` +
          `offset: ${offset}  ·  limit: ${limit}\n` +
          `fields: ${fieldLine(r.fields)}\n\n` +
          echoRecords(records, max_rows)
        );
      },
    }),

    datastore_fields: tool({
      description:
        "List a resource's columns and their Postgres types. Run it before writing SQL: " +
        "column IDs are case-sensitive and have to match exactly.",
      input: { type: "object", properties: { resource_id: RESOURCE_ID } },
      async run({ resource_id }, { env }) {
        const id = resource_id ?? ACNC;
        const r = await ckan(env, "datastore_search", { resource_id: id, limit: 0 });
        const fields = r.fields ?? [];
        const body = fields.map((f) => `  ${f.id}  (${f.type})`).join("\n");
        return `${fields.length} field(s) in ${id}:\n${body}\n\nTotal rows in resource: ${r.total}`;
      },
    }),

    package_search: tool({
      description:
        "Find datasets on data.gov.au by keyword and read off their resource IDs, marking " +
        "which are datastore_active and so queryable. Try q: 'ACNC charities', " +
        "'ASIC companies'.",
      input: {
        type: "object",
        properties: {
          q: { type: "string", description: "Keywords to match datasets." },
          rows: { type: "integer", default: 10, description: "Datasets to return." },
          start: { type: "integer", default: 0, description: "Offset for paging." },
        },
      },
      async run({ q = "", rows = 10, start = 0 }, { env }) {
        return describeDatasets(await ckan(env, "package_search", { q, rows, start }), q, start);
      },
    }),
  },
});
