/**
 * mcp-qon, against trimmed copies of what aph.gov.au/qon really sent (27 Nov 2026). The site is
 * never called: fetch is stubbed per endpoint, and what the worker posted is checked against the
 * form the page's own bundle builds.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Worker from "../workers/mcp-qon/src/index";
import {
  estimatesSearchPage,
  failureOf,
  writtenSearchPage,
  isAphErrorPage,
  termsOf,
  aphDate,
  decodeEntities,
  htmlToText,
  matching,
  resetCache,
  writtenForm,
} from "../workers/mcp-qon/src/aph";

type Spec = { name: string; annotations: Record<string, boolean> };
type Out = { content: { type?: string; text: string }[]; isError?: boolean };

/** mcp-fetch's fetch_url as a stub: answers from `pages`, logs each call. */
const fakeFetch = (pages: (args: Record<string, unknown>) => Out) => {
  const calls: Record<string, unknown>[] = [];
  const FETCH = {
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, ...args });
      return pages(args);
    },
  };
  return { calls, env: { ...env, FETCH } as unknown as Env };
};

const worker = (e: Env = env) => new Worker(createExecutionContext(), e);
const call = async (name: string, args: Record<string, unknown>, e?: Env) => {
  const r = (await worker(e).call(`qon_${name}`, args)) as Out;
  return { ...r, json: r.isError ? undefined : JSON.parse(r.content[0]!.text) };
};

/** The page's envelope: `Message` is the payload, serialised a second time. */
const wrapped = (payload: unknown) =>
  Response.json({ IsSuccess: true, Message: JSON.stringify(payload) });

const SENATORS = [
  { Id: "x", Description: "" },
  { Id: "747", Description: "Shoebridge, David" },
  { Id: "739", Description: "Pocock, David" },
  { Id: "742", Description: "Pocock, Barbara" },
  { Id: "750", Description: "Payman, Fatima" },
];
const FORMER_SENATORS = [...SENATORS, { Id: "600", Description: "Patrick, Rex" }];
const MINISTRIES = [
  { Id: "x", Description: "" },
  { Id: "691", Description: "Defence" },
  { Id: "896", Description: "Defence Industry" },
  { Id: "179", Description: "Defence Personnel" },
  { Id: "661", Description: "Foreign Affairs" },
  { Id: "288", Description: "Prime Minister" },
  { Id: "308", Description: "Veterans' Affairs" },
];
const PARLIAMENTS = [
  { Id: "48", Description: "48th" },
  { Id: "47", Description: "47th" },
  { Id: "x", Description: "All" },
];

const Q715 = {
  Id: 251423,
  Number: 715,
  AskedDate: "/Date(1795698000000)/",
  AnsweredDate: null,
  Surname: "Shoebridge",
  Initials: "D.",
  Firstname: "David",
  Title: "Senator",
  Ministry: "Defence",
  Prefix: "Minister representing the Minister for",
  Answered: false,
  Status: "Unanswered",
  Overdue: "No",
  ParliamentNumber: 48,
  QuestionText:
    '<ol>\n    <li style="list-style-type: decimal;">What services does contract CN3906261 with ' +
    'Epiq Australia cover; and, w<span style="font-size: 1em;">hat was the $85,000 amendment ' +
    'signed on 17 June 2026 for.</span></li>\n    <li style="list-style-type: decimal;"><span ' +
    'style="font-size: 1em;">Where are Defence recordings and transcripts stored:</span>\n    ' +
    '<ol>\n        <li style="list-style-type: lower-alpha;"><span style="font-size: 1em;">who ' +
    'controls the encryption keys; and</span></li>\n        <li style="list-style-type: ' +
    'lower-alpha;"><span style="font-size: 1em;">can anyone outside Australia access ' +
    "them.</span></li>\n    </ol>\n    </li>\n</ol>\n<div>&nbsp;</div>",
  AnswerText: "",
  IsTransferred: false,
  IsMultiPortfolioQuestion: false,
};

