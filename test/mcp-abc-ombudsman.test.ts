/**
 * mcp-abc-ombudsman. abc.net.au is not called; what matters here is the category filter, the
 * mapping from a CMS card to a finding, and the tool list.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import Worker from "../workers/mcp-abc-ombudsman/src/index";
import { asFinding, categoriesMatching } from "../workers/mcp-abc-ombudsman/src/ombudsman";

type Spec = { name: string; annotations: Record<string, boolean> };

const tools = () => new Worker(createExecutionContext(), env).tools({}) as Promise<Spec[]>;

describe("the tool list", () => {
  it("carries the worker's prefix and reads only", async () => {
    const specs = await tools();
    expect(specs.map((t) => t.name)).toEqual([
      "abc_ombudsman_list_categories",
      "abc_ombudsman_list_years",
      "abc_ombudsman_list_complaints",
      "abc_ombudsman_search_all",
      "abc_ombudsman_dump_all",
    ]);
    expect(specs.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });
});

describe("the category filter", () => {
  it("matches on part of a title", () => {
    expect(categoriesMatching("breach").map((c) => c.title)).toEqual([
      "Noteworthy No Breach Findings",
      "Breach Findings",
    ]);
    expect(categoriesMatching("No Breach").map((c) => c.title)).toEqual([
      "Noteworthy No Breach Findings",
    ]);
  });

  it("matches on an exact ID", () => {
    expect(categoriesMatching("103532876").map((c) => c.title)).toEqual(["Breach Findings"]);
  });

  it("means everything when absent, and nothing when it matches nothing", () => {
    expect(categoriesMatching()).toHaveLength(5);
    expect(categoriesMatching("nonsense")).toHaveLength(0);
  });
});

describe("reading a CMS card", () => {
  it("prefers the card fields, falling back to the plain ones", () => {
    expect(
      asFinding(
        {
          cardTitle: "Card title",
          title: "Plain title",
          description: "What happened",
          articleLink: "https://www.abc.net.au/x",
          cardAttributionPrepared: { publishedDate: "2025-03-01" },
          cardId: "42",
        },
        "Breach Findings",
      ),
    ).toEqual({
      category: "Breach Findings",
      title: "Card title",
      description: "What happened",
      url: "https://www.abc.net.au/x",
      date: "2025-03-01",
      id: "42",
    });
  });

  it("fills every field even when the card is nearly empty", () => {
    expect(asFinding({}, "Action Taken")).toEqual({
      category: "Action Taken",
      title: "",
      description: "",
      url: "",
      date: "",
      id: "",
    });
  });
});
