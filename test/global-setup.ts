/**
 * Starts the mock WordPress once for the whole run. It has to live in Node rather than inside
 * the worker sandbox, so the port is handed to the tests through vitest's provide/inject.
 */
import { spawn } from "node:child_process";
import type { TestProject } from "vitest/node";

const PORT = 8799;

export default async function setup(project: TestProject) {
  const child = spawn("node", ["scripts/mock-wp.mjs", String(PORT)], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    const up = await fetch(`http://localhost:${PORT}/wp-json/`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  project.provide("mockBase", `http://localhost:${PORT}`);
  return () => child.kill();
}

declare module "vitest" {
  interface ProvidedContext {
    mockBase: string;
  }
}