const table = (data: unknown[], total = data.length) =>
  wrapped({ draw: 1, recordsTotal: total, recordsFiltered: total, data });

type Seen = { path: string; form: URLSearchParams; method: string };

/** Answers the endpoints the page calls; anything else fails the test. */
const stub = (handlers: Record<string, (form: URLSearchParams) => Response>, seen: Seen[] = []) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    expect(url.origin).toBe("https://www.aph.gov.au");
    const form = new URLSearchParams(
      typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
    );
    seen.push({ path: url.pathname, form, method: init?.method ?? "GET" });
    const lists: Record<string, unknown[]> = {
      "/api/qon/GetSenators": form.get("isCurrent") === "false" ? FORMER_SENATORS : SENATORS,
      "/api/qon/GetMinistries/": MINISTRIES,
      "/api/qon/GetParliaments/": PARLIAMENTS,
    };
    if (url.pathname in lists) return wrapped(lists[url.pathname]);
    const h = handlers[url.pathname];
    if (!h) throw new Error(`Unexpected fetch of ${url.pathname}`);
    return h(form);
  });

beforeEach(() => resetCache());
afterEach(() => vi.restoreAllMocks());

describe("the tool list", () => {
  it("carries the qon prefix and only reads", async () => {
    const specs = (await worker().tools({})) as Spec[];
    expect(specs.map((t) => t.name)).toEqual([
      "qon_list",
      "qon_search",
      "qon_get",
      "qon_search_estimates",
      "qon_get_estimates",
      "qon_file",
    ]);
    expect(specs.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });
});

describe("question and answer text", () => {
  it("keeps the numbering, nested as the question nests it", () => {
    expect(htmlToText(Q715.QuestionText)).toBe(
      "1. What services does contract CN3906261 with Epiq Australia cover; and, what was the " +
        "$85,000 amendment signed on 17 June 2026 for.\n" +
        "2. Where are Defence recordings and transcripts stored:\n" +
        "  (a) who controls the encryption keys; and\n" +
        "  (b) can anyone outside Australia access them.",
    );
  });

  it("numbers by depth when nothing is styled, and carries a run's style to an unstyled item", () => {
    const html =
      "<ol><li>Please provide a list of:<ol>" +
      '<li style="list-style-type: lower-alpha;">entity;</li>' +
      '<li style="list-style-type: lower-alpha;">payment amount; and </li>' +
      "<li>payment purpose.</li></ol></li><li>Next</li></ol>";
    expect(htmlToText(html)).toBe(
      "1. Please provide a list of:\n  (a) entity;\n  (b) payment amount; and\n  (c) payment purpose.\n2. Next",
    );
  });

  it("does roman numerals and keeps paragraphs apart", () => {
    const html =
      '<p>With regard to modern slavery:</p><ol><li style="list-style-type: lower-alpha;">a ' +
      'complaint:<ol><li style="list-style-type: lower-roman;">one,</li><li style="list-style-type: ' +
      'lower-roman;">two;</li><li style="list-style-type: lower-roman;">three,</li><li ' +
      'style="list-style-type: lower-roman;">four</li></ol></li></ol>';
    expect(htmlToText(html)).toBe(
      "With regard to modern slavery:\n(a) a complaint:\n  (i) one,\n  (ii) two;\n  (iii) three,\n  (iv) four",
    );
  });

  it("decodes the entities APH uses, which stripHtml turns into spaces", () => {
    expect(
      decodeEntities("Attorney-General&rsquo;s &ldquo;5-Eyes&rdquo; 2025&ndash;27 &#39;x&#x27;"),
    ).toBe("Attorney-General’s “5-Eyes” 2025–27 'x'");
    expect(decodeEntities("&unknownthing;")).toBe("&unknownthing;");
  });
});

describe("dates", () => {
  it("reads ASP.NET dates as the calendar day in Canberra", () => {
    expect(aphDate("/Date(1795698000000)/")).toBe("2026-11-27"); // 00:00 AEDT
    expect(aphDate("/Date(1656424800000)/")).toBe("2022-06-29"); // 00:00 AEST
    expect(aphDate(null)).toBeNull();
  });
});

describe("resolving names", () => {
  const opts = (raw: { Id: string; Description: string }[]) =>
    raw.filter((o) => o.Id !== "x").map((o) => ({ id: o.Id, name: o.Description }));

  it("prefers an exact name over partial ones", () => {
    expect(matching(opts(MINISTRIES), "Defence").map((o) => o.id)).toEqual(["691"]);
    expect(matching(opts(MINISTRIES), "defence").map((o) => o.id)).toEqual(["691"]);
  });

  it("takes first-name-first and surname alone", () => {
    expect(matching(opts(SENATORS), "David Shoebridge").map((o) => o.id)).toEqual(["747"]);
    expect(matching(opts(SENATORS), "shoebridge").map((o) => o.id)).toEqual(["747"]);
    expect(matching(opts(SENATORS), "pocock").map((o) => o.id)).toEqual(["739", "742"]);
  });

  it("ignores apostrophes", () => {
    expect(matching(opts(MINISTRIES), "veterans affairs").map((o) => o.id)).toEqual(["308"]);
  });
});

describe("the search form", () => {
  it("is the page's form, field for field", () => {
    const f = writtenForm({ parliament: "48", status: "all" }, 0, 10);
    expect(f.get("columns[0][data]")).toBe("Number");
    expect(f.get("columns[10][data]")).toBe("10");
    expect(f.get("columns[5][orderable]")).toBe("true");
    expect(f.get("columns[6][orderable]")).toBe("false");
    expect(f.get("order[0][column]")).toBe("0");
    expect(f.get("order[0][dir]")).toBe("desc");
    expect(f.get("fieldParliament")).toBe("48");
    expect(f.get("fieldSenator")).toBe("x");
    expect(f.get("fieldMinistry")).toBe("x");
    expect(f.get("fieldStatus")).toBe("0");
    expect(f.get("fieldKeywords")).toBe("");
  });

  it("refuses a date that is not YYYY-MM-DD", () => {
    expect(() => writtenForm({ dateFrom: "27/11/2026" }, 0, 10)).toThrow(/YYYY-MM-DD/);
  });
});

describe("qon_search", () => {
  it("resolves names, defaults to the current Parliament, and maps rows", async () => {
    const seen: Seen[] = [];
    stub({ "/api/qon/getdata": () => table([Q715], 716) }, seen);
    const r = await call("search", {
      senator: "Shoebridge",
      ministry: "Defence",
      status: "unanswered",
    });
    const form = seen.find((s) => s.path === "/api/qon/getdata")!.form;
    expect(form.get("fieldSenator")).toBe("747");
    expect(form.get("fieldMinistry")).toBe("691");
    expect(form.get("fieldParliament")).toBe("48");
    expect(form.get("fieldStatus")).toBe("2");
    expect(r.json.total).toBe(716);
    expect(r.json.results[0]).toMatchObject({
      number: 715,
      parliament: 48,
      senator: "Senator David Shoebridge",
      asked_of: "Minister representing the Minister for Defence",
      status: "Unanswered",
      overdue: false,
      asked: "2026-11-27",
      answered: null,
      has_answer: false,
      download:
        "https://www.aph.gov.au/api/qon/downloadquestions/Question-ParliamentNumber48-QuestionNumber715",
    });
    expect(r.json.results[0].question.startsWith("1. What services")).toBe(true);
  });

  it("finds a former senator when no current one matches", async () => {
    const seen: Seen[] = [];
    stub({ "/api/qon/getdata": () => table([]) }, seen);
    await call("search", { senator: "Rex Patrick", parliament: "all" });
    const form = seen.find((s) => s.path === "/api/qon/getdata")!.form;
    expect(form.get("fieldSenator")).toBe("600");
    expect(form.get("fieldParliament")).toBe("x");
  });

  it("says which senators an ambiguous name could be", async () => {
    stub({});
    const r = await call("search", { senator: "Pocock" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Pocock, David (739)");
    expect(r.content[0]!.text).toContain("Pocock, Barbara (742)");
  });

  it("pages 100 at a time up to the limit", async () => {
    const seen: Seen[] = [];
    stub(
      {
        "/api/qon/getdata": (f) => {
          const start = Number(f.get("start"));
          const length = Number(f.get("length"));
          const data = Array.from({ length }, (_, i) => ({
            ...Q715,
            Id: start + i,
            Number: 1000 - start - i,
          }));
          return table(data, 1000);
        },
      },
      seen,
    );
    const r = await call("search", { limit: 250, text: "none" });
    const pages = seen
      .filter((s) => s.path === "/api/qon/getdata")
      .map((s) => [s.form.get("start"), s.form.get("length")]);
    expect(pages).toEqual([
      ["0", "100"],
      ["100", "100"],
      ["200", "50"],
    ]);
    expect(r.json.returned).toBe(250);
    expect(r.json.results[0].question).toBeUndefined();
  });

  it("names APH's firewall when it blocks the request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        "<html><head><title>WAF Block Page </title></head><body><h1>Page Blocked by WAF</h1>",
        { status: 403, headers: { "content-type": "text/html" } },
      ),
    );
    const r = await call("search", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("firewall refused the request (HTTP 403");
  });
});

describe("when APH's firewall blocks Cloudflare", () => {
  const waf = () =>
    new Response("<html><title>WAF Block Page </title><h1>Page Blocked by WAF</h1>", {
      status: 403,
      headers: { "content-type": "text/html" },
    });

  it("sends the same request through mcp-fetch's smart route", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => waf());
    const asked: { url: string; opts: Record<string, unknown> }[] = [];
    const FETCH = {
      egress: async (url: string, opts: Record<string, unknown>) => {
        asked.push({ url, opts });
        const path = new URL(url).pathname;
        if (path === "/api/qon/GetParliaments/") return wrapped(PARLIAMENTS);
        if (path === "/api/qon/getdata") return table([Q715], 716);
        throw new Error(`Unexpected egress of ${path}`);
      },
    };
    const r = await call("search", {}, { ...env, FETCH } as unknown as Env);
    expect(r.json.results[0].number).toBe(715);
    const data = asked.find((a) => a.url.endsWith("/api/qon/getdata"))!;
    expect(data.opts).toMatchObject({
      method: "POST",
      via: ["smart"],
      idempotent: true,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(new URLSearchParams(String(data.opts.body)).get("fieldParliament")).toBe("48");
  });

  it("says what was tried when the smart route is refused too", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => waf());
    const FETCH = {
      egress: async () => {
        const res = waf();
        res.headers.set("x-egress-skipped", "smart: blocked (HTTP 403)");
        return res;
      },
    };
    const r = await call("search", {}, { ...env, FETCH } as unknown as Env);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("tried: smart: blocked (HTTP 403)");
  });
});

