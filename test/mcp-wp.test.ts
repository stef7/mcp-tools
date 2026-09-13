/**
 * mcp-wp against the mock WordPress in scripts/mock-wp.mjs.
 *
 * Tools are exercised through the worker's RPC surface, the same one mcp-toolkit calls, because
 * it takes the signed-in identity as an argument. The HTTP endpoint gets its own tests for the
 * protocol itself, where no identity is involved.
 */
import { SELF, createExecutionContext, env } from "cloudflare:test";
import { describe, expect, inject, it } from "vitest";
import Worker from "../workers/mcp-wp/src/index";

const base = inject("mockBase");
const ME = "me@example.com";
const site = (host = base) => `?wp=${encodeURIComponent(host)}`;

type Spec = {
  name: string;
  annotations: Record<string, boolean>;
  inputSchema: { required?: string[] };
};

const wp = () => new Worker(createExecutionContext(), env);
const tools = (search: string, email: string | undefined = ME): Promise<Spec[]> =>
  wp().tools({ search, email }) as Promise<Spec[]>;
const names = async (search: string, email?: string) =>
  (await tools(search, email)).map((t) => t.name);
const call = async (name: string, args: unknown, search: string, email = ME) => {
  const r = (await wp().call(name, args, { search, email })) as { content: { text: string }[] };
  return r.content[0]!.text;
};

describe("generic mode", () => {
  it("offers url-taking tools and no site-specific ones", async () => {
    expect(await names("")).toContain("wp_discover_site");
    expect(await names("")).not.toContain("wp_search_posts");
  });

  it("reports what a site actually has", async () => {
    const out = await call("wp_discover_site", { url: base }, "");
    expect(out).toContain("rest_base: `posts`");
    expect(out).toContain("The Events Calendar");
  });
});

describe("site mode", () => {
  it("generates a tool pair per post type the site has", async () => {
    const n = await names(site());
    expect(n).toContain("wp_search_posts");
    expect(n).toContain("wp_get_posts");
    expect(n).toContain("wp_list_terms");
  });

  it("groups tools so a client can separate reads from writes", async () => {
    const all = await tools(site());
    const read = all.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    const write = all.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
    expect(read).toContain("wp_search_posts");
    expect(write).toContain("wp_update_posts");
    expect(write.every((n) => /^wp_(create|update|delete)_/.test(n))).toBe(true);
  });

  it("marks creating as additive and deleting as destructive", async () => {
    const all = await tools(site());
    const hints = (n: string) => all.find((t) => t.name === n)!.annotations;
    expect(hints("wp_create_posts").destructiveHint).toBe(false);
    expect(hints("wp_delete_posts").destructiveHint).toBe(true);
  });

  it("hands The Events Calendar its own types rather than writing them through wp/v2", async () => {
    const n = await names(site());
    expect(n).toContain("wp_update_tribe_event");
    expect(n).not.toContain("wp_update_tribe_events");
    expect(n).toContain("wp_list_tribe_events_all");
  });

  it("reads through to the site", async () => {
    expect(await call("wp_search_posts", { query: "first" }, site())).toContain("First post");
  });
});

describe("writing", () => {
  it("refuses until the caller confirms", async () => {
    expect(await call("wp_update_posts", { id: 1, title: "No" }, site())).toContain(
      "user_confirmed",
    );
  });

  it("asks for confirmation in the schema too", async () => {
    const t = (await tools(site())).find((x) => x.name === "wp_update_posts")!;
    expect(t.inputSchema.required).toContain("user_confirmed");
  });

  it("writes once confirmed, carrying the login", async () => {
    const out = await call(
      "wp_update_posts",
      { id: 1, title: "Renamed", user_confirmed: true },
      site(),
    );
    expect(out).toContain("Updated Posts: Renamed");
  });

  it("creates a draft unless told otherwise", async () => {
    const out = await call("wp_create_posts", { title: "Fresh", user_confirmed: true }, site());
    expect(out).toContain("status: draft");
  });
});

describe("without a login", () => {
  // The same mock, reached by an address nobody is listed against in WP_SITES.
  const other = () => site(base.replace("localhost", "127.0.0.1"));

  it("offers no write tools at all", async () => {
    const n = await names(other());
    expect(n).toContain("wp_search_posts");
    expect(n.some((x) => x.startsWith("wp_create_"))).toBe(false);
  });

  it("explains itself rather than going quiet", async () => {
    const out = await call("wp_login_status", {}, other());
    expect(out).toContain("no entry for 127.0.0.1");
    expect(out).toContain("verdict: read-only");
  });

  it("falls back to the Access identity when the caller names nobody", async () => {
    // Only the worker facing the browser can see Access, so it passes the email on over RPC.
    // Omitting it means "use whoever Access says I am" rather than "nobody".
    const n = await names(site(), undefined);
    expect(n).toContain("wp_create_posts");
  });
});

describe("the MCP endpoint", () => {
  const post = (body: unknown, query = "") =>
    SELF.fetch(`https://worker/${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("answers a batch and drops notifications from it", async () => {
    const res = await post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(await res.json()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("names the server and its instructions on initialize", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize" }, site());
    const body = (await res.json()) as {
      result: { serverInfo: { name: string; icons: unknown[] } };
    };
    expect(body.result.serverInfo.name).toBe("mcp-wp");
    expect(body.result.serverInfo.icons).toHaveLength(1);
  });

  it("rejects malformed JSON with a parse error", async () => {
    const res = await SELF.fetch("https://worker/", { method: "POST", body: "{oops" });
    expect(res.status).toBe(400);
  });

  it("turns a site that is not WordPress into a JSON-RPC error", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, site(base + "/nope"));
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toContain("Failed to fetch types");
  });
});
