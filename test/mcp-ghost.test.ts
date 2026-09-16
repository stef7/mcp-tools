/**
 * mcp-ghost against the fake Ghost in scripts/mock-ghost.mjs.
 *
 * The point of these is the sign-in flow, which is the part that cannot be reasoned about: it
 * depends on Ghost handing back two Set-Cookie headers from a link that only works once. The
 * mock reproduces that, so the parsing and storage are proven here even though only a real
 * publication can prove Ghost still behaves this way.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, inject, it } from "vitest";
import Worker from "../workers/mcp-ghost/src/index";

const base = inject("ghostBase");
const ME = "me@example.com";
const MEMBER = "member@example.com";
const KEY = "79b548ddd5142126203cac8f8f";
const search = `?site=${encodeURIComponent(base)}`;

type Spec = { name: string; description: string; annotations: Record<string, boolean> };

const ghost = () => new Worker(createExecutionContext(), env);
const tools = (s = search, email: string | undefined = ME) =>
  ghost().tools({ search: s, email }) as Promise<Spec[]>;
const call = async (name: string, args: unknown = {}, email: string | undefined = ME) => {
  const r = (await ghost().call(name, args, { search, email })) as { content: { text: string }[] };
  return r.content[0]!.text;
};

/** Ask the mock for a sign-in link the way Ghost would email one. */
const magicLink = async (email = MEMBER) => {
  const res = await fetch(`${base}/members/api/send-magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, emailType: "signin", integrityToken: "x" }),
  });
  return `${base}/members/?token=${res.headers.get("X-Mock-Token")}&action=signin`;
};

/** Sign in from scratch. Each test needs its own: the pool rolls KV back between them. */
const signIn = async () =>
  call("ghost_login_complete", { link: await magicLink(), user_confirmed: true });

beforeAll(async () => {
  // The worker reads the content key from here, exactly as it would in the dashboard.
  (env as unknown as Record<string, unknown>)["GHOST_SITES"] = { localhost: { key: KEY } };
});

describe("the tool list", () => {
  it("carries the worker's prefix", async () => {
    expect((await tools()).map((t) => t.name)).toEqual([
      "ghost_search_posts",
      "ghost_get_post",
      "ghost_list_tags",
      "ghost_list_authors",
      "ghost_login",
      "ghost_login_complete",
      "ghost_session_status",
      "ghost_sign_out",
    ]);
  });

  it("separates reading from signing in, so a client can group them", async () => {
    const by = Object.fromEntries((await tools()).map((t) => [t.name, t.annotations]));
    expect(by["ghost_search_posts"]!.readOnlyHint).toBe(true);
    expect(by["ghost_session_status"]!.readOnlyHint).toBe(true);
    expect(by["ghost_login"]!.readOnlyHint).toBe(false);
    expect(by["ghost_login"]!.destructiveHint).toBe(false);
    expect(by["ghost_sign_out"]!.destructiveHint).toBe(true);
  });

  it("says what ghost_login will actually do, rather than 'changes the site'", async () => {
    const login = (await tools()).find((t) => t.name === "ghost_login");
    expect(login!.description).toContain("send a sign-in email");
  });

  it("drops the site argument when the connector URL fixes it", async () => {
    const fixed = (await tools()) as unknown as { inputSchema: { required?: string[] } }[];
    expect(fixed[0]!.inputSchema.required).not.toContain("site");
    const generic = (await tools("")) as unknown as { inputSchema: { required?: string[] } }[];
    expect(generic[0]!.inputSchema.required).toContain("site");
  });
});

describe("reading without a session", () => {
  it("returns public posts in full", async () => {
    const out = await call("ghost_get_post", { slug: "public-post" });
    expect(out).toContain("A public post");
    expect(out).toContain("full");
  });

  it("returns a paid post as an excerpt, and says why", async () => {
    const out = await call("ghost_get_post", { slug: "paid-post" });
    expect(out).toContain("Access: paid");
    expect(out).toContain("not signed in");
    expect(out).toContain("ghost_login");
  });

  it("lists tags and authors", async () => {
    expect(await call("ghost_list_tags")).toContain("**Media**");
    expect(await call("ghost_list_authors")).toContain("**Osman**");
  });
});

describe("signing in", () => {
  it("will not send an email until the user has confirmed", async () => {
    const out = await call("ghost_login", { email: MEMBER });
    expect(out).toContain("user_confirmed");
    expect(out).toContain("send a sign-in email");
  });

  it("asks Ghost to email a link, without claiming the address is a member", async () => {
    const out = await call("ghost_login", { email: MEMBER, user_confirmed: true });
    expect(out).toContain("Asked");
    expect(out).toContain("not confirmation");
    expect(out).toContain("WITHOUT clicking");
  });

  it("captures the session from the link and names the member", async () => {
    const out = await signIn();
    expect(out).toContain(`Signed in to localhost as ${MEMBER}`);
    expect(out).toContain(`stored for ${ME}`);
    expect(out).toMatch(/lasts about 18\d days/); // read off Ghost's own Max-Age, not guessed
  });

  it("then reads the paid post in full", async () => {
    await signIn();
    const out = await call("ghost_get_post", { slug: "paid-post" });
    expect(out).toContain("Second paragraph");
    expect(out).toContain("[full](https://example.com/x)"); // links survive the strip
    expect(out).not.toContain("not signed in");
  });

  it("keeps the session to the person who created it", async () => {
    await signIn();
    const out = await call("ghost_get_post", { slug: "paid-post" }, "someone@else.com");
    expect(out).toContain("not signed in");
  });

  it("reports the session in session_status", async () => {
    await signIn();
    const out = await call("ghost_session_status");
    expect(out).toContain(`Access identity: ${ME}`);
    expect(out).toContain(`your session: stored as ${MEMBER}`);
    expect(out).toContain("verdict: paid posts readable");
  });

  it("forgets it on sign out", async () => {
    await signIn();
    expect(await call("ghost_sign_out", { user_confirmed: true })).toContain("Forgot the session");
    expect(await call("ghost_session_status")).toContain("verdict: public posts only");
  });
});

describe("a link that has already been spent", () => {
  it("explains what happened instead of failing silently", async () => {
    const link = await magicLink();
    await fetch(link, { redirect: "manual" }); // a mail scanner gets there first
    const out = await call("ghost_login_complete", { link, user_confirmed: true });
    expect(out).toContain("did not sign anyone in");
    expect(out).toContain("single-use");
  });

  it("says the same for an address that is not a member", async () => {
    const out = await call("ghost_login_complete", {
      link: await magicLink("stranger@example.com"),
      user_confirmed: true,
    });
    expect(out).toContain("did not sign anyone in");
  });
});