describe("qon_search with contains", () => {
  const row = (n: number, text: string) => ({
    ...Q715,
    Id: n,
    Number: n,
    QuestionText: `<p>${text}</p>`,
  });

  it("keeps rows whose text has any term, reading 100 a page, and says where to carry on", async () => {
    const seen: Seen[] = [];
    stub(
      {
        "/api/qon/getdata": (f) => {
          const start = Number(f.get("start"));
          const length = Number(f.get("length"));
          const data = Array.from({ length }, (_, i) => {
            const n = 1000 - start - i;
            return row(
              n,
              n % 50 === 0 ? "Exports to Israel" : n % 77 === 0 ? "aid to GAZA" : "Roads",
            );
          });
          return table(data, 1000);
        },
      },
      seen,
    );
    const r = await call("search", { contains: ["gaza", "Israel"], limit: 3, text: "none" });
    const pages = seen
      .filter((s) => s.path === "/api/qon/getdata")
      .map((s) => [s.form.get("start"), s.form.get("length")]);
    expect(pages).toEqual([["0", "100"]]);
    expect(r.json.results.map((x: { number: number }) => x.number)).toEqual([1000, 950, 924]);
    expect(r.json.scanned).toBe(77); // 1000 down to 924
    expect(r.json.next_offset).toBe(77);
    expect(r.json.total_in_scope).toBe(1000);
  });

  it("stops at the scan limit", async () => {
    const seen: Seen[] = [];
    stub(
      {
        "/api/qon/getdata": (f) =>
          table(
            Array.from({ length: Number(f.get("length")) }, (_, i) => row(i, "Roads")),
            1000,
          ),
      },
      seen,
    );
    const r = await call("search", { contains: ["Gaza"], scan: 250, text: "none" });
    const pages = seen
      .filter((s) => s.path === "/api/qon/getdata")
      .map((s) => [s.form.get("start"), s.form.get("length")]);
    expect(pages).toEqual([
      ["0", "100"],
      ["100", "100"],
      ["200", "50"],
    ]);
    expect(r.json).toMatchObject({ scanned: 250, returned: 0, next_offset: 250 });
  });
});

