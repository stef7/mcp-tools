/**
 * mcp-toolkit. The worker is constructed with bindings that hold none of its bound services, so
 * every remote fails here — which is exactly the case worth testing: the toolkit's own tools
 * must survive it, and it must say what it could not reach.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import Worker from "../workers/mcp-toolkit/src/index";

type Spec = { name: string; annotations: Record<string, boolean> };

const toolkit = () => new Worker(createExecutionContext(), env);
const tools = (search = "") => toolkit().tools({ search }) as Promise<Spec[]>;

describe("its own tools", () => {
  it("carry no prefix, because they are not a toolkit of anything", async () => {
    expect((await tools()).map((t) => t.name)).toEqual([
      "acast_episodes",
      "substack_search",
      "substack_latest",
    ]);
  });

  it("are still narrowed by ?tools=", async () => {
    expect((await tools("?tools=substack")).map((t) => t.name)).toEqual([
      "substack_search",
      "substack_latest",
    ]);
    expect((await tools("?tools=acast_episodes")).map((t) => t.name)).toEqual(["acast_episodes"]);
  });

  it("read only", async () => {
    expect((await tools()).every((t) => t.annotations.readOnlyHint)).toBe(true);
  });
});

describe("a bound worker it cannot reach", () => {
  it("costs that worker's tools and nothing else", async () => {
    expect((await tools()).length).toBe(3); // ten services are bound, none of them resolvable
  });

  it("is named on the GET page rather than failing the whole request", async () => {
    const res = await toolkit().fetch(new Request("https://toolkit.test/"));
    const body = (await res.json()) as { tools: string[]; unreachable?: string[] };
    expect(res.status).toBe(200);
    expect(body.tools).toContain("acast_episodes");
    // Order follows prefix length, which is only there to make routing unambiguous.
    expect(body.unreachable?.map((u) => u.split(":")[0]).sort()).toEqual([
      "abc_ombudsman",
      "abc_search",
      "apify",
      "archives",
      "data_gov_au",
      "fetch",
      "ghost",
      "un_docs",
      "wp",
    ]);
  });
});

describe("an unknown tool", () => {
  it("says so instead of being silently swallowed", async () => {
    const r = (await toolkit().call("nonsense_tool", {}, {})) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Unknown tool: nonsense_tool");
  });
});
