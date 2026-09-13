/**
 * mcp-abc-search. Algolia itself is not called; the parts worth pinning down are the filter
 * expression the date arguments build, how a hit is rendered, and the tool list.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import Worker from "../workers/mcp-abc-search/src/index";
import { filtersFor, formatHit, formatResults } from "../workers/mcp-abc-search/src/abc";

type Spec = { name: string; description: string; annotations: Record<string, boolean> };

const tools = () => new Worker(createExecutionContext(), env).tools({}) as Promise<Spec[]>;

const HIT = {
  title: "Media Watch on the Bondi coverage",
  canonicalURL: "https://www.abc.net.au/mediawatch/1",
  dates: { displayPublished: "2025-12-15T21:00:00Z" },
  docType: "VideoSegment",
  site: { title: "Media Watch" },
  synopsis: "What the front pages did next.",
  transcript: "one two three four five",
};

describe("the tool list", () => {
  it("carries the worker's prefix and reads only", async () => {
    const specs = await tools();
    expect(specs.map((t) => t.name)).toEqual([
      "abc_search_mediawatch",
      "abc_search_all",
      "abc_search_discover_facets",
      "abc_search_discover_schema",
    ]);
    expect(specs.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });
});

describe("date filters", () => {
  it("turn dates into the unix bounds Algolia indexes", () => {
    expect(filtersFor(undefined, "2023-10-07", "2024-12-31")).toBe(
      "unixDates.displayPublished >= 1696636800 AND unixDates.displayPublished <= 1735689599",
    );
  });

  it("keep the caller's own expression alongside", () => {
    expect(filtersFor("docType:Article", "2023-10-07", undefined)).toBe(
      "unixDates.displayPublished >= 1696636800 AND docType:Article",
    );
  });

  it("come back undefined when there is nothing to filter on", () => {
    expect(filtersFor()).toBeUndefined();
    expect(filtersFor(undefined, "not-a-date")).toBeUndefined();
  });
});

describe("rendering a hit", () => {
  it("shows the metadata a reader needs to follow it up", () => {
    const out = formatHit(HIT, 1, false);
    expect(out).toContain("[1] Media Watch on the Bondi coverage");
    expect(out).toContain("URL: https://www.abc.net.au/mediawatch/1");
    expect(out).toContain("Date: 2025-12-15");
    expect(out).toContain("Site: Media Watch");
  });

  it("says a transcript exists rather than dumping it unasked", () => {
    expect(formatHit(HIT, 1, false)).toContain("Transcript available (23 chars, ~5 words)");
    expect(formatHit(HIT, 1, true)).toContain("one two three four five");
  });

  it("reads a unix date in either seconds or milliseconds", () => {
    expect(formatHit({ dates: { displayPublished: 1696636800 } }, 1, false)).toContain(
      "Date: 2023-10-07",
    );
    expect(formatHit({ dates: { displayPublished: 1696636800000 } }, 1, false)).toContain(
      "Date: 2023-10-07",
    );
  });
});

describe("rendering a page of results", () => {
  it("numbers hits from the page offset, not from one", () => {
    const page = { hits: [HIT], nbHits: 41, nbPages: 3, page: 1, hitsPerPage: 20 };
    const out = formatResults(page, false);
    expect(out).toContain("Found 41 results (page 2 of 3)");
    expect(out).toContain("[21] Media Watch");
    expect(out).toContain("More results available");
  });

  it("says so plainly when nothing matched", () => {
    expect(formatResults({ hits: [], nbHits: 0, nbPages: 0 }, false)).toContain(
      "No matching articles found.",
    );
  });
});
