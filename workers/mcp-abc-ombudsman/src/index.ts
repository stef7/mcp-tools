/**
 * mcp-abc-ombudsman — the ABC Ombudsman's published complaint findings.
 *
 *   abc_ombudsman_list_categories   the outcome categories, and their collection IDs
 *   abc_ombudsman_list_years        the year sub-collections inside one category
 *   abc_ombudsman_list_complaints   the findings in one collection
 *   abc_ombudsman_search_all        every category and year, filtered by keyword
 *   abc_ombudsman_dump_all          every finding, for exporting
 *
 * Reads abc.net.au's public CoreMedia API; no credentials.
 */
import cfg from "../wrangler.json";
import pkg from "../package.json";
import { mcpWorker, tool } from "../../../core/mcp";
import {
  asFinding,
  asSubCollection,
  categoriesMatching,
  CATEGORIES,
  collection,
  metaCollection,
  ROOT,
  walk,
  type Finding,
} from "./ombudsman";

const CATEGORY_FILTER = {
  type: "string",
  description:
    "Part of a category title ('Breach', 'No Breach', 'Action Taken') or its exact ID. " +
    "Omit for every category.",
} as const;

/** Strip the id, which is only useful for fetching, from a row meant for a reader. */
const listed = ({ category, title, description, url, date }: Finding) => ({
  category,
  title,
  description,
  url,
  date,
});

export default mcpWorker({
  ...cfg,
  version: pkg.version,
  info: () => ({
    title: "ABC Ombudsman",
    description: "Complaint findings published by the ABC Ombudsman.",
    instructions:
      "search_all and dump_all crawl every category and year, which is dozens of requests. " +
      "Use list_categories, list_years and list_complaints when you know where to look.",
  }),
  tools: {
    list_categories: tool({
      description:
        "List the outcome categories — Breach Findings, Noteworthy No Breach Findings, " +
        "Action Taken, Review Findings, Statements and Reports — with their collection IDs. " +
        "Read live, falling back to the known list if the API is down.",
      async run() {
        try {
          const items = (await metaCollection(ROOT)).collection?.items ?? [];
          return { source: "live", categories: items.map(asSubCollection) };
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          return { source: `known list (the API said: ${why})`, categories: CATEGORIES };
        }
      },
    }),

    list_years: tool({
      description:
        "List the year sub-collections inside a category. Pass a category ID from " +
        "list_categories. Statements and Reports has no years — list its complaints directly.",
      input: {
        type: "object",
        required: ["category_id"],
        properties: {
          category_id: {
            type: "string",
            description: "Category collection ID, e.g. 103532876 for Breach Findings.",
          },
        },
      },
      async run({ category_id }) {
        const known = CATEGORIES.find((c) => c.id === category_id);
        if (known?.type === "StandardCollection")
          return {
            category: known.title,
            note: "No year sub-collections; pass this ID to list_complaints instead.",
            years: [],
          };
        const items = (await metaCollection(category_id)).collection?.items ?? [];
        return { category: known?.title ?? category_id, years: items.map(asSubCollection) };
      },
    }),

    list_complaints: tool({
      description:
        "List the findings in one collection, either a year or a flat category. Each carries " +
        "its title, description, date, URL and outcome category.",
      input: {
        type: "object",
        required: ["collection_id"],
        properties: {
          collection_id: {
            type: "string",
            description: "Collection ID from list_years or list_categories.",
          },
          size: { type: "number", description: "Max items. Default 200." },
          offset: { type: "number", description: "Pagination offset. Default 0." },
        },
      },
      async run({ collection_id, size = 200, offset = 0 }) {
        const col = (await collection(collection_id, size, offset)).collection ?? {};
        const heading = col.heading ?? col.title ?? "";
        const complaints = (col.items ?? []).map((i) => asFinding(i, heading));
        return {
          collection_title: heading,
          total: col.pagination?.total ?? complaints.length,
          offset: col.pagination?.offset ?? offset,
          returned: complaints.length,
          complaints,
        };
      },
    }),

    search_all: tool({
      description:
        "Search every Ombudsman finding, across all categories and years, for any of the " +
        "keywords given. Matches title and description text, case-insensitively, and reports " +
        "which outcome category each match came from — so you can see, say, how many " +
        "Israel/Palestine/Gaza complaints were upheld and how many were not.",
      input: {
        type: "object",
        required: ["keywords"],
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description:
              "Matches a finding if ANY keyword appears in it, e.g. " +
              "['israel', 'palestine', 'gaza', 'hamas', 'middle east', 'idf', 'zion'].",
          },
          category: CATEGORY_FILTER,
        },
      },
      async run({ keywords, category }) {
        const cats = categoriesMatching(category);
        if (!cats.length)
          return {
            error:
              `No category matches "${category}". ` +
              `Options: ${CATEGORIES.map((c) => c.title).join(", ")}.`,
          };
        const all = (await Promise.all(cats.map(walk))).flat();
        const wanted = keywords.map((k) => k.toLowerCase());
        const matches = all.filter((f) => {
          const text = `${f.title} ${f.description}`.toLowerCase();
          return wanted.some((k) => text.includes(k));
        });
        return {
          keywords,
          category_filter: category ?? "all",
          total_complaints_scanned: all.length,
          matches_found: matches.length,
          matches: matches.map(listed),
        };
      },
    }),

    dump_all: tool({
      description:
        "Every finding from every category and year, or from one category. A large result " +
        "set, meant for exporting to a spreadsheet.",
      input: { type: "object", properties: { category: CATEGORY_FILTER } },
      async run({ category }) {
        const all = (await Promise.all(categoriesMatching(category).map(walk))).flat();
        return {
          category_filter: category ?? "all",
          total: all.length,
          complaints: all.map(listed),
        };
      },
    }),
  },
});