describe("contains, however it is sent", () => {
  it("takes a list, a JSON list in a string, or comma-separated words", () => {
    expect(termsOf(["Gaza", "Israel"])).toEqual(["Gaza", "Israel"]);
    expect(termsOf('["Epiq"]')).toEqual(["Epiq"]);
    expect(termsOf("Gaza, Israel")).toEqual(["Gaza", " Israel"]);
    expect(termsOf("[not json")).toEqual(["[not json"]);
    expect(termsOf(undefined)).toEqual([]);
  });
});

describe("qon_file as images", () => {
  it("asks mcp-fetch for the page images and returns its answer whole", async () => {
    const answer = {
      content: [
        { type: "text", text: "1 embedded image(s), 1 usable; showing 1" },
        { type: "image", data: "/9j/AA==", mimeType: "image/jpeg" },
      ],
    };
    const { calls, env: e } = fakeFetch(() => answer as unknown as Out);
    const r = (await worker(e).call("qon_file", {
      url: "https://www.aph.gov.au/api/qon/downloadattachment?attachmentId=69438bc7-d7ee-42ea-810f-c70c6298be72",
      as: "images",
      max_images: 2,
    })) as unknown as typeof answer;
    expect(calls[0]).toMatchObject({ name: "fetch_url", format: "images", max_images: 2 });
    expect(r.content[1]).toEqual({ type: "image", data: "/9j/AA==", mimeType: "image/jpeg" });
  });
});

