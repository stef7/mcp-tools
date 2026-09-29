/** core/web: the helpers every worker that reads the open web shares. */
import { describe, expect, it } from "vitest";
import { withBase } from "../core/web";

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
