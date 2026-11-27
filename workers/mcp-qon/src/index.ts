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
import { mcpWorker, tool, type Result } from "../../../core/mcp";
import { blockedBy, ROUTES } from "../../../core/egress";
import {
  asEstimates,
  asWritten,
  attachments,
  BASE,
  callPlain,
  direct,
  headersFor,
  type Net,
  ESTIMATES_ORDER,
  estimatesDownload,
  estimatesForm,
  aphDate,
  htmlToText,
  list,
  LISTS,
  resolve,
  mentions,
  termsOf,
  scanTable,
  SCAN_DEFAULT,
  SCAN_MAX,
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
const currentParliament = async (net: Net) => (await list(net, "parliaments"))[0]?.id ?? "x";

const parliamentParam = async (net: Net, p?: number | string) => {
  if (p === undefined || p === "") return currentParliament(net);
  if (String(p).toLowerCase() === "all") return "x";
  const n = String(p).replace(/\D/g, "");
  if (!n) throw new Error(`parliament is a number like 48, or "all"; got "${p}".`);
  return n;
};

// ─── APH's own files, through mcp-fetch ──────────────────────────────────────────────────────

/** What this worker uses of mcp-fetch over RPC: its fetch_url tool and its egress routes. */
type FetchRpc = {
  call(name: string, args: object): Promise<Result>;
  egress(
    url: string,
    opts: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
      via?: string[];
      idempotent?: boolean;
    },
  ): Promise<Response>;
};
const fetcher = (env: Env) => env.FETCH as unknown as FetchRpc;

/**
 * Cloudflare's own fetch first, which is free. Only when APH's firewall refuses it does the same
 * request go through mcp-fetch's smart route (Apify's Unblocker, billed per request). Every call
 * here only reads, so the smart route may repeat it.
 */
const netFor =
  (env: Env): Net =>
  async (path, init) => {
    const res = await direct(path, init);
    if (!blockedBy(res) || !env.FETCH) return res;
    await res.body?.cancel();
    return fetcher(env).egress(`${BASE}${path}`, {
      method: init.method,
      ...(init.body !== undefined && { body: init.body }),
      headers: headersFor(init.body),
      via: ["smart"],
      idempotent: true,
    });
  };

/** The downloads this worker hands out; qon_file reads nothing else. */
const QON_FILE = new RegExp(
  `^${BASE.replace(/\./g, "\\.")}/api/qon/(downloadquestions|downloadestimatesquestions|downloadattachment)\\b`,
  "i",
);

type FileRef = { name: string; url: string };
type FileOpts = { via?: string[] | undefined; force?: boolean | undefined };

/**
 * One APH file as markdown, via mcp-fetch's fetch_url: it keeps the original bytes, so a second
 * read is free, and converts PDF and Word with Workers AI. A plain GET, so mcp-fetch's routes
 * (the home tunnel among them) can reach it even where APH's firewall refuses the API.
 */
const markdownOf = async (env: Env, url: string, o: FileOpts = {}) => {
  const out = await fetcher(env).call("fetch_url", {
    url,
    format: "auto",
    ...(o.via?.length ? { via: o.via } : {}),
    ...(o.force ? { force: true } : {}),
  });
  const text = out.content[0]?.text ?? "";
  if (out.isError) throw new Error(text || `Could not read ${url}`);
  return text;
};

/** Each file with its markdown, or why there is none; one failure costs that file only. */
const documents = (env: Env, files: FileRef[], o: FileOpts) =>
  Promise.all(
    files.map(async (f) => {
      try {
        return { ...f, markdown: await markdownOf(env, f.url, o) };
      } catch (e) {
        return { ...f, error: failure(e) };
      }
    }),
  );

const FILES = {
  type: "string",
  enum: ["links", "markdown"],
  description:
    "APH's own files: the question-and-answer download (as APH serves it, usually a PDF) and " +
    "any answer attachments. links (default): their URLs, to open or save. markdown: also " +
    "read each one through mcp-fetch, which caches it, and include its text as markdown.",
} as const;

