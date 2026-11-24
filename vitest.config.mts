import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./workers/mcp-wp/src/index.ts",
      wrangler: { configPath: "./workers/mcp-wp/wrangler.json" },
      miniflare: {
        // Stands in for Cloudflare Access, which only exists once deployed. Without it the
        // worker sees nobody signed in and, by design, offers no write tools at all.
        dev: { access: { aud: "test", identity: { email: "me@example.com" } } },
        // mcp-ghost keeps member sessions here; mcp-wp does not use it.
        kvNamespaces: ["SESSIONS"],
        // mcp-mail's inbox, and the bucket its raw messages and attachments go to.
        d1Databases: ["MAIL_DB"],
        r2Buckets: ["MAIL_FILES"],
        bindings: {
          WP_SITES: { "me@example.com": { localhost: { user: "wp-user", pass: "LOCAL_PASS" } } },
          LOCAL_PASS: "secretpass",
          MAIL_READERS: "me@example.com",
          MAIL_ALLOWED_FROM: "me@proton.me, @proton.me",
        },
      },
    }),
  ],
  test: { globalSetup: ["./test/global-setup.ts"] },
});
