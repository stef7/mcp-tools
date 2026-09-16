/**
 * Icons, and the protocol revision that decides whether a client ever looks for them. `icons`,
 * `websiteUrl` and a server `description` were added in 2025-11-25; this worker used to answer
 * every `initialize` with "2025-06-18", where none of those fields exist. Both halves are pinned
 * here because either one going quiet takes the icons with it, without failing anything else.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import Worker from "../workers/mcp-toolkit/src/index";
import { ICONS } from "../core/icons";

type Spec = { name: string; icons?: { src: string; mimeType?: string }[] };

const toolkit = () => new Worker(createExecutionContext(), env);
const init = async (protocolVersion?: string) => {
  const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } };
  const res = await toolkit().fetch(
    new Request("https://toolkit.test/", { method: "POST", body: JSON.stringify(body) }),
  );
  return (await res.json()) as {
    result: { protocolVersion: string; serverInfo: { icons?: unknown[] } };
  };
};

describe("agreeing a protocol revision", () => {
  it("answers with the revision the client asked for, when it is one we speak", async () => {
    expect((await init("2025-06-18")).result.protocolVersion).toBe("2025-06-18");
  });

  it("offers the newest we speak to a client asking for nothing, or for the unknown", async () => {
    expect((await init()).result.protocolVersion).toBe("2025-11-25");
    expect((await init("1999-01-01")).result.protocolVersion).toBe("2025-11-25");
  });

  it("carries the server's own icon", async () => {
    expect((await init()).result.serverInfo.icons).toEqual([ICONS.toolkit]);
  });
});

describe("a mark", () => {
  const marks = Object.values(ICONS);

  it("is inline, so no client has to get past Cloudflare Access to draw it", () => {
    expect(marks.every((i) => i.src.startsWith("data:image/svg+xml,"))).toBe(true);
  });

  it("is a type clients are asked to render — not the .ico a site would offer", () => {
    expect(marks.every((i) => i.mimeType === "image/svg+xml")).toBe(true);
  });

  it("draws something: every mark differs from every other", () => {
    expect(new Set(marks.map((i) => i.src)).size).toBe(marks.length);
  });
});

describe("every tool", () => {
  it("carries the icon of the worker it came from, with nothing mapping it back", async () => {
    const tools = (await toolkit().tools({})) as Spec[];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.icons?.[0]?.src === ICONS.toolkit.src)).toBe(true);
  });
});
