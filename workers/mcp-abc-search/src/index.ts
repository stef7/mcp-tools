/**
 * mcp-abc-search — ABC's own Algolia index, the one abc.net.au searches.
 *
 *   abc_search_mediawatch        Media Watch alone, transcripts included in the match
 *   abc_search_all               every ABC program and site, optionally narrowed to one
 *   abc_search_discover_facets   what values a field actually takes, before you filter on it
 *   abc_search_discover_schema   one whole hit, so you can see what a filter may refer to
 *
 * No credentials: the search key is the public one abc.net.au ships to browsers.
 */
import cfg from "../wrangler.json";
import pkg from "../package.json";
import { mcpWorker, tool } from "../../../core/mcp";
import { ICONS } from "../../../core/icons";
import { filtersFor, formatFacets, formatResults, formatSchema, search } from "./abc";

const DATES = {
  date_from: {
    type: "string",
    description: "Published on or after this date, YYYY-MM-DD. E.g. 2023-10-07.",
  },
  date_to: { type: "string", description: "Published on or before this date, YYYY-MM-DD." },
} as const;
const PAGING = {
  page: { type: "integer", description: "Page number, 0-indexed.", default: 0, minimum: 0 },
  hits_per_page: {
    type: "integer",
    description: "Results per page, 1-50.",
    default: 20,
    minimum: 1,
    maximum: 50,
  },
} as const;
const FILTERS = {
  type: "string",
  description:
    'Algolia filter expression, e.g. "field:value", "field > N", "a:1 OR b:2". Dates are ' +
    "already handled by date_from and date_to; use this for anything else.",
} as const;
const INCLUDE_TRANSCRIPT = {
  type: "boolean",
  description:
    "Include each result's full transcript. They are long — drop hits_per_page when you do.",
  default: false,
} as const;

export default mcpWorker({
  ...cfg,
  version: pkg.version,
  icon: ICONS.abcSearch,
  info: () => ({
    title: "ABC Search",
    description: "Search ABC programs and articles, transcripts included.",
    instructions:
      "Transcripts are part of the indexed text, so a search matches what was said on air, " +
      "not just titles. Run discover_facets before filtering on a field you have not used.",
  }),
  tools: {
    mediawatch: tool({
      description:
        "Search ABC Media Watch episodes and segments. Returns titles, dates, URLs, synopses " +
        "and document types, ranked by Algolia relevance. Full episode transcripts are indexed, " +
        "so a query matches the spoken content, not only the titles and synopses. " +
        "Media Watch has roughly 314 indexed items, mostly VideoSegment, VideoEpisode, Article.",
      input: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Keywords, phrases, names, topics. Typo tolerance is on by default.",
          },
          ...DATES,
          ...PAGING,
          doc_type: {
            type: "string",
            description: "One document type; discover_facets lists them. Empty means all.",
          },
          typo_tolerance: {
            type: "string",
            enum: ["true", "false", "min", "strict"],
            default: "true",
            description:
              "'true' is standard fuzzy matching; 'strict' allows one typo on words of four " +
              "characters or more; 'min' takes the smallest valid match; 'false' is exact.",
          },
          include_transcript: INCLUDE_TRANSCRIPT,
          filters: FILTERS,
        },
      },
      async run(a) {
        const r = await search(a.query, {
          page: a.page ?? 0,
          hitsPerPage: a.hits_per_page ?? 20,
          siteFilter: "Media Watch",
          docType: a.doc_type,
          typoTolerance: a.typo_tolerance ?? "true",
          filters: filtersFor(a.filters, a.date_from, a.date_to),
        });
        return formatResults(r, !!a.include_transcript);
      },
    }),

    all: tool({
      description:
        "Search all ABC content: ABC News, 7.30, Four Corners, Background Briefing, Q+A, " +
        "Insiders and everything else in the index — about 167,000 items, including full " +
        "transcripts of audio and video. Use it to compare coverage across programs, or " +
        "narrow to one with site_filter.\n" +
        "Document types by size: AudioEpisode (~132k), Article (~61k), AudioSegment (~36k), " +
        "Audio (~35k), Video (~30k), VideoEpisode (~16k), VideoSegment (~1.1k), Program, " +
        "Recipe.\n" +
        "Larger sites include Listen, ABC News, ABC iview, ABC Kids listen, triple j, " +
        "ABC Pacific, rage, Double J, BTN, ABC中文, Gardening Australia, Bahasa Indonesia, " +
        "ABC Religion & Ethics, ABC Education, Media Watch, and the regional stations. " +
        "discover_facets has the full list.",
      input: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search terms." },
          ...DATES,
          ...PAGING,
          site_filter: {
            type: "string",
            description:
              "One ABC site or program, e.g. 'Media Watch', '7.30', 'Four Corners', " +
              "'ABC News', 'Background Briefing', 'Q+A', 'Insiders'. Empty means all of ABC.",
          },
          doc_type: {
            type: "string",
            description:
              "One of AudioEpisode, Article, AudioSegment, Audio, Video, VideoEpisode, " +
              "VideoSegment, Program, Recipe, track. Empty means all.",
          },
          include_transcript: INCLUDE_TRANSCRIPT,
          filters: FILTERS,
        },
      },
      async run(a) {
        const r = await search(a.query, {
          page: a.page ?? 0,
          hitsPerPage: a.hits_per_page ?? 20,
          siteFilter: a.site_filter,
          docType: a.doc_type,
          filters: filtersFor(a.filters, a.date_from, a.date_to),
        });
        return formatResults(r, !!a.include_transcript);
      },
    }),

    discover_facets: tool({
      description:
        "List the values a faceted field actually takes, with counts, so you can filter on " +
        "something real. Pass a query to scope the counts to that search.\n" +
        "Facetable fields include site.title, docType, lang, slug, tags, keywords, " +
        "ml_keywords, duration, validationLabels, ABCSEARCH_ownerIndex, " +
        "ABCSEARCH_programTitle, ABCSEARCH_globalCategory, _embedded.subjects.title, " +
        "_embedded.locations.title, unixDates.displayPublished, participants.list, " +
        "participants.title, contextSettings.program.type, contextSettings.service.title, " +
        "site.segment, status.theme, status.title, canonicalURI_fragments.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", default: "*", description: "Scope the counts. Default all." },
          facets: {
            type: "array",
            items: { type: "string" },
            description: "Field names. Default site.title and docType; ['*'] lists every facet.",
          },
          max_values: {
            type: "integer",
            default: 50,
            minimum: 1,
            maximum: 1000,
            description: "Values per field. Default 50.",
          },
        },
      },
      async run({ query = "*", facets, max_values = 50 }) {
        const r = await search(query, {
          hitsPerPage: 0,
          facets: facets ?? ["site.title", "docType"],
          maxValuesPerFacet: max_values,
        });
        return formatFacets(r);
      },
    }),

    discover_schema: tool({
      description:
        "Fetch one result and show every field on it, so you can see what a filter expression " +
        "may refer to. The index carries title, canonicalURL, synopsis, transcript, " +
        "dates.displayPublished (ISO), unixDates.displayPublished (unix), docType, site.title, " +
        "site.segment, keywords, ml_keywords, ml_summary, ml_sentiment.label and .score, " +
        "_embedded.subjects, _embedded.locations, caption and media.video.renditions.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", default: "test", description: "Query to sample a hit from." },
          site_filter: { type: "string", description: "Optionally scope to one site." },
        },
      },
      async run({ query = "test", site_filter }) {
        return formatSchema(await search(query, { hitsPerPage: 1, siteFilter: site_filter }));
      },
    }),
  },
});
