/**
 * mcp-qon — the Senate's questions on notice, from aph.gov.au/qon.
 *
 *   qon_list              a drop-down list: senators, ministries, parliaments, committees, …
 *   qon_search            written questions on the Notice Paper, filtered as the page filters
 *   qon_get               one written question in full: question, answer, transfers, attachments
 *   qon_search_estimates  questions taken on notice at Senate estimates
 *   qon_get_estimates     one estimates question in full
 *
 * Reads the JSON endpoints the page itself calls; no credentials. Names are resolved to the IDs
 * the API wants, so "Shoebridge" and "Foreign Affairs" work where it wants 747 and 661.
 */
import cfg from "../wrangler.json";
import { version } from "../package.json";
import { mcpWorker, tool } from "../../../core/mcp";
import {
  asEstimates,
  asWritten,
  attachments,
  callPlain,
  ESTIMATES_ORDER,
  estimatesDownload,
  estimatesForm,
  aphDate,
  htmlToText,
  list,
  LISTS,
  resolve,
  searchTable,
  STATUS,
  transfers,
  WRITTEN_ORDER,
  writtenForm,
  type EstimatesRow,
  type ListName,
  type Status,
  type TextMode,
  type WrittenRow,
} from "./aph";

const STATUSES = Object.keys(STATUS) as Status[];

const COMMON = {
  keywords: {
    type: "string",
    description: "Words to find in the question or answer text, as the page's Keywords box.",
  },
  senator: {
    type: "string",
    description:
      "Who asked: a name ('Shoebridge', 'David Pocock', 'Payman') or an ID from qon_list. " +
      "Former senators work too.",
  },
  date_from: { type: "string", description: "YYYY-MM-DD, inclusive." },
  date_to: { type: "string", description: "YYYY-MM-DD, inclusive." },
  status: {
    type: "string",
    enum: STATUSES,
    description:
      "all (default), answered, unanswered, overdue (unanswered for more than 30 days) or " +
      "withdrawn. Questions left unanswered when a Parliament ends show as 'Lapsed'.",
  },
  dir: { type: "string", enum: ["desc", "asc"], description: "Default desc (newest first)." },
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 500,
    description: "How many to return, default 20, at most 500 (fetched 100 at a time).",
  },
  offset: { type: "integer", minimum: 0, description: "Skip this many first. Default 0." },
  text: {
    type: "string",
    enum: ["snippet", "full", "none"],
    description:
      "Question and answer text: snippet (default, first 600 characters each), full, or none " +
      "for just the listing.",
  },
} as const;

const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The current Parliament's number, which is the first the list offers. */
const currentParliament = async () => (await list("parliaments"))[0]?.id ?? "x";

const parliamentParam = async (p?: number | string) => {
  if (p === undefined || p === "") return currentParliament();
  if (String(p).toLowerCase() === "all") return "x";
  const n = String(p).replace(/\D/g, "");
  if (!n) throw new Error(`parliament is a number like 48, or "all"; got "${p}".`);
  return n;
};

