/**
 * mcp-un-docs — four UN document sources behind one connector.
 *
 *   un_docs_unispal_search    UNISPAL, the Palestine-specific curated collection (WordPress)
 *   un_docs_unispal_document  one UNISPAL document, full text plus resolved taxonomy names
 *   un_docs_unispal_terms     UNISPAL taxonomy terms, to find the IDs the search filters take
 *   un_docs_undl_search       the UN Digital Library, everything official since 1946 (Invenio)
 *   un_docs_undocs_resolve    a document symbol -> its PDF on ODS, in one of the six languages
 *   un_docs_rightdocs_search  Human Rights Council resolutions, with sponsors and vote counts
 *
 * All six read public APIs; none needs a key.
 */
import cfg from "../wrangler.json";
import pkg from "../package.json";
import { mcpWorker, tool } from "../../../core/mcp";
import {
  get,
  head,
  symbolFromFile,
  symbolIn,
  toMarkdown,
  truncate,
  UNDL,
  UNDL_LANG,
  UNISPAL,
  wpFail,
} from "./backends";

/** Friendly argument name -> the UNISPAL query parameter. Only the three that differ. */
const UNISPAL_FILTER: Record<string, string> = {
  source: "document-source",
  subject: "document-subject",
  category: "document-category",
};
const TAXONOMIES = [
  "document-source",
  "document-subject",
  "document-category",
  "country",
  "entity",
  "committee-meeting",
  "document-language",
] as const;

type WpDoc = {
  id: number;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
  date?: string;
  link?: string;
  _embedded?: { "wp:term"?: { name?: string; taxonomy?: string }[][] };
} & Record<string, unknown>;
type WpTerm = { id: number; name: string; slug: string; count: number };
type UndlFile = { name?: string; description?: string; url?: string };
type UndlRec = {
  recid?: number;
  files?: UndlFile[];
  filenames?: string[];
  imprint?: { date?: string };
  creation_date?: string;
  physical_description?: { pagination?: string };
  subject?: { term?: string }[];
};

const ids = (d: WpDoc, taxonomy: string) => (d[taxonomy] as number[] | undefined) ?? [];

