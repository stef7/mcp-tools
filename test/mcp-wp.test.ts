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
import { authFrom } from "../workers/mcp-wp/src/wp";

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

describe("the X-WP-Auth header", () => {
  // Spaced the way WordPress prints an application password; the worker strips them,
  // and the mock only accepts the stripped form, so this proves both halves.
  const HDR = { "x-wp-auth": "hdr-user:abcd EFGH 1234" };
  const blog = site(`${base}/blog`);

  it("takes a bare entry as the login for whatever site the connector covers", () => {
    expect(authFrom({ "x-wp-auth": "u:p" }, "apil.au")).toEqual({ user: "u", pass: "p" });
  });

  it("keeps a password containing the separators a single header would have needed", () => {
    // One entry per header is the point: nothing here has to be escaped or avoided.
    for (const pass of ["a;b", "a,b", "a=b", "a:b", "abcd efgh ijkl"])
      expect(authFrom({ "x-wp-auth": `u:${pass}` }, "x")).toEqual({ user: "u", pass });
  });

  it("gives each site its own header, and matches on the host", () => {
    const many = { "x-wp-auth-a": "apil.au=a:1", "x-wp-auth-b": "crikey.com.au=b:2" };
    expect(authFrom(many, "apil.au")).toEqual({ user: "a", pass: "1" });
    expect(authFrom(many, "crikey.com.au")).toEqual({ user: "b", pass: "2" });
    expect(authFrom(many, "example.org")).toBeNull();
  });

  it("lets a header naming the host beat a bare one, so a default plus an exception works", () => {
    const both = { "x-wp-auth": "default:pw", "x-wp-auth-apil": "apil.au=special:pw2" };
    expect(authFrom(both, "apil.au")).toEqual({ user: "special", pass: "pw2" });
    expect(authFrom(both, "elsewhere.org")).toEqual({ user: "default", pass: "pw" });
  });

  it("ignores headers that are not logins, and entries it cannot read", () => {
    expect(authFrom({}, "x")).toBeNull();
    expect(authFrom({ "x-wp-site": "apil.au" }, "x")).toBeNull();
    expect(authFrom({ "x-wp-auth": "no-colon-here" }, "x")).toBeNull();
    expect(authFrom({ "x-wp-auth": ":no-user" }, "x")).toBeNull();
    expect(authFrom({ "x-wp-auth": "no-pass:" }, "x")).toBeNull();
  });

  it("unlocks writes with no Access identity at all", async () => {
    const specs = (await wp().tools({ search: blog, email: undefined, headers: HDR })) as Spec[];
    expect(specs.map((t) => t.name)).toContain("wp_create_posts");
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

  it("is reported by login_status without the password appearing", async () => {
    const out = await call("wp_login_status", {}, site(), ME, HDR);
    expect(out).toContain("1 sent, one used — user hdr-user");
    expect(out).toContain("the header wins");
    expect(out).not.toContain("abcd EFGH 1234");
    expect(out).not.toContain("abcdEFGH1234");
  });

  it("says what is wrong when every header names a different host", async () => {
    const out = await call("wp_login_status", {}, site(), ME, {
      "x-wp-auth": "somewhere.else=u:p",
    });
    expect(out).toContain("none of them for");
    expect(out).toContain("verdict: editable"); // WP_SITES still covers this one
  });
});

describe("the X-WP-Site header", () => {
  it("stands in for ?wp=, so a connector needs no query string", async () => {
    const specs = (await wp().tools({
      search: "",
      email: ME,
      headers: { "x-wp-site": base },
    })) as Spec[];
    expect(specs.map((t) => t.name)).toContain("wp_search_posts");
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
