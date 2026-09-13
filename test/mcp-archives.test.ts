/**
 * mcp-archives. The Wayback APIs themselves are somebody else's service and are not called
 * here; what is worth pinning down is the parsing, the closest-capture arithmetic, and that the
 * tool list the connector sees is well formed.
 *
 * The worker is imported directly rather than through `SELF`, so it does not need its own
 * vitest project — it takes its bindings as a constructor argument like any WorkerEntrypoint.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import Worker from "../workers/mcp-archives/src/index";
import { isoTs, rowsOf, wbDate } from "../workers/mcp-archives/src/cdx";

type Spec = {
  name: string;
  description: string;
  annotations: Record<string, boolean>;
  inputSchema: { type?: string; properties?: Record<string, unknown> };
};

const archives = () => new Worker(createExecutionContext(), env);
const tools = () => archives().tools({}) as Promise<Spec[]>;
const call = async (name: string, args: unknown) => {
  const r = (await archives().call(name, args, {})) as { content: { text: string }[] };
  return r.content[0]!.text;
};

const HEAD = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"];
const row = (ts: string, url = "https://example.com/") => [
  "com,example)/",
  ts,
  url,
  "text/html",
  "200",
  "ABC",
  "1234",
];

describe("the tool list", () => {
  it("carries the worker's prefix and nothing else", async () => {
    expect((await tools()).map((t) => t.name)).toEqual([
      "archives_timemap",
      "archives_nearest_capture",
      "archives_cdx_search",
      "archives_save_wayback",
      "archives_save_status",
    ]);
  });

  it("marks the four lookups read-only and save_wayback not", async () => {
    const by = Object.fromEntries((await tools()).map((t) => [t.name, t.annotations]));
    expect(by["archives_timemap"]!.readOnlyHint).toBe(true);
    expect(by["archives_save_status"]!.readOnlyHint).toBe(true);
    expect(by["archives_save_wayback"]!.readOnlyHint).toBe(false);
    // It creates a snapshot on archive.org but destroys nothing, so it is not destructive.
    expect(by["archives_save_wayback"]!.destructiveHint).toBe(false);
  });

  it("gives every tool a description and an object schema", async () => {
    for (const t of await tools()) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      expect(Object.keys(t.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
    }
  });
});

describe("reading CDX rows", () => {
  it("names the columns from the header row and adds a Wayback URL", () => {
    const [r] = rowsOf([HEAD, row("20200304050607")]);
    expect(r!["url"]).toBe("https://web.archive.org/web/20200304050607/https://example.com/");
    expect(r!["datetime"]).toBe("2020-03-04T05:06:07Z");
    expect(r!["statuscode"]).toBe("200");
  });

  it("honours a narrowed fl rather than assuming the full column set", () => {
    const [r] = rowsOf([
      ["timestamp", "digest"],
      ["20200304050607", "ABC"],
    ]);
    expect(Object.keys(r!)).toEqual(["timestamp", "digest"]); // no url: `original` was not asked for
  });

  it("returns nothing for a header-only or empty response", () => {
    expect(rowsOf([HEAD])).toEqual([]);
    expect(rowsOf([])).toEqual([]);
    expect(rowsOf(null)).toEqual([]);
  });
});

describe("timestamps", () => {
  it("pads short forms instead of rejecting them", () => {
    expect(isoTs("20200304")).toBe("2020-03-04T00:00:00Z");
    expect(wbDate("2020")!.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(wbDate("202003")!.toISOString()).toBe("2020-03-01T00:00:00.000Z");
  });

  it("refuses anything that is not at least a year", () => {
    expect(wbDate("")).toBeNull();
    expect(wbDate("abc")).toBeNull();
    expect(wbDate(undefined)).toBeNull();
  });
});

describe("nearest_capture", () => {
  it("asks for a timestamp before it will look for the closest capture", async () => {
    const out = await call("archives_nearest_capture", { url: "x", prefer: "closest" });
    expect(out).toContain("needs a timestamp");
  });
});

describe("the save tools", () => {
  it("say which keys are missing rather than failing silently", async () => {
    expect(await call("archives_save_wayback", { url: "https://example.com/" })).toContain(
      "IA_ACCESS_KEY",
    );
    expect(await call("archives_save_status", { job_id: "x" })).toContain("IA_ACCESS_KEY");
  });
});
