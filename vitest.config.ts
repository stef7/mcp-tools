import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    poolOptions: {
      workers: {
        main: "./workers/mcp-wp/src/index.ts",
        wrangler: { configPath: "./workers/mcp-wp/wrangler.json" },
        miniflare: {
          // Stands in for Cloudflare Access, which only exists once deployed. Without it the
          // worker sees nobody signed in and, by design, offers no write tools at all.
          dev: { access: { aud: "test", identity: { email: "me@example.com" } } },
          // mcp-ghost keeps member sessions here; mcp-wp does not use it.
          kvNamespaces: ["SESSIONS"],
          bindings: {
            WP_SITES: { "me@example.com": { localhost: { user: "wp-user", pass: "LOCAL_PASS" } } },
            LOCAL_PASS: "secretpass",
          },
        },
      },
    },
  },
});
