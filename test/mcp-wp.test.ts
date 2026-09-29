/**
 * mcp-wp against the mock WordPress in scripts/mock-wp.mjs.
 *
 * Tools are exercised through the worker's RPC surface, the same one mcp-toolkit calls, because
 * it takes the signed-in identity as an argument. The HTTP endpoint gets its own tests for the
 * protocol itself, where no identity is involved.
 */
import { SELF, createExecutionContext, env } from "cloudflare:test";
import { describe, expect, inject, it } from "vitest";
import Worker, { sitesInPath } from "../workers/mcp-wp/src/index";

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
type Headers = Record<string, string>;
const call = async (
  name: string,
  args: unknown,
  search: string,
  email: string | undefined = ME,
  headers?: Headers,
) => {
  const r = (await wp().call(name, args, { search, email, headers })) as {
    content: { text: string }[];
  };
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
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("mcp-wp");
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

describe("a site named in the path", () => {
  const list = async (path: string) => {
    const res = await SELF.fetch(`https://worker/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await res.json()) as { result?: { tools: { name: string }[] } };
    return body.result?.tools.map((t) => t.name) ?? [];
  };

  it("targets that site, as ?wp= would", async () => {
    const n = await list(base);
    expect(n).toContain("wp_search_posts");
    expect(n).not.toContain("wp_discover_site");
  });

  it("survives a client or proxy merging the double slash", async () => {
    expect(await list(base.replace("://", ":/"))).toContain("wp_search_posts");
  });

  it("survives the scheme being percent-encoded", async () => {
    expect(await list(encodeURIComponent(base))).toContain("wp_search_posts");
  });

  it("keeps the rest of the query string, such as the title", async () => {
    const res = await SELF.fetch(`https://worker/${base}?title=Happily`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    const body = (await res.json()) as { result: { serverInfo: { title?: string } } };
    expect(body.result.serverInfo.title).toBe("Happily");
  });

  it("wins over a ?wp= alongside it", async () => {
    const n = await list(`${base}${site(base + "/nope")}`);
    expect(n).toContain("wp_search_posts");
  });

  it("leaves a path without a scheme in generic mode", async () => {
    expect(await list("favicon.ico")).toContain("wp_discover_site");
    expect(sitesInPath(new URL("https://worker/"))).toBeNull();
    expect(sitesInPath(new URL("https://worker/%E0%A4%A"))).toBeNull();
  });

  it("reads several sites separated by commas, like ?wp=", () => {
    const url = new URL("https://worker/https://a.org,https:/b.org/news");
    expect(sitesInPath(url)).toBe("https://a.org,https://b.org/news");
  });
});

describe("the X-Auth-Token header", () => {
  // Spaced the way WordPress prints an application password; the worker strips them,
  // and the mock only accepts the stripped form, so this proves both halves.
  const HDR = { "x-auth-token": "hdr-user:abcd EFGH 1234" };
  const blog = site(`${base}/blog`);

  it("unlocks writes with no Access identity at all", async () => {
    const specs = (await wp().tools({ search: blog, email: undefined, headers: HDR })) as Spec[];
    expect(specs.map((t) => t.name)).toContain("wp_create_posts");
  });

  it("keeps a password containing colons, equals signs and the like", async () => {
    const out = await call("wp_login_status", {}, site(), ME, { "x-auth-token": "u:a:b=c;d" });
    expect(out).toContain("X-Auth-Token: used — user u");
  });

  it("wins over WP_SITES, so the header's own login is the one that is sent", async () => {
    const out = await call(
      "wp_create_posts",
      { title: "Via header", user_confirmed: true },
      site(),
      ME,
      HDR,
    );
    expect(out).toContain("Created");
    const seen = await fetch(`${base}/__last-auth`).then((r) => r.text());
    expect(seen).toBe("hdr-user:abcdEFGH1234");
  });

  it("leaves WP_SITES in charge when no header is sent", async () => {
    const out = await call(
      "wp_create_posts",
      { title: "Via WP_SITES", user_confirmed: true },
      site(),
    );
    expect(out).toContain("Created");
    const seen = await fetch(`${base}/__last-auth`).then((r) => r.text());
    expect(seen).toBe("wp-user:secretpass");
  });

  it("is ignored on a connector for several sites, since one login cannot be everyone's", async () => {
    const both = `?wp=${encodeURIComponent(`${base},${base}/blog`)}`;
    const specs = (await wp().tools({ search: both, email: undefined, headers: HDR })) as Spec[];
    expect(specs.some((t) => t.name.includes("_create_"))).toBe(false);
  });

  it("is never sent to a URL a generic-mode tool call names", async () => {
    // Straight to the worker: `call` would swap an undefined email for ME.
    const r = (await wp().call(
      "wp_create_content",
      { url: base, title: "Nope", user_confirmed: true },
      { search: "", email: undefined, headers: HDR },
    )) as { content: { text: string }[] };
    expect(r.content[0]!.text).toContain("read-only");
  });

  it("is reported by login_status without the password appearing", async () => {
    const out = await call("wp_login_status", {}, site(), ME, HDR);
    expect(out).toContain("X-Auth-Token: used — user hdr-user");
    expect(out).toContain("the header wins");
    expect(out).not.toContain("abcd EFGH 1234");
    expect(out).not.toContain("abcdEFGH1234");
  });

  it("says so when it cannot be read", async () => {
    const out = await call("wp_login_status", {}, site(), ME, { "x-auth-token": "no-colon" });
    expect(out).toContain("unreadable");
    expect(out).toContain("verdict: editable"); // WP_SITES still covers this one
  });

  it("is the only header read: the old ones are gone", async () => {
    const old = { "x-wp-auth": "hdr-user:abcdEFGH1234", "x-api-key": "hdr-user:abcdEFGH1234" };
    const specs = (await wp().tools({ search: blog, email: undefined, headers: old })) as Spec[];
    expect(specs.some((t) => t.name.includes("_create_"))).toBe(false);
    const viaSite = (await wp().tools({ search: "", headers: { "x-wp-site": base } })) as Spec[];
    expect(viaSite.map((t) => t.name)).toContain("wp_discover_site"); // generic mode, not a site
  });
});

describe("reading a post body", () => {
  it("returns the markup exactly as WordPress stores it", async () => {
    // Reading is the first half of editing: strip the HTML here and writing it back would
    // replace the blocks, links and embeds with plain text.
    const out = await call("wp_get_posts", { id: 1 }, site());
    expect(out).toContain("<p>Body &amp; text</p>");
    expect(out).toMatch(/<h1>.*<\/h1>/);
  });

  it("still strips the preview in a list of results, where markup would be noise", async () => {
    const out = await call("wp_search_posts", { query: "post" }, site());
    expect(out).not.toContain("<p>");
    expect(out).toContain("Excerpt for \u201c"); // entities decoded, tags gone
  });

  it("leaves the heading line free of markup either way", async () => {
    const first = (await call("wp_get_posts", { id: 1 }, site())).split("\n")[0]!;
    expect(first.startsWith("# ")).toBe(true);
    expect(first).not.toContain("<");
  });
});

describe("WooCommerce", () => {
  // The mock's root site exposes wc/v3; "/blog" does not, and 127.0.0.1 has no login.
  const other = () => site(base.replace("localhost", "127.0.0.1"));
  type Schema = { properties: Record<string, any>; required?: string[] };
  const schemaOf = async (name: string) =>
    (await tools(site())).find((t) => t.name === name)!.inputSchema as unknown as Schema;

  it("builds tools from the site's own index, and only for the methods it offers", async () => {
    const n = await names(site());
    for (const verb of ["search", "get", "create", "update", "delete"])
      expect(n).toContain(`wp_${verb}_wc_products`);
    expect(n).toContain("wp_get_wc_orders");
    expect(n).not.toContain("wp_update_wc_orders"); // the index offers no write for orders here
    expect(n).toContain("wp_create_wc_order_notes");
    expect(n).not.toContain("wp_search_wc_customers"); // no such route on this site
    expect(n).toContain("wp_get_wc_endpoint");
  });

  it("takes product writes away from wp/v2, which would drop price and stock", async () => {
    const n = await names(site());
    expect(n).toContain("wp_search_products"); // reading through wp/v2 is harmless
    expect(n).not.toContain("wp_create_product");
    expect(n).not.toContain("wp_update_product");
  });

  it("offers nothing without a login, because WooCommerce will not even read without one", async () => {
    expect((await names(other())).some((x) => x.includes("_wc_"))).toBe(false);
    expect((await names(site(`${base}/blog`))).some((x) => x.includes("_wc_"))).toBe(false);
  });

  it("keeps the fields a client can send and drops what would break it", async () => {
    const s = await schemaOf("wp_create_wc_products");
    expect(s.properties["status"].enum).toContain("draft");
    const meta = s.properties["meta_data"].items.properties;
    expect(meta.id).toBeUndefined(); // readonly
    expect(meta.value.type).toBeUndefined(); // "mixed" is not a JSON Schema type
    expect((await schemaOf("wp_search_wc_products")).properties["context"]).toBeUndefined();
  });

  it("asks for the parent ID of a nested resource, and the route's own required fields", async () => {
    const s = await schemaOf("wp_create_wc_order_notes");
    expect(s.required).toEqual(expect.arrayContaining(["order_id", "note", "user_confirmed"]));
  });

  it("searches with the login and passes the route's filters through", async () => {
    const out = await call("wp_search_wc_products", { sku: "SKU-201" }, site());
    expect(out).toContain("Mug");
    expect(out).not.toContain("Tote bag");
    expect(out).toContain("sku: SKU-201");
  });

  it("returns one record whole, without the API's links", async () => {
    const out = await call("wp_get_wc_products", { id: 202 }, site());
    expect(out.split("\n")[0]).toBe("# Tote bag");
    expect(out).not.toContain("_links");
  });

  it("creates a product as a draft unless told otherwise", async () => {
    const out = await call("wp_create_wc_products", { name: "Cap", user_confirmed: true }, site());
    expect(out).toContain("status: draft");
  });

  it("sends only the fields the route declares", async () => {
    const out = await call(
      "wp_update_wc_products",
      { id: 201, name: "Big mug", bogus: 1, user_confirmed: true },
      site(),
    );
    const sent = JSON.parse(out.slice(out.indexOf("{"))).sent;
    expect(sent).toEqual({ name: "Big mug" });
  });

  it("fills a nested path from the parent ID", async () => {
    const out = await call(
      "wp_create_wc_order_notes",
      { order_id: 301, note: "Shipped", user_confirmed: true },
      site(),
    );
    expect(out).toContain("Created order note: Shipped");
  });

  it("trashes unless force is passed", async () => {
    const out = await call("wp_delete_wc_products", { id: 202, user_confirmed: true }, site());
    expect(out).toContain("Moved product 202 to the trash");
  });

  it("reads any other route, and lists them when asked for none", async () => {
    expect(await call("wp_get_wc_endpoint", {}, site())).toContain("orders/{order_id}/notes");
    const sales = await call(
      "wp_get_wc_endpoint",
      { path: "reports/sales", query: { period: "month" } },
      site(),
    );
    expect(sales).toContain('"period": "month"');
  });

  it("will not let a path climb out of wc/v3 with the login attached", async () => {
    for (const path of ["../wp/v2/users", "%2e%2e/wp/v2/users", "orders?x=1"])
      expect(await call("wp_get_wc_endpoint", { path }, site())).toContain("Invalid path");
  });

  it("works from generic mode too, given a url", async () => {
    const out = await call("wp_search_wc", { url: base, resource: "orders" }, "");
    expect(out).toContain("301 — Ada L");
    const none = await call(
      "wp_search_wc",
      { url: base.replace("localhost", "127.0.0.1"), resource: "orders" },
      "",
    );
    expect(none).toContain("No login configured");
  });
});
