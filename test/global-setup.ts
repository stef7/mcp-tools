/**
 * Starts the mock services once for the whole run. They have to live in Node rather than inside
 * the worker sandbox, so their ports are handed to the tests through vitest's provide/inject.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import type { TestProject } from "vitest/node";

const MOCKS = [
  { name: "wp", script: "scripts/mock-wp.mjs", port: 8799, ready: "/wp-json/" },
  {
    name: "ghost",
    script: "scripts/mock-ghost.mjs",
    port: 8798,
    ready: "/members/api/integrity-token/",
  },
  { name: "proxy", script: "scripts/mock-proxy.mjs", port: 8797, ready: null },
] as const;

const waitFor = async (url: string) => {
  for (let i = 0; i < 50; i++) {
    if (
      await fetch(url).then(
        (r) => r.ok,
        () => false,
      )
    )
      return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const waitForPort = async (port: number) => {
  for (let i = 0; i < 50; i++) {
    if (
      await fetch(`http://127.0.0.1:${port}/`).then(
        () => true,
        () => false,
      )
    )
      return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

export default async function setup(project: TestProject) {
  // The proxy accepts only the username production sends, so a passing test proves what that is.
  const args = { proxy: ["groups-UNBLOCKER:secret"] } as Record<string, string[]>;
  const children = MOCKS.map((m) =>
    spawn("node", [m.script, String(m.port), ...(args[m.name] ?? [])], { stdio: "ignore" }),
  );
  for (const m of MOCKS) {
    // The proxy answers every request, so any response at all means it is up.
    if (m.ready) await waitFor(`http://localhost:${m.port}${m.ready}`);
    else await waitForPort(m.port);
  }
  project.provide("mockBase", `http://localhost:${MOCKS[0].port}`);
  project.provide("ghostBase", `http://localhost:${MOCKS[1].port}`);
  project.provide("proxyPort", MOCKS[2].port);
  // The sandbox has no file system, so certificates come in as text.
  const fixtures = new URL("./fixtures/", import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, fixtures), "utf8");
  project.provide("mockCa", read("mock-ca.pem"));
  project.provide(
    "apifyLeaves",
    readdirSync(fixtures)
      .filter((f) => f.startsWith("apify-leaf-"))
      .map(read),
  );
  return () => children.forEach((c) => c.kill());
}

declare module "vitest" {
  interface ProvidedContext {
    mockBase: string;
    ghostBase: string;
    proxyPort: number;
    mockCa: string;
    apifyLeaves: string[];
  }
}
