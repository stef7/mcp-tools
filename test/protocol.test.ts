/**
 * The protocol revision `initialize` agrees. `websiteUrl` and a server `description` were added
 * in 2025-11-25; this worker used to answer every `initialize` with "2025-06-18", where neither
 * field exists, so a client had every reason to drop them.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import Worker from "../workers/mcp-toolkit/src/index";

const toolkit = () => new Worker(createExecutionContext(), env);
const init = async (protocolVersion?: string) => {
  const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } };
  const res = await toolkit().fetch(
    new Request("https://toolkit.test/", { method: "POST", body: JSON.stringify(body) }),
  );
  return (await res.json()) as { result: { protocolVersion: string } };
};

describe("agreeing a protocol revision", () => {
  it("answers with the revision the client asked for, when it is one we speak", async () => {
    expect((await init("2025-06-18")).result.protocolVersion).toBe("2025-06-18");
  });

  it("offers the newest we speak to a client asking for nothing, or for the unknown", async () => {
    expect((await init()).result.protocolVersion).toBe("2025-11-25");
    expect((await init("1999-01-01")).result.protocolVersion).toBe("2025-11-25");
  });
});
