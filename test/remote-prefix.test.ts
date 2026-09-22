/**
 * Routing to a bound worker that renames its own tools.
 *
 * An aggregator derives a bound worker's prefix from its service name, but a worker can set
 * `prefix` and call its tools whatever it likes. When those two disagree the specs still come
 * back verbatim — so the tools are LISTED — while every call is routed by the derived prefix,
 * matches no remote, and returns `Unknown tool`. Listed and uncallable is worse than absent:
 * the client shows the tool, someone picks it, and the server denies it exists.
 *
 * Declaring `prefix` on the service entry is what closes that gap.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mcpWorker, tool } from "../core/mcp";

type Spec = { name: string };
type Result = { content: { text: string }[]; isError?: boolean };
type Entry = { binding: string; service: string; prefix?: string };

const ping = tool({ description: "ping", run: () => "pong" });
const ctx = () => createExecutionContext();
const spawn = (W: unknown, e: unknown) => new (W as new (c: unknown, e: unknown) => any)(ctx(), e);

/** A worker whose service name and tool prefix deliberately disagree. */
const Renamed = mcpWorker({ name: "parent-renamed", prefix: "short_", tools: { ping } });
const Plain = mcpWorker({ name: "mcp-plain", tools: { ping } });

const parent = (services: Entry[]) => mcpWorker({ name: "mcp-parent", services, tools: {} });
const RENAMED: Entry = { binding: "RENAMED", service: "parent-renamed" };

const bound = () => ({ RENAMED: spawn(Renamed, env) });
const guessing = () => spawn(parent([RENAMED]), bound());
const told = () => spawn(parent([{ ...RENAMED, prefix: "short_" }]), bound());

describe("a bound worker that sets its own prefix", () => {
  it("names its tools by that prefix, not by its service name", async () => {
    const specs = (await guessing().tools({})) as Spec[];
    expect(specs.map((s) => s.name)).toEqual(["short_ping"]);
  });

  it("is unreachable when the parent has to guess", async () => {
    // The bug, pinned: listed above, denied here.
    const out = (await guessing().call("short_ping", {}, {})) as Result;
    expect(out.content[0]!.text).toContain("Unknown tool");
  });

  it("is reachable once the parent is told the prefix", async () => {
    const out = (await told().call("short_ping", {}, {})) as Result;
    expect(out.isError).toBeFalsy();
    expect(out.content[0]!.text).toContain("pong");
  });
});

describe("a bound worker that renames nothing", () => {
  const PLAIN: Entry = { binding: "PLAIN", service: "mcp-plain" };
  const up = () => spawn(parent([PLAIN]), { PLAIN: spawn(Plain, env) });

  it("still routes from the service name alone, so nothing else has to change", async () => {
    const specs = (await up().tools({})) as Spec[];
    expect(specs.map((s) => s.name)).toEqual(["plain_ping"]);
    expect(((await up().call("plain_ping", {}, {})) as Result).content[0]!.text).toContain("pong");
  });
});
