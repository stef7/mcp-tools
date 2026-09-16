/**
 * Starts the mock services once for the whole run. They have to live in Node rather than inside
 * the worker sandbox, so their ports are handed to the tests through vitest's provide/inject.
 */
import { spawn } from "node:child_process";
import type { TestProject } from "vitest/node";

const MOCKS = [
  { name: "wp", script: "scripts/mock-wp.mjs", port: 8799, ready: "/wp-json/" },
  {
    name: "ghost",
    script: "scripts/mock-ghost.mjs",
    port: 8798,
    ready: "/members/api/integrity-token/",
  },
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

export default async function setup(project: TestProject) {
  const children = MOCKS.map((m) => spawn("node", [m.script, String(m.port)], { stdio: "ignore" }));
  for (const m of MOCKS) await waitFor(`http://localhost:${m.port}${m.ready}`);
  project.provide("mockBase", `http://localhost:${MOCKS[0].port}`);
  project.provide("ghostBase", `http://localhost:${MOCKS[1].port}`);
  return () => children.forEach((c) => c.kill());
}

declare module "vitest" {
  interface ProvidedContext {
    mockBase: string;
    ghostBase: string;
  }
}