export default mcpWorker({
  ...cfg,
  version: pkg.version,
  info: () => ({
    title: "UN Docs",
    description: "UNISPAL, the UN Digital Library, ODS symbol resolution and RightDocs.",
    instructions:
      "UNISPAL filters take numeric term IDs — look them up with unispal_terms rather than " +
      "guessing. undocs_resolve answers for one language at a time.",
  }),
  tools: {
    unispal_search: tool({
      description:
        "Search UNISPAL, the UN Information System on the Question of Palestine: a curated " +
        "collection of Palestine-related UN documents kept by the Division for Palestinian " +
        "Rights. Filters take taxonomy term IDs.\n" +
        "Sources: SR OPT (Albanese)=6854, SR OPT (all)=2025, COI OPT=6815, ICJ=1777, " +
        "OHCHR=1825, Amnesty=2541, B'Tselem=2677, Al-Haq=5435, SR Freedom of Expression=5990, " +
        "SR Housing=5073, SR Food=6841, SR Torture=5847, SR Human Rights Defenders=4570, " +
        "SR Racism=6684, SR Executions=5465, SR Education=6863, SR Health=6822, SR IDPs=6726, " +
        "SR Counter-terrorism=6681, SR Assembly=6805, SR Water=6840, SR Women=4754, " +
        "SR Judges=6811, Al Mezan=5539, Addameer=5943, Badil=3377.\n" +
        "Categories: Report=1323, Advisory Opinion=1614, Statement=1338, GA Resolution=4676, " +
        "Letter=2841, Briefing=2197, Annual Report=3181, Monthly Bulletin=1566, " +
        "Meeting Record=2625, Factsheet=2449, Non-UN Document=6994.\n" +
        "Use unispal_terms for anything not listed here.",
      input: {
        type: "object",
        properties: {
          search: { type: "string", description: "Free text query." },
          source: { type: "integer", description: "document-source term ID, e.g. 6854." },
          subject: { type: "integer", description: "document-subject term ID." },
          category: { type: "integer", description: "document-category term ID, e.g. 1323." },
          country: { type: "integer", description: "country term ID." },
          entity: { type: "integer", description: "entity term ID." },
          after: { type: "string", description: "ISO 8601 date; published after this." },
          before: { type: "string", description: "ISO 8601 date; published before this." },
          per_page: { type: "integer", description: "Results per page, max 100. Default 10." },
          page: { type: "integer", description: "Page number. Default 1." },
          orderby: {
            type: "string",
            enum: ["date", "relevance", "title", "modified"],
            description: "Sort field. Default date, always descending.",
          },
        },
      },
      async run({ per_page = 10, page = 1, orderby = "date", ...filters }) {
        const url = new URL(`${UNISPAL}/document`);
        for (const [k, v] of Object.entries(filters))
          if (v !== undefined) url.searchParams.set(UNISPAL_FILTER[k] ?? k, String(v));
        url.searchParams.set("per_page", String(Math.min(per_page, 100)));
        url.searchParams.set("page", String(page));
        url.searchParams.set("orderby", orderby);
        url.searchParams.set("order", "desc");

        const res = await get(url);
        if (!res.ok) return wpFail(res);
        const docs = (await res.json()) as WpDoc[];
        return {
          total: res.headers.get("X-WP-Total") ?? "?",
          total_pages: res.headers.get("X-WP-TotalPages") ?? "?",
          page,
          results: docs.map((d) => {
            const title = toMarkdown(d.title?.rendered);
            return {
              id: d.id,
              title,
              title_doc_symbol: symbolIn(title),
              date: d.date?.split("T")[0],
              link: d.link,
              excerpt: truncate(toMarkdown(d.excerpt?.rendered), 4000),
              source_ids: ids(d, "document-source"),
              subject_ids: ids(d, "document-subject"),
              category_ids: ids(d, "document-category"),
            };
          }),
        };
      },
    }),

    unispal_document: tool({
      description:
        "Fetch one UNISPAL document by post ID: full text as plain text, the names of every " +
        "taxonomy term on it, its date and its link. Use it to read something unispal_search " +
        "turned up.",
      input: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "integer", description: "UNISPAL document post ID." } },
      },
      async run({ id }) {
        const res = await get(`${UNISPAL}/document/${id}?_embed`);
        if (!res.ok) return wpFail(res);
        const d = (await res.json()) as WpDoc;
        const title = toMarkdown(d.title?.rendered);
        const content = toMarkdown(d.content?.rendered);
        // Each embedded group carries its own `taxonomy`, so read that rather than trusting
        // the order WordPress happened to embed them in.
        const named: Record<string, string[]> = {};
        for (const group of d._embedded?.["wp:term"] ?? [])
          for (const t of group ?? [])
            if (t.name && t.taxonomy) (named[t.taxonomy] ??= []).push(t.name);
        return {
          id: d.id,
          title,
          title_doc_symbol: symbolIn(title),
          date: d.date?.split("T")[0],
          link: d.link,
          countries: named["country"] ?? [],
          categories: named["document-category"] ?? [],
          sources: named["document-source"] ?? [],
          subjects: named["document-subject"] ?? [],
          entities: named["entity"] ?? [],
          languages: named["document-language"] ?? [],
          content: truncate(content, 150000),
          content_chars: content.length,
        };
      },
    }),

    unispal_terms: tool({
      description:
        "List or search UNISPAL taxonomy terms, to find the IDs the search filters want. " +
        "Most-used terms come first, so searching document-source for 'commission of inquiry' " +
        "puts the COI term at the top.",
      input: {
        type: "object",
        required: ["taxonomy"],
        properties: {
          taxonomy: { type: "string", enum: TAXONOMIES, description: "Which taxonomy to read." },
          search: { type: "string", description: "Filter terms by name." },
          per_page: { type: "integer", description: "Results per page, max 100. Default 20." },
          page: { type: "integer", description: "Page number." },
        },
      },
      async run({ taxonomy, search, per_page = 20, page = 1 }) {
        const url = new URL(`${UNISPAL}/${taxonomy}`);
        if (search) url.searchParams.set("search", search);
        url.searchParams.set("per_page", String(Math.min(per_page, 100)));
        url.searchParams.set("page", String(page));
        url.searchParams.set("orderby", "count");
        url.searchParams.set("order", "desc");
        const res = await get(url);
        if (!res.ok) return { error: `UNISPAL ${res.status}` };
        const terms = (await res.json()) as WpTerm[];
        return {
          taxonomy,
          results: terms.map(({ id, name, slug, count }) => ({ id, name, slug, count })),
        };
      },
    }),

    undl_search: tool({
      description:
        "Search the UN Digital Library, the official repository of UN documents since 1946. " +
        "Returns record IDs, document symbols, PDF URLs in every available language and " +
        "UNBIST subject terms.\n" +
        'Query syntax: bare words match any field; "partial phrase" wants them in one field ' +
        "in order; [exact phrase] wants a field containing only those words; field searches " +
        'look like author:albanese, subject:"human rights", 245:"genocide", ' +
        '24510a:"exact title"; AND / OR / NOT must be uppercase; child* truncates at the end ' +
        "or middle but never the start; year:2023->2024 is a range.",
      input: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search query, using the syntax above." },
          results_per_page: { type: "integer", description: "Default 10, capped around 50." },
          start_from: { type: "integer", description: "Result offset for paging. Default 1." },
          sort: {
            type: "string",
            enum: ["year_desc", "year_asc", "relevance"],
            description: "Sort order. Default year_desc.",
          },
        },
      },
      async run({ query, results_per_page = 10, start_from = 1, sort = "year_desc" }) {
        const url = new URL(`${UNDL}/search`);
        url.searchParams.set("p", query);
        url.searchParams.set("of", "recjson");
        url.searchParams.set("rg", String(Math.min(results_per_page, 50)));
        url.searchParams.set("jrec", String(start_from));
        if (sort !== "relevance") {
          url.searchParams.set("sf", "year");
          url.searchParams.set("so", sort === "year_asc" ? "a" : "d");
        }
        const res = await get(url);
        const body = await res.text();
        if (!res.ok)
          return {
            error: `UNDL HTTP ${res.status} ${res.statusText}`,
            url: url.href,
            response_length: body.length,
            response_preview: body.slice(0, 500),
          };
        if (!body.trim())
          return {
            error: "UNDL returned an empty body",
            status: res.status,
            content_type: res.headers.get("Content-Type"),
            url: url.href,
          };

        // The body is a JSON array wrapped in headers, so take it from the first [ to the last ].
        const open = body.indexOf("[");
        const close = body.lastIndexOf("]");
        let records: UndlRec[];
        try {
          records = JSON.parse(open >= 0 && close > open ? body.slice(open, close + 1) : body);
        } catch (e) {
          return {
            error: `Could not parse UNDL JSON: ${e instanceof Error ? e.message : String(e)}`,
            response_length: body.length,
            content_type: res.headers.get("Content-Type"),
            response_preview: body.slice(0, 500),
          };
        }
        if (!Array.isArray(records)) records = [records];

        const total = body.match(/Search-Engine-Total-Number-Of-Results:\s*(\d+)/)?.[1] ?? "?";
        return {
          total,
          query,
          results: records.map((r) => {
            const files = r.files ?? [];
            const english = files.find(
              (f) => f.description === "English" || f.name?.endsWith("-EN"),
            );
            const named = english?.name ?? r.filenames?.[0];
            const pdfs: Record<string, string> = {};
            for (const f of files)
              if (f.url && f.description) pdfs[UNDL_LANG[f.description] ?? f.description] = f.url;
            return {
              recid: r.recid,
              doc_symbol: named ? symbolFromFile(named) : "",
              date: r.imprint?.date ?? r.creation_date ?? "",
              pages: r.physical_description?.pagination ?? "",
              subjects: (r.subject ?? []).flatMap((s) => (s.term ? [s.term] : [])),
              pdfs,
              url: `${UNDL}/record/${r.recid}`,
            };
          }),
        };
      },
    }),

    undocs_resolve: tool({
      description:
        "Resolve a UN document symbol to its PDF in one language, by following the ODS API's " +
        "redirect. Documents move through DGACM: advance unedited, then advance edited (both " +
        "English only, on OHCHR), then final (all six languages, on ODS). Conference Room " +
        "Papers skip that pipeline and never reach ODS. When the PDF is not there you get " +
        "search links to OHCHR, UNISPAL and the Digital Library instead. One language per call.",
      input: {
        type: "object",
        required: ["symbol", "lang"],
        properties: {
          symbol: { type: "string", description: "UN document symbol, e.g. A/80/492." },
          lang: {
            type: "string",
            enum: ["ar", "zh", "en", "fr", "ru", "es"],
            description: "Arabic, Chinese, English, French, Russian or Spanish.",
          },
        },
      },
      async run({ symbol: raw, lang }) {
        const symbol = raw.trim();
        // The ODS API wants literal slashes in `s`, so this one is deliberately not encoded.
        const api_url = `https://documents.un.org/api/symbol/access?s=${symbol}&l=${lang}&t=pdf`;
        let probe_status: number | string = "";
        let probe_content_type = "";
        try {
          const probe = await head(api_url); // HEAD: the point is the redirect, not the PDF
          probe_status = probe.status;
          probe_content_type = probe.headers.get("Content-Type") ?? "";
          if (probe.ok && probe_content_type.includes("pdf"))
            return { symbol, lang, found: true, pdf_url: probe.url, api_url };
        } catch (e) {
          probe_status = `fetch error: ${e instanceof Error ? e.message : String(e)}`;
        }
        const crp = /CRP\.\d+/i.test(symbol)
          ? " This is a Conference Room Paper: CRPs bypass the DGACM translation pipeline and " +
            "are never on ODS."
          : "";
        const q = encodeURIComponent(symbol);
        return {
          symbol,
          lang,
          found: false,
          reason:
            `No ${lang} PDF via the ODS API. The document may still be at advance unedited or ` +
            `advance edited stage, or otherwise outside this endpoint.` +
            crp,
          probe_status,
          probe_content_type,
          api_url,
          search_ohchr: `https://www.ohchr.org/en/search?query=${q}`,
          search_unispal: `https://www.un.org/unispal/?s=${q}`,
          search_undl: `${UNDL}/search?p=${q}`,
        };
      },
    }),

    rightdocs_search: tool({
      description:
        "Search Human Rights Council resolutions, decisions and president's statements on " +
        "RightDocs. Returns sponsors, cosponsors, vote counts and text. Every argument is a " +
        "structured filter, passed through to right-docs.org with &api=1.\n" +
        "Topics (tp): Palestine=237, Journalists=215, Freedom of Opinion/Expression/" +
        "Association=194, Genocide=195, Golan Heights=267, Torture=270, Children=164, " +
        "Discrimination=180, Self-determination=256, Racism=250, Right to health=200, " +
        "Armed Conflict=156.\n" +
        "States (sp/csp/vf/vc/va): Australia=407, Israel=502, US=629, UK=628, France=469, " +
        "Germany=476, Canada=433, South Africa=599, Palestine=563, Egypt=459, Pakistan=561.\n" +
        "Agenda items: Item 7 (Palestine)=126, Item 3=122, Item 4=123, Item 10=129.",
      input: {
        type: "object",
        properties: {
          tp: { type: "integer", description: "Topic ID, e.g. 237 for Palestine." },
          q: {
            type: "string",
            description:
              "Case-insensitive substring of the resolution text. Single or hyphenated words " +
              "work best; several words only match where they appear adjacent, in that order.",
          },
          sp: { type: "integer", description: "Main sponsor state ID." },
          csp: { type: "integer", description: "Co-sponsor state ID." },
          vf: { type: "integer", description: "State that voted in favour." },
          vc: { type: "integer", description: "State that voted against." },
          va: { type: "integer", description: "State that abstained." },
          vt: { type: "integer", description: "147 = adopted by vote, 148 = without a vote." },
          ss: { type: "integer", description: "Session ID from the facets, not a session number." },
          t1: {
            type: "integer",
            description: "304 = Resolution, 305 = Decision, 306 = President's Statement.",
          },
          agenda: { type: "integer", description: "Agenda item ID, e.g. 126 for Item 7." },
          yr: { type: "integer", description: "Year, e.g. 2024." },
          p: { type: "integer", description: "Page number." },
        },
      },
      async run(args) {
        const url = new URL("https://www.right-docs.org/");
        for (const [k, v] of Object.entries(args))
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        url.searchParams.set("api", "1");
        const res = await get(url);
        if (!res.ok) return { error: `RightDocs ${res.status}` };
        const data = (await res.json()) as {
          SearchResults?: unknown;
          pagination?: { activePage?: number; totalPages?: number };
          docs?: unknown;
        };
        // The facets and comparison blocks are enormous and nobody reads them; drop them.
        return {
          total: data.SearchResults,
          page: data.pagination?.activePage,
          total_pages: data.pagination?.totalPages,
          docs: data.docs,
        };
      },
    }),
  },
});
