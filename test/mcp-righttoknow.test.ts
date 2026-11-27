/**
 * mcp-righttoknow, against trimmed copies of what righttoknow.org.au really sent (27 Nov 2026).
 * The site is never called: `fetch` is stubbed per test, and mcp-fetch is a stub binding.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import Worker from "../workers/mcp-righttoknow/src/index";
import {
  cleanSnippet,
  decode,
  findAuthorities,
  htmlToText,
  parseAuthorities,
  parseCorrespondence,
  parseCsv,
  requestRef,
  slugOf,
  tagCounts,
  toEntry,
  type RawEvent,
} from "../workers/mcp-righttoknow/src/rtk";

type Spec = {
  name: string;
  annotations: Record<string, boolean>;
  inputSchema: { required?: string[] };
};
type Out = { content: { text: string }[]; isError?: boolean };
const REQ = "https://www.righttoknow.org.au/request/internal_anu_correspondence_conc";

/** mcp-fetch's fetch_url, kept copies and all, as a stub: answers from `pages`, logs each call. */
const fakeFetch = (pages: (args: Record<string, unknown>) => string) => {
  const calls: Record<string, unknown>[] = [];
  const FETCH = {
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, ...args });
      return { content: [{ type: "text", text: pages(args) }] };
    },
    egress: async () => new Response("", { status: 500 }),
  };
  return { calls, env: { ...env, FETCH } as unknown as Env };
};
const worker = (e: Env = env) => new Worker(createExecutionContext(), e);
const run = async (name: string, args: object, e?: Env) =>
  (await worker(e).call(name, args)) as Out;
const json = (r: Out) => JSON.parse(r.content[0]!.text);

/** `/feed/search/antisemitism.json`, two events. */
const SEARCH: RawEvent[] = [
  {
    id: 525741,
    event_type: "response",
    created_at: "2026-11-27T13:48:04.554+11:00",
    described_state: null,
    calculated_state: null,
    last_described_at: null,
    incoming_message_id: 51880,
    outgoing_message_id: null,
    comment_id: null,
    display_status: "Response",
    snippet:
      '...ivities;\n• inform debate on a matter of public importance. There is significant public interest in how\nthe University responds to complaints alleging <span class="highlight">antisemitism</span>. This matter has been raised at\nSenate Estimates on 5 June and 29 October 2026 and reported in the national press, and it\nsits alongside the work of...',
    info_request: {
      id: 15604,
      url_title: "internal_anu_correspondence_conc",
      title: "Internal ANU correspondence concerning Dr Andrew Hammond, March to August 2026",
      display_status: "Awaiting classification",
    },
    public_body: {
      id: 723,
      url_name: "anu",
      name: "Australian National University",
      short_name: "ANU",
    },
    user: { id: 10154, url_name: "s_p", name: "S P" },
  },
  {
    id: 525727,
    event_type: "response",
    created_at: "2026-11-27T08:38:54.562+11:00",
    described_state: null,
    calculated_state: null,
    last_described_at: null,
    incoming_message_id: 51872,
    outgoing_message_id: null,
    comment_id: null,
    display_status: "Response",
    snippet:
      '...eedom of Information Act\n 1982 (Cth), for documents held by the Department, including documents of\n the Office of Australia\'s Special Envoy to Combat <span class="highlight">Antisemitism</span>.\n\n The Australian Government response to the Special Envoy\'s Plan to Combat\n <span class="highlight">Antisemitism</span>, published by the Department, records that the Special Envo...',
    info_request: {
      id: 15912,
      url_title: "development_of_the_building_an_u",
      title: 'Development of the "Building an understanding of antisemitism" eLearn module',
      display_status: "Awaiting classification",
    },
    public_body: {
      id: 786,
      url_name: "home_affairs",
      name: "Department of Home Affairs",
      short_name: "Home Affairs",
    },
    user: { id: 10267, url_name: "mekomit_dotexe", name: "Mekomit Dotexe" },
  },
];

