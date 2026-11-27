/**
 * mcp-righttoknow, against trimmed copies of what righttoknow.org.au really sent (27 Nov 2026).
 * The site is never called: `fetch` is stubbed per test.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import Worker from "../workers/mcp-righttoknow/src/index";
import {
  decode,
  htmlToText,
  parseCorrespondence,
  parseFeed,
  requestRef,
  slugOf,
} from "../workers/mcp-righttoknow/src/rtk";

type Spec = { name: string; annotations: Record<string, boolean> };
const worker = () => new Worker(createExecutionContext(), env);
const REQ = "https://www.righttoknow.org.au/request/internal_anu_correspondence_conc";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <id>tag:www.righttoknow.org.au,2005:InfoRequestEvent/525727</id>
      <published>2026-11-27T08:38:54+11:00</published>
      <link type="text/html" rel="alternate" href="https://www.righttoknow.org.au/request_event/525727"/>
      <title type="html">Development of the &quot;Building an understanding of antisemitism&quot; eLearn module</title>
      <content type="html">
&lt;div class=&quot;request_listing&quot;&gt;
  &lt;div class=&quot;request_left&quot;&gt;
    &lt;div class=&quot;requester&quot;&gt;
      Response by &lt;a href=&quot;https://www.righttoknow.org.au/body/home_affairs&quot;&gt;Department of Home Affairs&lt;/a&gt; to &lt;a href=&quot;https://www.righttoknow.org.au/user/mekomit_dotexe&quot;&gt;Mekomit Dotexe&lt;/a&gt; on &lt;time datetime=&quot;2026-11-27T08:38:54+11:00&quot;&gt;November 27, 2026&lt;/time&gt;.
    &lt;/div&gt;
    &lt;p&gt;
      &lt;i class=&quot;icon-standalone icon_waiting_classification&quot;&gt;&lt;/i&gt;
      &lt;strong&gt;
        Awaiting classification
      &lt;/strong&gt;
    &lt;/p&gt;
  &lt;/div&gt;
  &lt;div class=&quot;request_right&quot;&gt;
    &lt;span class=&quot;desc&quot;&gt;
      OFFICIAL: Sensitive

 FOI Request:&amp;nbsp;&amp;nbsp; FA 26/11/01978...
    &lt;/span&gt;
  &lt;/div&gt;
&lt;/div&gt;
</content>
    </entry>
    <entry>
      <id>tag:www.righttoknow.org.au,2005:InfoRequestEvent/525684</id>
      <published>2026-11-26T23:55:25+11:00</published>
      <link type="text/html" rel="alternate" href="https://www.righttoknow.org.au/request_event/525684"/>
      <title type="html">Development of the APS antisemitism foundation module</title>
      <content type="html">&lt;div class=&quot;requester&quot;&gt;
      Request sent to &lt;a href=&quot;https://www.righttoknow.org.au/body/dewr&quot;&gt;Department of Employment and Workplace Relations&lt;/a&gt; by &lt;a href=&quot;https://www.righttoknow.org.au/user/mekomit_dotexe&quot;&gt;Mekomit Dotexe&lt;/a&gt; on November 26, 2026.
    &lt;/div&gt;&lt;strong&gt;Delayed&lt;/strong&gt;</content>
    </entry>
</feed>`;

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
    },
    {
      id: 522775,
      event_type: "response",
      created_at: "2026-10-06T16:04:21.701+11:00",
      described_state: null,
      calculated_state: "waiting_response",
      incoming_message_id: 50918,
      outgoing_message_id: null,
    },
    {
      id: 523590,
      event_type: "overdue",
      created_at: "2026-10-09T00:00:00.000+11:00",
      described_state: null,
      calculated_state: null,
      incoming_message_id: null,
      outgoing_message_id: null,
    },
  ],
};

const urlOf = (input: RequestInfo | URL) =>
  new URL(String(input instanceof Request ? input.url : input));

describe("the tool list", () => {
  it("carries the worker's prefix and only reads", async () => {
    const specs = (await worker().tools({})) as Spec[];
    expect(specs.map((t) => t.name)).toEqual([
      "righttoknow_search",
      "righttoknow_request",
      "righttoknow_authority",
      "righttoknow_user",
      "righttoknow_feed",
      "righttoknow_attachment",
    ]);
    expect(specs.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });
});

describe("the search feed", () => {
  it("reads each event's request, authority, requester, status and snippet", () => {
    const [a, b] = parseFeed(FEED);
    expect(a).toMatchObject({
      event_id: 525727,
      published: "2026-11-27T08:38:54+11:00",
      title: 'Development of the "Building an understanding of antisemitism" eLearn module',
      event: "Response",
      status: "Awaiting classification",
      authority: "Department of Home Affairs",
      authority_slug: "home_affairs",
      requester: "Mekomit Dotexe",
      requester_slug: "mekomit_dotexe",
      url: "https://www.righttoknow.org.au/request_event/525727",
    });
    // Entities are escaped twice in the feed; both layers come off.
    expect(a!.snippet).toMatch(/FOI Request: FA 26\/11\/01978/);
    expect(b).toMatchObject({ event: "Request sent", authority_slug: "dewr", status: "Delayed" });
  });
});

describe("the request page", () => {
  it("reads every message, with its author, date, text and attachments", () => {
    const [out, inc, ...rest] = parseCorrespondence(PAGE, REQ);
    expect(rest).toHaveLength(0);
    expect(out).toMatchObject({
      id: "outgoing-32695",
      direction: "outgoing",
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
    expect(inc!.link).toBe(`${REQ}#incoming-50918`);
  });

  it("keeps one line break where the site writes a newline before <br />", () => {
    expect(htmlToText("<p>a\n<br />b</p>")).toBe("a\nb");
    expect(decode("&amp;nbsp; &#8220;x&#x201D;")).toBe("&nbsp; “x”");
  });
});

describe("references", () => {
  it("takes a slug, an id, or a request or event URL", () => {
    expect(requestRef("internal_anu_correspondence_conc")).toEqual({
      slug: "internal_anu_correspondence_conc",
    });
    expect(requestRef("15604")).toEqual({ redirect: "/request/15604" });
    expect(requestRef(`${REQ}#incoming-50918`)).toEqual({
      slug: "internal_anu_correspondence_conc",
    });
    expect(requestRef("https://www.righttoknow.org.au/request_event/525741")).toEqual({
      redirect: "/request_event/525741",
    });
    expect(() => requestRef("https://www.righttoknow.org.au/body/anu")).toThrow();
    expect(slugOf("https://www.righttoknow.org.au/body/home_affairs", "body")).toBe("home_affairs");
    expect(slugOf("oaic", "body")).toBe("oaic");
  });
});

describe("the request tool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("follows an event URL to the request, then joins the JSON and the page", async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      asked.push(url.pathname);
      if (url.pathname === "/request_event/522775")
        return new Response(null, { status: 302, headers: { location: `${REQ}#incoming-50918` } });
      if (url.pathname.endsWith(".json")) return Response.json(META);
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    });
    const res = (await worker().call("righttoknow_request", {
      request: "https://www.righttoknow.org.au/request_event/522775",
      messages: "latest",
      max_chars: 20,
    })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBeUndefined();
    const out = JSON.parse(res.content[0]!.text);
    expect(asked[0]).toBe("/request_event/522775");
    expect(out).toMatchObject({
      url: REQ,
      status: "waiting_response",
      authority: { slug: "anu", short_name: "ANU" },
      requester: { slug: "s_p" },
    });
    expect(out.events.map((e: { message?: string }) => e.message)).toEqual([
      "outgoing-32450",
      "incoming-50918",
      undefined,
    ]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({ id: "incoming-50918", truncated: true });
    expect(out.messages[0].text).toBe("Dear S P,\n\nThis is a […]");
  });

  it("says when the site has no such request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const res = (await worker().call("righttoknow_request", {
      request: "no_such_request",
      messages: "none",
    })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Not found on Right to Know");
  });
});

describe("the feed tool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps only events after `since`", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(urlOf(input).pathname).toBe("/feed/body/dewr");
      return new Response(FEED, { headers: { "content-type": "application/atom+xml" } });
    });
    const res = (await worker().call("righttoknow_feed", {
      kind: "body",
      value: "https://www.righttoknow.org.au/body/dewr",
      since: "2026-11-27T00:00:00+11:00",
    })) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text);
    expect(out.entries.map((e: { event_id: number }) => e.event_id)).toEqual([525727]);
  });
});