describe("links to APH's own pages", () => {
  it("fill in the written search page with what its address reads", () => {
    const u = new URL(
      writtenSearchPage({
        keywords: "Defence",
        senator: "747",
        parliament: "48",
        status: "answered",
        dateFrom: "2026-01-01",
      }),
    );
    expect(u.origin + u.pathname).toBe("https://www.aph.gov.au/qon");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      keywords: "Defence",
      senator: "747",
      parliament: "48",
      dateFrom: "2026-01-01",
      status: "answered",
      onlyCurrentSenators: "false",
      onlyCurrentMinistries: "false",
    });
  });

  it("fill in the estimates search page, leaving out what is empty", () => {
    const u = new URL(
      estimatesSearchPage({ committee: "4", round: "30", agency: "645", status: "all" }),
    );
    expect(u.pathname).toBe("/Parliamentary_Business/Senate_Estimates");
    expect(u.hash).toBe("#qon");
    expect(u.searchParams.get("committee")).toBe("4");
    expect(u.searchParams.get("estimatesRound")).toBe("30");
    expect(u.searchParams.get("agency")).toBe("645");
    expect(u.searchParams.has("status")).toBe(false);
    expect(u.searchParams.has("keywords")).toBe(false);
  });

  it("come with search results, and ParlWork with the current Parliament's questions", async () => {
    stub({ "/api/qon/getdata": () => table([Q715], 716) });
    const r = await call("search", { senator: "Shoebridge" });
    expect(new URL(r.json.search_page).searchParams.get("senator")).toBe("747");
    expect(r.json.results[0].parlwork).toBe("https://parlwork.aph.gov.au/senate/questions/715");
  });
});