/** `/request/internal_anu_correspondence_conc/feed.json`, three of its events. */
const REQUEST_FEED: RawEvent[] = [
  {
    id: 525741,
    event_type: "response",
    created_at: "2026-11-27T13:48:04.554+11:00",
    described_state: null,
    calculated_state: null,
    last_described_at: null,
    incoming_message_id: 51880,
    outgoing_message_id: null,
    comment_id: null,
    display_status: "Response",
    snippet:
      "Dear S P,\n\n &nbsp;\n\n I refer to your request for access to documents under the Freedom of\n Information Act 1982 (Cth) (the FOI Act), reference FOI 202600332...",
    info_request: {
      id: 15604,
      url_title: "internal_anu_correspondence_conc",
      title: "Internal ANU correspondence concerning Dr Andrew Hammond, March to August 2026",
      display_status: "Awaiting classification",
    },
    public_body: {
      id: 723,
      url_name: "anu",
      name: "Australian National University",
      short_name: "ANU",
    },
    user: { id: 10154, url_name: "s_p", name: "S P" },
  },
  {
    id: 522775,
    event_type: "response",
    created_at: "2026-10-06T16:04:21.701+11:00",
    described_state: null,
    calculated_state: "waiting_response",
    last_described_at: "2026-10-19T23:59:04.053+11:00",
    incoming_message_id: 50918,
    outgoing_message_id: null,
    comment_id: null,
    display_status: "Awaiting response",
    snippet:
      "Dear S P,\n\nI refer to your two requests for access to documents under the Freedom of Information Act 1982 (Cth) (the FOI Act), received by the Australi...",
    info_request: {
      id: 15604,
      url_title: "internal_anu_correspondence_conc",
      title: "Internal ANU correspondence concerning Dr Andrew Hammond, March to August 2026",
      display_status: "Awaiting classification",
    },
    public_body: {
      id: 723,
      url_name: "anu",
      name: "Australian National University",
      short_name: "ANU",
    },
    user: { id: 10154, url_name: "s_p", name: "S P" },
  },
  {
    id: 517967,
    event_type: "sent",
    created_at: "2026-09-08T22:05:02.175+10:00",
    described_state: "waiting_response",
    calculated_state: "waiting_response",
    last_described_at: "2026-09-08T22:05:02.418+10:00",
    incoming_message_id: null,
    outgoing_message_id: 32450,
    comment_id: null,
    display_status: "Clarification",
    snippet:
      "Under the Freedom of Information Act 1982 (Cth), I request the documents described below, held by any of the Specified Officers during the Period.\n\nDE...",
    info_request: {
      id: 15604,
      url_title: "internal_anu_correspondence_conc",
      title: "Internal ANU correspondence concerning Dr Andrew Hammond, March to August 2026",
      display_status: "Awaiting classification",
    },
    public_body: {
      id: 723,
      url_name: "anu",
      name: "Australian National University",
      short_name: "ANU",
    },
    user: { id: 10154, url_name: "s_p", name: "S P" },
  },
];

const META = {
  id: 15604,
  url_title: "internal_anu_correspondence_conc",
  title: "Internal ANU correspondence concerning Dr Andrew Hammond, March to August 2026",
  created_at: "2026-09-08T22:05:01.807+10:00",
  updated_at: "2026-11-27T13:48:04.604+11:00",
  described_state: "waiting_response",
  display_status: "Awaiting classification",
  awaiting_description: true,
  law_used: "foi",
  tags: [],
  user: { id: 10154, url_name: "s_p", name: "S P" },
  public_body: {
    id: 723,
    url_name: "anu",
    name: "Australian National University",
    short_name: "ANU",
  },
  info_request_events: [
    {
      id: 517967,
      event_type: "sent",
      created_at: "2026-09-08T22:05:02.175+10:00",
      described_state: "waiting_response",
      calculated_state: "waiting_response",
      incoming_message_id: null,
      outgoing_message_id: 32450,
      comment_id: null,
    },
    {
      id: 522775,
      event_type: "response",
      created_at: "2026-10-06T16:04:21.701+11:00",
      described_state: null,
      calculated_state: "waiting_response",
      incoming_message_id: 50918,
      outgoing_message_id: null,
      comment_id: null,
    },
    {
      id: 523590,
      event_type: "overdue",
      created_at: "2026-10-09T00:00:00.000+11:00",
      described_state: null,
      calculated_state: null,
      incoming_message_id: null,
      outgoing_message_id: null,
      comment_id: null,
    },
  ],
};

