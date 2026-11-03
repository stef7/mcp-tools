/** core/web: the helpers every worker that reads the open web shares. */
import { describe, expect, it } from "vitest";
import { fragmentSelector, selectHtml, withBase } from "../core/web";

describe("withBase", () => {
  const url = "https://example.org/a/b/page";

  it("puts the page's own URL first thing in its head", () => {
    expect(withBase('<html><head lang="en"><title>T</title></head></html>', url)).toBe(
      `<html><head lang="en"><base href="${url}"><title>T</title></head></html>`,
    );
  });

  it("does not mistake a <header> for the head", () => {
    expect(withBase("<body><header>Banner</header></body>", url)).toBe(
      `<base href="${url}"><body><header>Banner</header></body>`,
    );
  });

  it("leaves a page that names its own base alone", () => {
    const html = '<head><base href="https://cdn.example.org/"></head>';
    expect(withBase(html, url)).toBe(html);
  });

  it("escapes the URL for an attribute", () => {
    expect(withBase("<p>x</p>", 'https://example.org/?a=1&b="2"')).toBe(
      '<base href="https://example.org/?a=1&amp;b=&quot;2&quot;"><p>x</p>',
    );
  });
});

describe("selectHtml", () => {
  const page =
    '<html><head><title>T</title></head><body><div id="nav">menu</div>' +
    '<div class="msg" id="incoming-51471"><p>Dear <b>council</b>,</p><div>inner</div></div>' +
    '<div class="msg" id="outgoing-2"><p>Reply</p><hr></div></body></html>';

  it("returns the element an id selects, exactly as sent", async () => {
    expect(await selectHtml(page, '[id="incoming-51471"]')).toEqual([
      '<div class="msg" id="incoming-51471"><p>Dear <b>council</b>,</p><div>inner</div></div>',
    ]);
  });

  it("returns every match in order, and a nested match only once", async () => {
    expect(await selectHtml(page, "div.msg")).toEqual([
      '<div class="msg" id="incoming-51471"><p>Dear <b>council</b>,</p><div>inner</div></div>',
      '<div class="msg" id="outgoing-2"><p>Reply</p><hr></div>',
    ]);
    expect(await selectHtml(page, ".msg, .msg div")).toHaveLength(2);
  });

  it("handles void elements", async () => {
    expect(await selectHtml(page, "hr")).toEqual(["<hr>"]);
  });

  it("returns nothing when nothing matches", async () => {
    expect(await selectHtml(page, "#missing")).toEqual([]);
  });

  it("runs an unclosed element to the end of the document", async () => {
    expect(await selectHtml("<p>a<section id=s>b<p>c", "#s")).toEqual(["<section id=s>b<p>c"]);
  });

  it("throws on a selector it cannot parse", async () => {
    await expect(selectHtml(page, "div[")).rejects.toThrow();
  });
});

describe("fragmentSelector", () => {
  it("selects the element the fragment names", () => {
    expect(
      fragmentSelector(
        "https://www.righttoknow.org.au/request/x?nocache=incoming-51471#incoming-51471",
      ),
    ).toBe('[id="incoming-51471"]');
  });

  it("copes with ids a #selector could not express", () => {
    expect(fragmentSelector("https://e.org/#1.2%20a%22b")).toBe('[id="1.2 a\\"b"]');
  });

  it("is null without a fragment", () => {
    expect(fragmentSelector("https://e.org/page")).toBeNull();
    expect(fragmentSelector("https://e.org/page#")).toBeNull();
  });
});