describe("APH's failures", () => {
  const nullValues =
    "<!DOCTYPE html><html><head><title>Value cannot be null.<br>Parameter name: values</title>";

  it("calls 'Value cannot be null' a fault at APH, not an empty result", async () => {
    stub({ "/api/qon/getestimatesdata": () => new Response(nullValues, { status: 500 }) });
    const r = await call("search_estimates", { keywords: "Pinczewski" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("APH's server failed (HTTP 500");
    expect(r.content[0]!.text).toContain("not a lack of results");
  });

  it("gives other failures their page title, not the page", () => {
    expect(failureOf("/x", 502, "<html><title>Bad Gateway</title><body>…</body>")).toBe(
      "aph.gov.au /x: HTTP 502 Bad Gateway",
    );
  });

  it("knows APH's error page when mcp-fetch hands it back as content", async () => {
    const page =
      "---\ndescription: 500 Page not found\n---\n\n# 500 Error\n\nThere seems to be a problem with the page.";
    expect(isAphErrorPage(page)).toBe(true);
    expect(isAphErrorPage("# Question 482\n\nAnswer: Council noted…")).toBe(false);
    const { env: e } = fakeFetch(() => ({ content: [{ type: "text", text: page }] }));
    const r = (await worker(e).call("qon_file", {
      url: "https://www.aph.gov.au/api/qon/downloadestimatesquestions/EstimatesQuestion-CommitteeId4-EstimatesRoundId30-PortfolioId41-QuestionNumber380",
    })) as Out;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("with its error page");
  });
});

describe("an attachment list that comes back empty", () => {
  it("is no attachments, not an error", async () => {
    stub({
      "/api/qon/getdata": () => table([Q715]),
      "/api/qon/getattachmentlist": () => new Response("", { status: 200 }),
    });
    const r = await call("get", { number: 715 });
    expect(r.json.attachments).toEqual([]);
  });
});

describe("qon_get", () => {
  it("returns the full text with transfers and attachments", async () => {
    const seen: Seen[] = [];
    stub(
      {
        "/api/qon/getdata": () =>
          table([{ ...Q715, IsTransferred: true, AnswerText: "<p>The answer&rsquo;s here.</p>" }]),
        "/api/qon/gettransfer": () =>
          wrapped([
            {
              TransferredOnDate: "/Date(1795784400000)/",
              TransferredFrom: "Defence",
              TransferredTo: "Defence Industry",
            },
          ]),
        "/api/qon/getattachmentlist": () =>
          Response.json([{ Id: 99, Attachment_FileName: "QON715.pdf" }]),
      },
      seen,
    );
    const r = await call("get", { number: 715 });
    expect(seen.find((s) => s.path === "/api/qon/getdata")!.form.get("fieldQuestionNumber")).toBe(
      "715",
    );
    expect(seen.find((s) => s.path === "/api/qon/gettransfer")!.form.get("questionId")).toBe(
      "251423",
    );
    expect(r.json.answer).toBe("The answer’s here.");
    expect(r.json.transfers).toEqual([
      { date: "2026-11-28", from: "Defence", to: "Defence Industry" },
    ]);
    expect(r.json.attachments).toEqual([
      {
        file: "QON715.pdf",
        url: "https://www.aph.gov.au/api/qon/downloadattachment?attachmentId=99",
      },
    ]);
  });

  it("says so when the number is not there", async () => {
    stub({ "/api/qon/getdata": () => table([]) });
    const r = await call("get", { number: 9999, parliament: 47 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("No question 9999 in the 47th Parliament");
  });
});

describe("APH's files as markdown", () => {
  const files = () => ({
    "/api/qon/getdata": () => table([{ ...Q715, Status: "Answered" }]),
    "/api/qon/getattachmentlist": () =>
      Response.json([{ Id: 99, Attachment_FileName: "QON715.pdf" }]),
  });

  it("leaves files as links unless asked", async () => {
    stub(files());
    const { calls, env: e } = fakeFetch(() => ({ content: [{ type: "text", text: "x" }] }));
    const r = await call("get", { number: 715 }, e);
    expect(r.json.documents).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("reads the download and each attachment through mcp-fetch's fetch_url", async () => {
    stub(files());
    const { calls, env: e } = fakeFetch((a) =>
      String(a.url).includes("attachmentId")
        ? { content: [{ type: "text", text: "conversion failed" }], isError: true }
        : { content: [{ type: "text", text: "# Question 715\n\nAnswer text" }] },
    );
    const r = await call("get", { number: 715, files: "markdown", via: ["tunnel"] }, e);
    expect(calls).toEqual([
      {
        name: "fetch_url",
        url: "https://www.aph.gov.au/api/qon/downloadquestions/Question-ParliamentNumber48-QuestionNumber715",
        format: "auto",
        via: ["tunnel"],
      },
      {
        name: "fetch_url",
        url: "https://www.aph.gov.au/api/qon/downloadattachment?attachmentId=99",
        format: "auto",
        via: ["tunnel"],
      },
    ]);
    expect(r.json.documents).toEqual([
      {
        name: "question and answer",
        url: "https://www.aph.gov.au/api/qon/downloadquestions/Question-ParliamentNumber48-QuestionNumber715",
        markdown: "# Question 715\n\nAnswer text",
      },
      {
        name: "QON715.pdf",
        url: "https://www.aph.gov.au/api/qon/downloadattachment?attachmentId=99",
        error: "conversion failed",
      },
    ]);
  });

  it("qon_file reads one link, and only APH's question files", async () => {
    const { calls, env: e } = fakeFetch(() => ({
      content: [{ type: "text", text: "# Attachment" }],
    }));
    const ok = (await worker(e).call("qon_file", {
      url: "https://www.aph.gov.au/api/qon/downloadattachment?attachmentId=99",
      force: true,
    })) as Out;
    expect(ok.content[0]!.text).toBe("# Attachment");
    expect(calls[0]).toMatchObject({ format: "auto", force: true });
    const bad = (await worker(e).call("qon_file", { url: "https://example.com/x.pdf" })) as Out;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("Not a questions-on-notice file");
    expect(calls).toHaveLength(1);
  });
});

describe("qon_search_estimates", () => {
  it("sends the estimates form and maps the askers", async () => {
    const seen: Seen[] = [];
    stub(
      {
        "/api/qon/getestimatesdata": () =>
          table([
            {
              Id: 5,
              Number: 12,
              PortfolioQuestionNumber: "SQ26-000123",
              Senators: [{ Title: "Senator", FirstName: "David", Surname: "Shoebridge" }],
              Committee: "Foreign Affairs, Defence and Trade",
              CommitteeId: 3,
              EstimatesRoundName: "Supplementary Budget Estimates 2026-2027",
              EstimatesRoundId: 7,
              Portfolio: "Defence",
              PortfolioId: 9,
              BroadTopic: "Exports",
              Agency: "Department of Defence",
              Status: "Answered",
              AskedDate: "/Date(1795698000000)/",
              Overdue: "No",
            },
          ]),
      },
      seen,
    );
    const r = await call("search_estimates", { keywords: "Israel", senator: "747" });
    const form = seen.find((s) => s.path === "/api/qon/getestimatesdata")!.form;
    expect(form.get("fieldKeywords")).toBe("Israel");
    expect(form.get("fieldSenator")).toBe("747");
    expect(form.get("fieldCommittee")).toBe("x");
    expect(form.get("columns[16][data]")).toBe("");
    expect(form.get("columns[9][orderable]")).toBe("true");
    expect(form.get("columns[10][orderable]")).toBe("false");
    expect(r.json.results[0]).toMatchObject({
      senators: ["Senator David Shoebridge"],
      round: "Supplementary Budget Estimates 2026-2027",
      download:
        "https://www.aph.gov.au/api/qon/downloadestimatesquestions/EstimatesQuestion-CommitteeId3-EstimatesRoundId7-PortfolioId9-QuestionNumber12",
    });
  });
});
