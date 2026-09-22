/**
 * Routing to a bound worker that renames its own tools.
 *
 * An aggregator derives a bound worker's prefix from its service name, but a worker can set
 * `prefix` and call its tools whatever it likes. When those two disagree the specs still come
 * back verbatim — so the tools are LISTED — while every call is routed by the derived prefix,
 * matches no remote, and returns `Unknown tool`. Listed and uncallable is worse than absent:
 * the client shows the tool, the user picks it, and the server denies it exists.
 *
 * Declaring `prefix` on the service entry is what closes that gap.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mcpWorker, tool } from "../core/mcp";

type Spec = { name: string };
type Result = { content: { text: string }[]; isError?: boolean };

/** A worker whose service name and tool prefix deliberately disagree. */
const Renamed = mcpWorker({
  name: "parent-renamed",
  prefix: "short_",
  tools: { ping: tool({ description: "ping", run: () => "pong" }) },
});

const ctx = () => createExecutionContext();
const bound = () => ({ RENAMED: new (Renamed as any)(ctx(), env) });

const parent = (service: { binding: string; service: string; prefix?: string }) =>
  new (mcpWorker({
    name: "mcp-parent",
    services: [service],
    tools: {},
  }) as any)(ctx(), bound());

const ENTRY = { binding: "RENAMED", service: "parent-renamed" };

describe("a bound worker that sets its own prefix", () => {
  it("names its tools by that prefix, not by its service name", async () => {
    const specs = (await parent(ENTRY).tools({})) as Spec[];
    expect(specs.map((s) => s.name)).toEqual(["short_ping"]);
  });

  it("is unreachable when the parent has to guess", async () => {
    // The bug, pinned: listed above, denied here.
    const out = (await parent(ENTRY).call("short_ping", {}, {})) as Result;
    expect(out.content[0]!.text).toContain("Unknown tool");
  });

  it("is reachable once the parent is told the prefix", async () => {
    const out = (await parent({ ...ENTRY, prefix: "short_" }).call("short_ping", {}, {})) as Result;
    expect(out.isError).toBeFalsy();
    expect(out.content[0]!.text).toContain("pong");
  });
});

describe("a bound worker that does not rename anything", () => {
  it("still routes from the service name alone, so nothing else has to change", async () => {
    const Plain = mcpWorker({
      name: "mcp-plain",
      tools: { ping: tool({ description: "ping", run: () => "pong" }) },
    });
    const up = new (mcpWorker({
      name: "mcp-parent",
      services: [{ binding: "PLAIN", service: "mcp-plain" }],
      tools: {},
    }) as any)(ctx(), { PLAIN: new (Plain as any)(ctx(), env) });

    expect(((await up.tools({})) as Spec[]).map((s) => s.name)).toEqual(["plain_ping"]);
    expect(((await up.call("plain_ping", {}, {})) as Result).content[0]!.text).toContain("pong");
  });
});