const PAGE = `<div class="outgoing correspondence js-collapsible" id="outgoing-32695">
    <div class="correspondence__header correspondence__header--with-delivery-status">
      <span class="correspondence__header__author js-collapsible-trigger">
        S P
      </span>
      <a class="correspondence__header__date" href="#outgoing-32695">
          <time datetime="2026-09-24T16:36:19+10:00" title="2026-09-24 16:36:19 +1000">September 24, 2026</time>
</a>
    </div>
    <div class="correspondence_text">
      <div><p>Good afternoon,</p>

<p>For Categories 1 and 2, &#8220;between Specified Officers&#8221; should also include file notes.
<br />Thank you.</p></div>
    </div>
    <p class="event_actions">
    </p>
</div>
<div class="incoming correspondence normal js-collapsible" id="incoming-50918">
  <div class="correspondence__header">
    <span class="correspondence__header__author js-collapsible-trigger">
        Freedom of Information,
        Australian National University
    </span>
    <a class="correspondence__header__date" href="#incoming-50918">
      <time datetime="2026-10-06T16:03:44+11:00" title="2026-10-06 16:03:44 +1100">October 06, 2026</time>
</a>  </div>
    <div class="correspondence_text">
        <div class="attachments">
    <div class="attachments__header"><h3>1 Attachment</h3></div>
    <ul class="list-of-attachments">
        <li class="attachment" id="attachment-158118">
            <a href="/request/internal_anu_correspondence_conc/response/50918/attach/2/FOIs%20202600332%20Consultation.pdf?cookie_passthrough=1"><img class="attachment__image" alt="Attachment" src="/x.png" /></a>
            <p class="attachment__name">
              FOIs 202600332 Consultation.pdf
            </p>
            <p class="attachment__meta">
              772K
                <a href="/request/internal_anu_correspondence_conc/response/50918/attach/html/2/FOIs%20202600332%20Consultation.pdf.html">View</a>
              <a href="/request/internal_anu_correspondence_conc/response/50918/attach/2/FOIs%20202600332%20Consultation.pdf?cookie_passthrough=1">Download</a>
            </p>
</li>    </ul>
    <a href="#" class="attachments__show-more" style="display: none;" data-show-all="Show all attachments" data-show-fewer="Show fewer attachments"></a>
  </div>

<div id="attachment-158117">
    <p>Dear S P,</p>
<p>This is a notice under section 24AB of the FOI Act.</p>
<p><span class="unfold_link"><a href="?unfold=1#incoming-50918">show quoted sections</a></span></p>
</div>
    </div>
    <p class="event_actions">
    </p>
</div>
<div class="sidebar">Requests like this</div>`;

/** Answers the free JSON endpoints; anything else (an HTML page) fails the test. */
const stubJson = (asked: string[] = []) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(url.pathname);
    if (
      url.pathname === "/request/15604.json" ||
      url.pathname === "/request/internal_anu_correspondence_conc.json"
    )
      return Response.json(META);
    if (url.pathname === "/request/internal_anu_correspondence_conc/feed.json")
      return Response.json(REQUEST_FEED);
    if (url.pathname.startsWith("/feed/")) return Response.json(SEARCH);
    throw new Error(`Unexpected fetch of ${url.pathname}`);
  });

afterEach(() => vi.restoreAllMocks());

describe("the tool list", () => {
  it("keeps the challenged pages behind righttoknow_full_*, each needing user_confirmed", async () => {
    const specs = (await worker().tools({})) as Spec[];
    expect(specs.map((t) => t.name)).toEqual([
      "righttoknow_search",
      "righttoknow_request",
      "righttoknow_feed",
      "righttoknow_authority",
      "righttoknow_user",
      "righttoknow_authorities",
      "righttoknow_site",
      "righttoknow_citations",
      "righttoknow_link",
      "righttoknow_full_request",
      "righttoknow_full_attachment",
    ]);
    for (const t of specs) {
      const full = t.name.startsWith("righttoknow_full_");
      expect(t.annotations.readOnlyHint).toBe(!full);
      expect(t.inputSchema.required?.includes("user_confirmed") ?? false).toBe(full);
    }
  });
});

describe("feed events", () => {
  it("carry the request's slug, so nothing needs an event link resolved", () => {
    const [a, b] = SEARCH.map(toEntry);
    expect(a).toMatchObject({
      event_id: 525741,
      type: "response",
      request: { slug: "internal_anu_correspondence_conc", id: 15604 },
      authority: { slug: "anu", short_name: "ANU" },
      requester: { slug: "s_p", name: "S P" },
      url: `${REQ}#incoming-51880`,
    });
    // The search hit's highlight markup is gone, and so are the entities.
    expect(a!.snippet).toContain("complaints alleging antisemitism");
    expect(a!.snippet).not.toMatch(/<|&nbsp;/);
    expect(b).toMatchObject({ authority: { slug: "home_affairs" } });
  });

  it("clean up a snippet's markup and spacing", () => {
    expect(cleanSnippet('Dear S P,\n\n &nbsp;\n\n I <span class="highlight">refer</span>...')).toBe(
      "Dear S P, I refer...",
    );
  });
});