export default mcpWorker({
  ...cfg,
  version,
  info: () => ({
    title: "Senate questions on notice",
    description:
      "Written questions on the Senate Notice Paper and questions taken on notice at Senate " +
      "estimates, with ministers' answers, from aph.gov.au/qon.",
    websiteUrl: "https://www.aph.gov.au/qon",
    instructions:
      "Senate only: House of Representatives questions are not in this database. Written " +
      "questions are numbered within a Parliament (the 48th began in 2025), so cite them as " +
      "'Question on notice no. 716 (48th Parliament)'. Search returns snippets; qon_get gives " +
      "the full text, transfers between portfolios and answer attachments. Senators, " +
      "ministries, committees, portfolios, agencies and estimates rounds may be named rather " +
      "than given as IDs; qon_list shows the options. Answer attachments and the 'download' " +
      "links are files on aph.gov.au: read them with a fetch tool.",
  }),
  tools: {
    list: tool({
      description:
        "One of the search page's drop-down lists, with the IDs the other tools accept. " +
        "senators, ministries and parliaments filter written questions; committees, " +
        "portfolios, agencies and estimates_rounds filter estimates questions (senators " +
        "filter both).",
      input: {
        type: "object",
        required: ["of"],
        properties: {
          of: { type: "string", enum: Object.keys(LISTS) as ListName[] },
          current_only: {
            type: "boolean",
            description: "Only current ones, as the page's tick box. Default true.",
          },
          filter: { type: "string", description: "Keep only entries containing this text." },
        },
      },
      async run({ of, current_only = true, filter }) {
        let options = await list(of, current_only);
        if (filter) {
          const f = filter.toLowerCase();
          options = options.filter((o) => o.name.toLowerCase().includes(f));
        }
        return { of, current_only, count: options.length, options };
      },
    }),

    search: tool({
      description:
        "Search written questions on notice on the Senate Notice Paper: who asked, which " +
        "minister, status, dates of notice, keywords. Newest first. Each result carries the " +
        "question number, Parliament, senator, the minister asked, status, dates and a link.",
      input: {
        type: "object",
        properties: {
          keywords: COMMON.keywords,
          senator: COMMON.senator,
          ministry: {
            type: "string",
            description:
              "The minister asked, by portfolio: 'Foreign Affairs', 'Defence', 'Prime " +
              "Minister', 'Attorney-General', or an ID. An exact name wins over partial matches.",
          },
          parliament: {
            type: ["integer", "string"],
            description: "Parliament number, e.g. 48 (default: the current one), or 'all'.",
          },
          question_number: { type: "integer", description: "One question's number." },
          date_from: { ...COMMON.date_from, description: "Notice given on or after, YYYY-MM-DD." },
          date_to: { ...COMMON.date_to, description: "Notice given on or before, YYYY-MM-DD." },
          status: COMMON.status,
          order_by: { type: "string", enum: [...WRITTEN_ORDER], description: "Default number." },
          dir: COMMON.dir,
          limit: COMMON.limit,
          offset: COMMON.offset,
          text: COMMON.text,
        },
      },
      async run(a) {
        const [senator, ministry, parliament] = await Promise.all([
          a.senator ? resolve("senators", a.senator) : undefined,
          a.ministry ? resolve("ministries", a.ministry) : undefined,
          parliamentParam(a.parliament),
        ]);
        const limit = a.limit ?? 20;
        const offset = a.offset ?? 0;
        const query = {
          keywords: a.keywords,
          senator,
          ministry,
          parliament,
          questionNumber: a.question_number === undefined ? "" : String(a.question_number),
          dateFrom: a.date_from,
          dateTo: a.date_to,
          status: a.status,
          orderBy: a.order_by,
          dir: a.dir,
        };
        const { total, rows } = await searchTable<WrittenRow>(
          "/api/qon/getdata",
          (start, length) => writtenForm(query, start, length),
          offset,
          limit,
        );
        const text = (a.text ?? "snippet") as TextMode;
        return {
          filters: {
            parliament: parliament === "x" ? "all" : Number(parliament),
            ...(senator ? { senator_id: senator } : {}),
            ...(ministry ? { ministry_id: ministry } : {}),
          },
          total,
          offset,
          returned: rows.length,
          results: rows.map((r) => asWritten(r, text)),
        };
      },
    }),

    get: tool({
      description:
        "One written question in full: the question and answer text with their numbering " +
        "kept, dates, status, any transfers between portfolios, and the answer's attachments.",
      input: {
        type: "object",
        required: ["number"],
        properties: {
          number: { type: "integer", description: "Question on notice number." },
          parliament: {
            type: ["integer", "string"],
            description: "Parliament number, default the current one.",
          },
        },
      },
      async run({ number, parliament }) {
        const p = await parliamentParam(parliament);
        if (p === "x") throw new Error("Numbers restart each Parliament; name one, e.g. 48.");
        const { rows } = await searchTable<WrittenRow>(
          "/api/qon/getdata",
          (start, length) =>
            writtenForm({ parliament: p, questionNumber: String(number) }, start, length),
          0,
          10,
        );
        const found = rows.filter((r) => Number(r.Number) === Number(number));
        if (!found.length)
          return {
            content: [{ type: "text", text: `No question ${number} in the ${p}th Parliament.` }],
            isError: true,
          };
        const full = await Promise.all(
          found.map(async (r) => {
            const [moved, files] = await Promise.all([
              r.IsTransferred ? transfers(r.Id).catch(failure) : Promise.resolve([]),
              attachments(r.Id).catch(failure),
            ]);
            return { ...asWritten(r, "full"), transfers: moved, attachments: files };
          }),
        );
        // A question put to several portfolios comes back once per portfolio.
        return full.length === 1 ? full[0] : { number, parliament: Number(p), records: full };
      },
    }),

    search_estimates: tool({
      description:
        "Search questions taken on notice at Senate estimates: by senator, committee, " +
        "estimates round, portfolio, agency, hearing date, status or keywords. Results carry " +
        "the IDs qon_get_estimates needs.",
      input: {
        type: "object",
        properties: {
          keywords: COMMON.keywords,
          senator: COMMON.senator,
          committee: {
            type: "string",
            description:
              "Legislation committee by name ('Foreign Affairs, Defence and Trade') or ID.",
          },
          estimates_round: {
            type: "string",
            description: "Round by name ('Budget Estimates 2026-27', 'Supplementary') or ID.",
          },
          portfolio: { type: "string", description: "Portfolio by name or ID." },
          agency: {
            type: "string",
            description: "Department or agency by name ('Australian Federal Police') or ID.",
          },
          question_number: { type: "integer", description: "The question's number." },
          portfolio_question_number: {
            type: "string",
            description: "The portfolio's own reference, as printed on the answer.",
          },
          date_from: { ...COMMON.date_from, description: "Hearing on or after, YYYY-MM-DD." },
          date_to: { ...COMMON.date_to, description: "Hearing on or before, YYYY-MM-DD." },
          status: COMMON.status,
          order_by: { type: "string", enum: [...ESTIMATES_ORDER], description: "Default number." },
          dir: COMMON.dir,
          limit: COMMON.limit,
          offset: COMMON.offset,
          text: COMMON.text,
        },
      },
      async run(a) {
        const [senator, committee, round, portfolio, agency] = await Promise.all([
          a.senator ? resolve("senators", a.senator) : undefined,
          a.committee ? resolve("committees", a.committee) : undefined,
          a.estimates_round ? resolve("estimates_rounds", a.estimates_round) : undefined,
          a.portfolio ? resolve("portfolios", a.portfolio) : undefined,
          a.agency ? resolve("agencies", a.agency) : undefined,
        ]);
        const limit = a.limit ?? 20;
        const offset = a.offset ?? 0;
        const query = {
          keywords: a.keywords,
          senator,
          committee,
          round,
          portfolio,
          agency,
          questionNumber: a.question_number === undefined ? "" : String(a.question_number),
          portfolioQuestionNumber: a.portfolio_question_number,
          dateFrom: a.date_from,
          dateTo: a.date_to,
          status: a.status,
          orderBy: a.order_by,
          dir: a.dir,
        };
        const { total, rows } = await searchTable<EstimatesRow>(
          "/api/qon/getestimatesdata",
          (start, length) => estimatesForm(query, start, length),
          offset,
          limit,
        );
        const text = (a.text ?? "snippet") as TextMode;
        return {
          filters: Object.fromEntries(
            Object.entries({ senator, committee, round, portfolio, agency }).filter(([, v]) => v),
          ),
          total,
          offset,
          returned: rows.length,
          results: rows.map((r) => asEstimates(r, text)),
        };
      },
    }),

    get_estimates: tool({
      description:
        "One estimates question in full: question, answer, answer date, proof Hansard page, " +
        "plus attachments and transfers when its `id` is given. Takes the IDs from " +
        "qon_search_estimates.",
      input: {
        type: "object",
        required: ["committee_id", "round_id", "portfolio_id", "number"],
        properties: {
          committee_id: { type: "integer" },
          round_id: { type: "integer" },
          portfolio_id: { type: "integer" },
          number: { type: "integer", description: "The `number` from the search result." },
          id: {
            type: "integer",
            description: "The search result's `id`, for attachments and transfers.",
          },
        },
      },
      async run({ committee_id, round_id, portfolio_id, number, id }) {
        const q = new URLSearchParams({
          committeeid: String(committee_id),
          estimatesroundid: String(round_id),
          portfolioid: String(portfolio_id),
          number: String(number),
        });
        const [detail, files, moved] = await Promise.all([
          callPlain<EstimatesRow & Record<string, unknown>>(`/api/qon/getestimatesquestion?${q}`),
          id === undefined ? undefined : attachments(id).catch(failure),
          id === undefined ? undefined : transfers(id).catch(failure),
        ]);
        const ids = {
          CommitteeId: committee_id,
          EstimatesRoundId: round_id,
          PortfolioId: portfolio_id,
          Number: number,
        };
        return {
          ...asEstimates({ ...detail, ...ids, Id: id ?? detail?.Id ?? 0 }, "full"),
          answered: aphDate(detail?.AnsweredDate),
          question: htmlToText(detail?.QuestionText),
          answer: htmlToText(detail?.AnswerText),
          download: estimatesDownload(ids),
          ...(files === undefined
            ? { note: "Pass `id` from the search result for attachments and transfers." }
            : { attachments: files, transfers: moved }),
        };
      },
    }),
  },
});