const VIA = {
  type: "array",
  items: { type: "string", enum: [...ROUTES] },
  description:
    "For files: markdown, mcp-fetch's routes, in order (e.g. ['tunnel'] for the home " +
    "connection). Default: mcp-fetch's own.",
} as const;

export default mcpWorker({
  ...cfg,
  // FETCH is bound to call mcp-fetch, not to put its tools on this connector.
  services: [],
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
      "'Question on notice no. 716 (48th Parliament)'. For words in written questions' text, " +
      "use qon_search's `contains`, not `keywords`, which matches minister names. Search returns snippets; qon_get gives " +
      "the full text, transfers between portfolios and answer attachments. Senators, " +
      "ministries, committees, portfolios, agencies and estimates rounds may be named rather " +
      "than given as IDs; qon_list shows the options. The 'download' links and answer " +
      "attachments are APH's own files (usually PDFs): give the user the link, or read one as " +
      "markdown with qon_file, or all of a question's with files: 'markdown' on qon_get.",
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
      async run({ of, current_only = true, filter }, c) {
        let options = await list(netFor(c.env), of, current_only);
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
          keywords: {
            type: "string",
            description:
              "APH's Keywords box. For written questions it matches minister and portfolio " +
              "names, not the question text: use `contains` for words in the text.",
          },
          senator: COMMON.senator,
          ministry: {
            type: "string",
            description:
              "The minister asked, by portfolio: 'Foreign Affairs', 'Defence', 'Prime " +
              "Minister', 'Attorney-General', or an ID. An exact name wins over partial matches.",
          },
          contains: {
            type: "array",
            items: { type: "string" },
            description:
              "Words or phrases to find in the question or answer text: a match has ANY of " +
              "them, ignoring case, e.g. ['Gaza', 'Israel', 'Palestin']. APH's own Keywords " +
              "box only matches minister and portfolio names, so this reads the text of each " +
              "result page (100 questions a request) and keeps the matches. Narrow it with " +
              "senator, ministry, parliament or dates, which APH applies first.",
          },
          scan: {
            type: "integer",
            minimum: 1,
            maximum: SCAN_MAX,
            description:
              `With contains: how many questions to read at most, default ${SCAN_DEFAULT}. The ` +
              "result's next_offset carries on from where it stopped.",
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
      async run(a, c) {
        const net = netFor(c.env);
        const [senator, ministry, parliament] = await Promise.all([
          a.senator ? resolve(net, "senators", a.senator) : undefined,
          a.ministry ? resolve(net, "ministries", a.ministry) : undefined,
          parliamentParam(net, a.parliament),
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
        const form = (start: number, length: number) => writtenForm(query, start, length);
        const text = (a.text ?? "snippet") as TextMode;
        const contains = termsOf(a.contains).filter((t) => t.trim());
        if (contains.length) {
          const scan = Math.min(a.scan ?? SCAN_DEFAULT, SCAN_MAX);
          const found = await scanTable<WrittenRow>(
            net,
            "/api/qon/getdata",
            form,
            mentions(contains),
            offset,
            limit,
            scan,
          );
          return {
            filters: {
              parliament: parliament === "x" ? "all" : Number(parliament),
              ...(senator ? { senator_id: senator } : {}),
              ...(ministry ? { ministry_id: ministry } : {}),
              contains,
            },
            total_in_scope: found.total,
            offset,
            scanned: found.scanned,
            returned: found.rows.length,
            ...(found.next_offset !== undefined && { next_offset: found.next_offset }),
            results: found.rows.map((r) => asWritten(r, text)),
          };
        }
        const { total, rows } = await searchTable<WrittenRow>(
          net,
          "/api/qon/getdata",
          form,
          offset,
          limit,
        );
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
        "kept, dates, status, any transfers between portfolios, and the answer's attachments. " +
        "files: markdown also reads APH's own download and attachments as markdown.",
      input: {
        type: "object",
        required: ["number"],
        properties: {
          number: { type: "integer", description: "Question on notice number." },
          parliament: {
            type: ["integer", "string"],
            description: "Parliament number, default the current one.",
          },
          files: FILES,
          via: VIA,
        },
      },
      async run({ number, parliament, files: mode, via }, c) {
        const net = netFor(c.env);
        const p = await parliamentParam(net, parliament);
        if (p === "x") throw new Error("Numbers restart each Parliament; name one, e.g. 48.");
        const { rows } = await searchTable<WrittenRow>(
          net,
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
              r.IsTransferred ? transfers(net, r.Id).catch(failure) : Promise.resolve([]),
              attachments(net, r.Id).catch(failure),
            ]);
            const q = asWritten(r, "full");
            const refs: FileRef[] = [
              ...(q.download ? [{ name: "question and answer", url: q.download }] : []),
              ...(Array.isArray(files) ? files.map((f) => ({ name: f.file, url: f.url })) : []),
            ];
            return {
              ...q,
              transfers: moved,
              attachments: files,
              ...(mode === "markdown" ? { documents: await documents(c.env, refs, { via }) } : {}),
            };
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
      async run(a, c) {
        const net = netFor(c.env);
        const [senator, committee, round, portfolio, agency] = await Promise.all([
          a.senator ? resolve(net, "senators", a.senator) : undefined,
          a.committee ? resolve(net, "committees", a.committee) : undefined,
          a.estimates_round ? resolve(net, "estimates_rounds", a.estimates_round) : undefined,
          a.portfolio ? resolve(net, "portfolios", a.portfolio) : undefined,
          a.agency ? resolve(net, "agencies", a.agency) : undefined,
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
          net,
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
          files: FILES,
          via: VIA,
        },
      },
      async run({ committee_id, round_id, portfolio_id, number, id, files: mode, via }, c) {
        const net = netFor(c.env);
        const q = new URLSearchParams({
          committeeid: String(committee_id),
          estimatesroundid: String(round_id),
          portfolioid: String(portfolio_id),
          number: String(number),
        });
        const [detail, files, moved] = await Promise.all([
          callPlain<EstimatesRow & Record<string, unknown>>(
            net,
            `/api/qon/getestimatesquestion?${q}`,
          ),
          id === undefined ? undefined : attachments(net, id).catch(failure),
          id === undefined ? undefined : transfers(net, id).catch(failure),
        ]);
        const ids = {
          CommitteeId: committee_id,
          EstimatesRoundId: round_id,
          PortfolioId: portfolio_id,
          Number: number,
        };
        const refs: FileRef[] = [
          { name: "question and answer", url: estimatesDownload(ids) },
          ...(Array.isArray(files) ? files.map((f) => ({ name: f.file, url: f.url })) : []),
        ];
        return {
          ...asEstimates({ ...detail, ...ids, Id: id ?? detail?.Id ?? 0 }, "full"),
          answered: aphDate(detail?.AnsweredDate),
          question: htmlToText(detail?.QuestionText),
          answer: htmlToText(detail?.AnswerText),
          download: estimatesDownload(ids),
          ...(files === undefined
            ? { note: "Pass `id` from the search result for attachments and transfers." }
            : { attachments: files, transfers: moved }),
          ...(mode === "markdown" ? { documents: await documents(c.env, refs, { via }) } : {}),
        };
      },
    }),

    file: tool({
      description:
        "Read one of APH's question files as markdown: a `download` link from a search or get " +
        "result, or an attachment `url`. Read through mcp-fetch, which caches it, so asking " +
        "again is free. To hand the user the file itself (usually a PDF), give them the link.",
      input: {
        type: "object",
        required: ["url"],
        properties: {
          url: {
            type: "string",
            description:
              `A ${BASE}/api/qon/downloadquestions/…, downloadestimatesquestions/… or ` +
              "downloadattachment?attachmentId=… link.",
          },
          via: VIA,
          force: { type: "boolean", description: "Download again instead of using the cache." },
        },
      },
      async run({ url, via, force }, c) {
        if (!QON_FILE.test(url))
          throw new Error(
            `Not a questions-on-notice file: ${url}. Use a download or attachment link from ` +
              "qon_search, qon_get or qon_get_estimates.",
          );
        return markdownOf(c.env, url, { via, force });
      },
    }),
  },
});