describe("the request page", () => {
  it("reads every message, with its author, date, text and attachments", () => {
    const [out, inc, ...rest] = parseCorrespondence(PAGE, REQ);
    expect(rest).toHaveLength(0);
    expect(out).toMatchObject({
      id: "outgoing-32695",
      author: "S P",
      date: "2026-09-24T16:36:19+10:00",
      text: "Good afternoon,\n\nFor Categories 1 and 2, “between Specified Officers” should also include file notes.\nThank you.",
      attachments: [],
    });
    expect(inc!.author).toBe("Freedom of Information, Australian National University");
    // The attachment list and the "show quoted sections" link are not part of the text.
    expect(inc!.text).toBe("Dear S P,\n\nThis is a notice under section 24AB of the FOI Act.");
    expect(inc!.attachments).toEqual([
      {
        name: "FOIs 202600332 Consultation.pdf",
        size: "772K",
        url: `${REQ}/response/50918/attach/2/FOIs%20202600332%20Consultation.pdf?cookie_passthrough=1`,
        view_url: `${REQ}/response/50918/attach/html/2/FOIs%20202600332%20Consultation.pdf.html`,
      },
    ]);
  });

  it("keeps one line break where the site writes a newline before <br />", () => {
    expect(htmlToText("<p>a\n<br />b</p>")).toBe("a\nb");
    expect(decode("&amp;nbsp; &#8220;x&#x201D;")).toBe("&nbsp; “x”");
  });
});

describe("references", () => {
  it("take a slug, an id or a request URL, and refuse an event link", () => {
    expect(requestRef("internal_anu_correspondence_conc")).toEqual({
      slug: "internal_anu_correspondence_conc",
    });
    expect(requestRef("15604")).toEqual({ id: "15604" });
    expect(requestRef(`${REQ}#incoming-50918`)).toEqual({
      slug: "internal_anu_correspondence_conc",
    });
    expect(() => requestRef("https://www.righttoknow.org.au/request_event/525741")).toThrow(/slug/);
    expect(slugOf("https://www.righttoknow.org.au/body/home_affairs", "body")).toBe("home_affairs");
  });
});

describe("righttoknow_request", () => {
  it("joins the request's JSON and its feed's snippets, loading no HTML", async () => {
    const asked: string[] = [];
    stubJson(asked);
    const out = json(await run("righttoknow_request", { request: "15604" }));
    expect(asked).toEqual([
      "/request/15604.json",
      "/request/internal_anu_correspondence_conc/feed.json",
    ]);
    expect(out).toMatchObject({
      slug: "internal_anu_correspondence_conc",
      authority: { slug: "anu" },
      requester: { slug: "s_p" },
    });
    expect(out.events.map((e: { message?: string }) => e.message)).toEqual([
      "outgoing-32450",
      "incoming-50918",
      undefined,
    ]);
    expect(out.events[1].snippet).toMatch(/^Dear S P, I refer to your two requests/);
  });

  it("gives messages in full from a kept page, snippets where it has none", async () => {
    stubJson();
    // PAGE holds outgoing-32695 and incoming-50918; META's events are outgoing-32450 and
    // incoming-50918, so one comes from the kept page and one stays a snippet.
    const { calls, env: e } = fakeFetch(() => PAGE);
    const out = json(await run("righttoknow_request", { request: REQ, max_chars: 20 }, e));
    expect(calls).toEqual([{ name: "fetch_url", url: REQ, format: "raw", cache_only: true }]);
    const [sent, response] = out.events;
    expect(sent).toMatchObject({ message: "outgoing-32450", more: "righttoknow_full_request" });
    expect(sent.snippet).toMatch(/^Under the Freedom of Information Act/);
    expect(response).toMatchObject({
      message: "incoming-50918",
      author: "Freedom of Information, Australian National University",
      text: "Dear S P,\n\nThis is a […]",
      truncated: true,
      length: 62,
      attachments: [{ name: "FOIs 202600332 Consultation.pdf" }],
    });
    expect(response.more).toBeUndefined();
    expect(out.full_text).toMatch(/1 newer message/);
  });

  it("picks messages by id, with or without their prefix", async () => {
    stubJson();
    const { env: e } = fakeFetch(() => PAGE);
    const out = json(await run("righttoknow_request", { request: REQ, ids: ["50918"] }, e));
    expect(out.events.map((ev: { message: string }) => ev.message)).toEqual(["incoming-50918"]);
    expect(out.events[0].truncated).toBeUndefined();
    const both = json(
      await run("righttoknow_request", { request: REQ, ids: ["outgoing-32450", "50918"] }, e),
    );
    expect(both.events).toHaveLength(2);
  });

  it("says snippets only when nothing is kept, without fetching the page", async () => {
    stubJson();
    const calls: Record<string, unknown>[] = [];
    const FETCH = {
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, ...args });
        return { content: [{ type: "text", text: `Not kept: ${args.url}` }], isError: true };
      },
    };
    const out = json(
      await run("righttoknow_request", { request: REQ }, { ...env, FETCH } as unknown as Env),
    );
    // The folded page only: an unfolded copy is never used in its place.
    expect(calls.map((c) => [c.url, c.cache_only])).toEqual([[REQ, true]]);
    expect(out.full_text).toMatch(/^No kept copy/);
    expect(out.events[1].more).toBe("righttoknow_full_request");
  });

  it("says when the site has no such request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const r = await run("righttoknow_request", { request: "no_such_request" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Not found on Right to Know");
  });
});

