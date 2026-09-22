/**
 * Routing to a bound worker whose service name does not tell you what its tools are called.
 *
 * An aggregator derives a bound worker's prefix from its service name, but a worker can set
 * `prefix` and call its tools whatever it likes — and a bound worker that is itself an
 * aggregator re-exports the prefixes of the workers bound to *it*, a set nothing upstream can
 * derive at all. Specs come back verbatim either way, so those tools are LISTED; routing by the
 * derived prefix alone then matches no remote and answers `Unknown tool`. Listed and uncallable
 * is worse than absent: the client shows the tool, someone picks it, and the server denies it
 * exists.
 *
 * So a name no prefix claims falls back to asking each bound worker which names it lists.
 * Declaring `prefix` on the service entry is then an optimisation rather than the only route —
 * it skips a lookup that costs every bound worker a tool list, which is not always cheap.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mcpWorker, tool } from "../core/mcp";

type Spec = { name: string };
type Result = { content: { text: string }[]; isError?: boolean };
type Entry = { binding: string; service: string; prefix?: string | string[] };

const ping = tool({ description: "ping", run: () => "pong" });
const ctx = () => createExecutionContext();
const spawn = (W: unknown, e: unknown) => new (W as new (c: unknown, e: unknown) => any)(ctx(), e);

/** A worker whose service name and tool prefix deliberately disagree. */
const Renamed = mcpWorker({ name: "parent-renamed", prefix: "short_", tools: { ping } });
const Plain = mcpWorker({ name: "mcp-plain", tools: { ping } });

const parent = (services: Entry[]) => mcpWorker({ name: "mcp-parent", services, tools: {} });
const RENAMED: Entry = { binding: "RENAMED", service: "parent-renamed" };

/** Counts the tool lists a parent asks for, which is exactly what declaring a prefix saves. */
const counting = (w: any) => {
  const seen = { lists: 0 };
  const rpc = {
    tools: (r: unknown) => (seen.lists++, w.tools(r)),
    call: (n: string, a: unknown, r: unknown) => w.call(n, a, r),
  };
  return [rpc, seen] as const;
};

describe("a bound worker that sets its own prefix", () => {
  it("names its tools by that prefix, not by its service name", async () => {
    const up = spawn(parent([RENAMED]), { RENAMED: spawn(Renamed, env) });
    expect(((await up.tools({})) as Spec[]).map((s) => s.name)).toEqual(["short_ping"]);
  });

  it("is still reached when the parent has to guess, by asking who lists the name", async () => {
    const [rpc, seen] = counting(spawn(Renamed, env));
    const out = (await spawn(parent([RENAMED]), { RENAMED: rpc }).call(
      "short_ping",
      {},
      {},
    )) as Result;
    expect(out.isError).toBeFalsy();
    expect(out.content[0]!.text).toContain("pong");
    expect(seen.lists).toBe(1); // the lookup the next test does without
  });

  it("is reached without that lookup once the parent is told the prefix", async () => {
    const [rpc, seen] = counting(spawn(Renamed, env));
    const told = parent([{ ...RENAMED, prefix: "short_" }]);
    const out = (await spawn(told, { RENAMED: rpc }).call("short_ping", {}, {})) as Result;
    expect(out.content[0]!.text).toContain("pong");
    expect(seen.lists).toBe(0);
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

/** The production shape: `gifthorse` is bound as one service and serves two prefixes. */
const Acnc = mcpWorker({ name: "acnc", tools: { search: ping } });
const Nested = mcpWorker({
  name: "gifthorse",
  services: [{ binding: "ACNC", service: "acnc" }],
  tools: { spend: ping },
});
const GIFTHORSE: Entry = { binding: "GIFTHORSE", service: "gifthorse" };
const nested = () => spawn(Nested, { ACNC: spawn(Acnc, env) });

describe("a bound worker that is itself an aggregator", () => {
  const up = () => spawn(parent([GIFTHORSE]), { GIFTHORSE: nested() });

  it("lists the tools it re-exports under a prefix of its own", async () => {
    expect(((await up().tools({})) as Spec[]).map((s) => s.name)).toEqual([
      "gifthorse_spend",
      "acnc_search",
    ]);
  });

  it("routes a call to its own prefix", async () => {
    expect(((await up().call("gifthorse_spend", {}, {})) as Result).content[0]!.text).toContain(
      "pong",
    );
  });

  it("routes a call to the prefix it re-exports", async () => {
    const out = (await up().call("acnc_search", {}, {})) as Result;
    expect(out.isError).toBeFalsy();
    expect(out.content[0]!.text).toContain("pong");
  });

  it("still narrows to the re-exported prefix with ?tools=", async () => {
    const specs = (await up().tools({ search: "?tools=acnc" })) as Spec[];
    expect(specs.map((s) => s.name)).toEqual(["acnc_search"]);
  });

  it("needs no lookup once both prefixes are declared", async () => {
    const [rpc, seen] = counting(nested());
    const told = parent([{ ...GIFTHORSE, prefix: ["gifthorse_", "acnc_"] }]);
    const out = (await spawn(told, { GIFTHORSE: rpc }).call("acnc_search", {}, {})) as Result;
    expect(out.content[0]!.text).toContain("pong");
    expect(seen.lists).toBe(0);
  });
});

describe("the lookup itself", () => {
  it("is not stopped by a bound worker that is down", async () => {
    const DOWN: Entry = { binding: "DOWN", service: "mcp-down" }; // no binding for it in env
    const up = spawn(parent([DOWN, RENAMED]), { RENAMED: spawn(Renamed, env) });
    expect(((await up.call("short_ping", {}, {})) as Result).content[0]!.text).toContain("pong");
  });

  it("gives up on a name nothing lists, rather than guessing a remote", async () => {
    const up = spawn(parent([RENAMED]), { RENAMED: spawn(Renamed, env) });
    const out = (await up.call("nope_ping", {}, {})) as Result;
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("Unknown tool: nope_ping");
  });
});
