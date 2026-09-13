/**
 * mcp-un-docs. UNISPAL, the Digital Library, ODS and RightDocs are all live third-party
 * services, so what is tested here is the parsing either side of them and the tool list.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import Worker from "../workers/mcp-un-docs/src/index";
import { symbolFromFile, symbolIn, toMarkdown } from "../workers/mcp-un-docs/src/backends";

type Spec = { name: string; description: string; inputSchema: { properties?: object } };

const tools = () => new Worker(createExecutionContext(), env).tools({}) as Promise<Spec[]>;

describe("the tool list", () => {
  it("carries the worker's prefix", async () => {
    expect((await tools()).map((t) => t.name)).toEqual([
      "un_docs_unispal_search",
      "un_docs_unispal_document",
      "un_docs_unispal_terms",
      "un_docs_undl_search",
      "un_docs_undocs_resolve",
      "un_docs_rightdocs_search",
    ]);
  });

  it("is entirely read-only, so nothing asks for confirmation", async () => {
    const specs = (await tools()) as unknown as { annotations: Record<string, boolean> }[];
    expect(specs.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it("gives every tool a description and some arguments", async () => {
    for (const t of await tools()) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(Object.keys(t.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
    }
  });
});

describe("document symbols", () => {
  it("finds one in a title", () => {
    expect(symbolIn("Report of the Special Rapporteur (A/HRC/60/CRP.3)")).toBe("A/HRC/60/CRP.3");
    expect(symbolIn("Resolution S/RES/2334 (2016)")).toBe("S/RES/2334");
    expect(symbolIn("Views adopted CCPR/C/130/D/2728/2016")).toBe("CCPR/C/130/D/2728/2016");
  });

  it("returns nothing when there is none", () => {
    expect(symbolIn("A statement on the situation in Gaza")).toBeUndefined();
    expect(symbolIn()).toBeUndefined();
  });

  it("reads one back out of a Digital Library filename", () => {
    expect(symbolFromFile("A_HRC_55_73-EN.pdf")).toBe("A/HRC/55/73");
    expect(symbolFromFile("A_80_492-EN")).toBe("A/80/492");
  });
});

describe("HTML to text", () => {
  it("keeps link targets and list bullets", () => {
    const out = toMarkdown('<p>See <a href="https://un.org/x">the report</a>.</p><li>One</li>');
    expect(out).toContain("[the report](https://un.org/x)");
    expect(out).toContain("• One");
  });

  it("decodes the entities WordPress emits", () => {
    expect(toMarkdown("Israel&#8217;s obligations &amp; the Court&#8230;")).toBe(
      "Israel’s obligations & the Court…",
    );
  });

  it("drops scripts entirely rather than leaving their source", () => {
    expect(toMarkdown("<script>alert(1)</script><p>Text</p>")).toBe("Text");
  });
});