describe("the feeds", () => {
  it("are read as JSON, `since` keeping only newer events", async () => {
    const asked: string[] = [];
    stubJson(asked);
    const out = json(
      await run("righttoknow_search", {
        query: '"Royal Commission" requested_from:anu',
        since: "2026-11-27T10:00:00+11:00",
      }),
    );
    expect(asked).toEqual(["/feed/search/%22Royal%20Commission%22%20requested_from%3Aanu.json"]);
    expect(out.entries.map((e: { event_id: number }) => e.event_id)).toEqual([525741]);
  });

  it("read a request's feed at /request/<slug>/feed.json", async () => {
    const asked: string[] = [];
    stubJson(asked);
    await run("righttoknow_feed", { kind: "request", value: REQ });
    expect(asked).toEqual(["/request/internal_anu_correspondence_conc/feed.json"]);
  });
});

describe("righttoknow_full_request", () => {
  it("refuses without user_confirmed, saying why", async () => {
    const { calls, env: e } = fakeFetch(() => PAGE);
    const r = await run(
      "righttoknow_full_request",
      { request: "internal_anu_correspondence_conc" },
      e,
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Cloudflare challenge/);
    expect(calls).toHaveLength(0);
  });

  it("uses the kept page while it holds the newest message", async () => {
    stubJson();
    const { calls, env: e } = fakeFetch(() => PAGE);
    // META's newest message is incoming-50918, which PAGE has.
    const out = json(
      await run(
        "righttoknow_full_request",
        { request: "internal_anu_correspondence_conc", user_confirmed: true, max_chars: 0 },
        e,
      ),
    );
    expect(calls).toEqual([{ name: "fetch_url", url: REQ, format: "raw", force: false }]);
    expect(out.page).toBe("kept copy, current");
    expect(out.messages.map((m: { id: string }) => m.id)).toEqual([
      "outgoing-32695",
      "incoming-50918",
    ]);
  });

  it("returns only the messages asked for, cut at 15,000 characters by default", async () => {
    stubJson();
    const long = "x".repeat(16_000);
    const page = PAGE.replace("This is a notice under section 24AB of the FOI Act.", long);
    const { env: e } = fakeFetch(() => page);
    const out = json(
      await run(
        "righttoknow_full_request",
        { request: REQ, user_confirmed: true, ids: ["incoming-50918"] },
        e,
      ),
    );
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({ id: "incoming-50918", truncated: true });
    expect(out.messages[0].text).toHaveLength(15_000 + " […]".length);
    expect(out.messages[0].length).toBeGreaterThan(16_000);
  });

  it("loads the page again once the request has a message the kept copy lacks", async () => {
    stubJson();
    const fresh = PAGE.replace('id="incoming-50918"', 'id="incoming-50918"');
    const stale = PAGE.replace(/<div class="incoming[\s\S]*$/, "");
    const { calls, env: e } = fakeFetch((a) => (a.force ? fresh : stale));
    const out = json(
      await run(
        "righttoknow_full_request",
        { request: "internal_anu_correspondence_conc", user_confirmed: true },
        e,
      ),
    );
    expect(calls.map((c) => c.force)).toEqual([false, true]);
    expect(out.page).toBe("loaded from Right to Know");
    expect(out.messages).toHaveLength(2);
  });
});

describe("righttoknow_full_attachment", () => {
  it("keeps one copy per document, whichever of its URLs is passed", async () => {
    const { calls, env: e } = fakeFetch(() => "# Decision");
    const out = json(
      await run(
        "righttoknow_full_attachment",
        {
          url: `${REQ}/response/50918/attach/html/2/FOIs%20202600332%20Consultation.pdf.html`,
          user_confirmed: true,
        },
        e,
      ),
    );
    expect(calls).toEqual([
      {
        name: "fetch_url",
        url: `${REQ}/response/50918/attach/2/FOIs%20202600332%20Consultation.pdf`,
        format: "markdown",
        force: false,
      },
    ]);
    expect(out.text).toBe("# Decision");
  });
});

// The header and quoting are PublicBodyCSV's own (mysociety/alaveteli, lib/public_body_csv.rb).
const CSV = [
  "Internal ID,Name,Short name,URL name,Tags,Home page,Publication scheme,Disclosure log,Notes,Created at,Updated at,Version",
  '723,Australian National University,ANU,anu,wikidata:Q127990 federal foi_yes university,http://www.anu.edu.au/,,https://www.anu.edu.au/freedom-of-information/disclosure-log,"The ANU is ""unique"", it says.\nSecond line.",2012-10-15 08:40:52 UTC,2026-11-26 17:55:09 UTC,9',
  "913,Office of the Australian Information Commissioner,OAIC,oaic,federal foi_yes attorney_general,http://www.oaic.gov.au,,,,2012-10-15,2026-11-09,4",
  "1200,Department of Home Affairs,,home_affairs,federal foi_yes,https://www.homeaffairs.gov.au,,,,2017-12-20,2026-11-01,7",
  "5000,University of Melbourne,UniMelb,unimelb,vic foi_yes university,https://www.unimelb.edu.au,,,,2013-01-01,2026-10-01,3",
  "",
].join("\r\n");

describe("the authorities list", () => {
  it("parses quoted fields holding commas, doubled quotes and line breaks", () => {
    const rows = parseCsv(CSV);
    expect(rows).toHaveLength(5);
    expect(rows[1]![8]).toBe('The ANU is "unique", it says.\nSecond line.');
  });

  it("reads each authority by column name, tags split into flags and values", () => {
    const [anu] = parseAuthorities(CSV);
    expect(anu).toMatchObject({
      slug: "anu",
      short_name: "ANU",
      tags: { wikidata: "Q127990", federal: true, foi_yes: true, university: true },
    });
    expect(anu!.publication_scheme).toBeUndefined();
  });

  it("finds by every word and every tag, closer matches first", () => {
    const all = parseAuthorities(CSV);
    // A name starting with the query outranks one merely containing it.
    expect(findAuthorities(all, "university").map((a) => a.slug)).toEqual(["unimelb", "anu"]);
    expect(findAuthorities(all, "anu").map((a) => a.slug)).toEqual(["anu"]);
    expect(findAuthorities(all, "", ["university", "vic"]).map((a) => a.slug)).toEqual(["unimelb"]);
    expect(tagCounts(all)).toMatchObject({ federal: 3, foi_yes: 4, university: 2, vic: 1 });
  });

  it("is kept by mcp-fetch for a week, and parsed once per isolate", async () => {
    const { calls, env: e } = fakeFetch(() => CSV);
    expect(json(await run("righttoknow_authorities", { refresh: true }, e))).toMatchObject({
      total: 4,
      tags: { foi_yes: 4 },
    });
    expect(calls).toEqual([
      {
        name: "fetch_url",
        url: "https://www.righttoknow.org.au/body/all-authorities.csv",
        format: "raw",
        max_age: 604800,
        force: true,
      },
    ]);
    const found = json(await run("righttoknow_authorities", { query: "ANU" }, e));
    expect(found).toMatchObject({ matched: 1, authorities: [{ slug: "anu" }] });
    expect(found.authorities[0].notes).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("righttoknow_link", () => {
  const link = async (args: object) => json(await run("righttoknow_link", args)).url as string;

  it("pre-fills a new request the way the site's API page describes", async () => {
    expect(
      await link({
        action: "new_request",
        authority: "https://www.righttoknow.org.au/body/defence",
        title: "Test Request",
        default_letter: "Test request body",
        tags: "openlylocal spending_id:12345",
      }),
    ).toBe(
      "https://www.righttoknow.org.au/new/defence?title=Test+Request&default_letter=Test+request+body&tags=openlylocal+spending_id%3A12345",
    );
    const r = await run("righttoknow_link", {
      action: "new_request",
      authority: "defence",
      default_letter: "a",
      body: "b",
    });
    expect(r.isError).toBe(true);
  });

  it("builds the forms on a request, and alerts on anything", async () => {
    const slug = "internal_anu_correspondence_conc";
    expect(await link({ action: "reply", request: REQ, incoming_message_id: 51880 })).toBe(
      `${REQ}/followups/new/51880`,
    );
    expect(await link({ action: "internal_review", request: slug })).toBe(
      `${REQ}/followups/new?internal_review=1`,
    );
    expect(await link({ action: "download_zip", request: slug })).toBe(`${REQ}/download`);
    expect(await link({ action: "track", request: slug })).toBe(`${REQ}/track`);
    expect(await link({ action: "track", query: "requested_from:anu" })).toBe(
      "https://www.righttoknow.org.au/track/search/requested_from%3Aanu",
    );
    expect(await link({ action: "change_request", authority: "anu" })).toBe(
      "https://www.righttoknow.org.au/change_request/new/anu",
    );
    expect((await run("righttoknow_link", { action: "annotate" })).isError).toBe(true);
  });

  it("fetches nothing", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await link({ action: "contact" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("righttoknow_site and righttoknow_citations", () => {
  it("rank authorities by slug from the statistics JSON, totals from /version.json", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      if (path === "/version.json")
        return Response.json({
          alaveteli_version: "0.46.8.0",
          ruby_version: "3.4.10",
          alaveteli_git_commit: "be36b67",
          visible_request_count: 14567,
        });
      expect(path).toBe("/statistics.json");
      return Response.json({
        public_bodies: [
          {
            id: "info_requests_successful_count-highest",
            title: "Public bodies with the most successful requests",
            y_axis: "Percentage of total requests",
            y_values: [62.06896551724138],
            totals: [29],
            public_bodies: [
              {
                name: "National Indigenous Australians Agency",
                url: "https://www.righttoknow.org.au/body/niaa",
              },
            ],
          },
        ],
        users: {
          last_28_day_requesters: [{ user: { url_name: "tyler_2", name: "Tyler" }, count: 9 }],
        },
        requests: { hides_by_week: [] },
      });
    });
    const out = json(await run("righttoknow_site", {}));
    expect(out.totals).toEqual({ alaveteli_version: "0.46.8.0", visible_request_count: 14567 });
    expect(out.authorities[0].ranking).toEqual([
      { slug: "niaa", name: "National Indigenous Australians Agency", value: 62.1, requests: 29 },
    ]);
    expect(out.users.last_28_day_requesters).toEqual([
      { slug: "tyler_2", name: "Tyler", count: 9 },
    ]);
  });

  it("lists citations with the request each one cites", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input instanceof Request ? input.url : input)).toBe(
        "https://www.righttoknow.org.au/citations.json?page=2",
      );
      return Response.json([
        {
          id: 32,
          source_url: "https://www.smh.com.au/national/x.html",
          type: "journalism",
          created_at: "2026-05-11T13:31:27.772+10:00",
          title: null,
          description: null,
          citable_path: "/request/documents_relating_to_mr2600103",
        },
      ]);
    });
    const out = json(await run("righttoknow_citations", { page: 2 }));
    expect(out.citations[0]).toEqual({
      source_url: "https://www.smh.com.au/national/x.html",
      type: "journalism",
      at: "2026-05-11T13:31:27.772+10:00",
      cites: "https://www.righttoknow.org.au/request/documents_relating_to_mr2600103",
    });
  });

  it("read the site-wide list feeds", async () => {
    const asked: string[] = [];
    stubJson(asked);
    await run("righttoknow_feed", { kind: "list", value: "successful" });
    expect(asked).toEqual(["/feed/list/successful.json"]);
  });
});
