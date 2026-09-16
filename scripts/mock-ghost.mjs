/**
 * A fake Ghost site, enough of one to test mcp-ghost against without touching a real publication.
 *
 * It reproduces the parts that matter and the parts that bite:
 *   - the Content API blanks `html` on a gated post, exactly as Ghost does
 *   - sign-in links are single-use, so spending one twice fails the way a real one would
 *   - the session cookies come back as two separate Set-Cookie headers with a Max-Age
 *   - the article body only renders inside .gh-content when the cookies are present
 *
 * Usage: node scripts/mock-ghost.mjs [port]
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8798);
const KEY = "79b548ddd5142126203cac8f8f";
const MEMBER = "member@example.com";
const SESSION = { cookie: "ssr-cookie-value", sig: "ssr-sig-value" };
const MAX_AGE = 15778476; // what Ghost sends: about six months

const POSTS = [
  {
    id: "1",
    slug: "public-post",
    title: "A public post",
    url: `http://localhost:${PORT}/public-post/`,
    published_at: "2026-03-01T00:00:00.000Z",
    visibility: "public",
    excerpt: "Anyone can read this.",
    html: "<p>Anyone can read this, in full.</p>",
    primary_author: { name: "Osman" },
    tags: [{ name: "Media" }],
  },
  {
    id: "2",
    slug: "paid-post",
    title: "A paid post",
    url: `http://localhost:${PORT}/paid-post/`,
    published_at: "2026-04-01T00:00:00.000Z",
    visibility: "paid",
    excerpt: "Subscribers only.",
    html: "", // Ghost blanks this for gated posts, whatever key you present
    primary_author: { name: "Scott" },
    tags: [{ name: "Media" }],
  },
];

/** Tokens are handed out by send-magic-link and destroyed the first time they are spent. */
const liveTokens = new Set();

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const signedIn = (req) => {
  const jar = req.headers.cookie ?? "";
  return jar.includes(`ghost-members-ssr=${SESSION.cookie}`) && jar.includes(SESSION.sig);
};

const BODY = '<p>The <a href="https://example.com/x">full</a> body.</p><p>Second paragraph.</p>';
const page = (post, full) => `<!doctype html><html><body>
  <article><h1>${post.title}</h1>
  <section class="gh-content">
    ${full ? BODY : "<p>Subscribers only.</p>"}
  </section></article></body></html>`;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // ─── Members API ───
  if (path === "/members/api/integrity-token/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("integrity-abc123");
  }

  if (path === "/members/api/send-magic-link" && req.method === "POST") {
    const body = await new Promise((r) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => r(b));
    });
    const { email, integrityToken } = JSON.parse(body || "{}");
    if (!integrityToken)
      return json(res, 400, { errors: [{ message: "integrityToken required" }] });
    const token = `magic-${Date.now()}`;
    // Ghost answers 201 whether or not the address is a member, so it cannot be used to probe.
    if (email === MEMBER) liveTokens.add(token);
    res.writeHead(201, { "Content-Type": "application/json", "X-Mock-Token": token });
    return res.end("{}");
  }

  if (path === "/members/" && url.searchParams.get("token")) {
    const token = url.searchParams.get("token");
    if (!liveTokens.delete(token)) {
      // Spent or unknown: Ghost redirects without setting anything.
      res.writeHead(302, { Location: "/?action=signin&success=false" });
      return res.end();
    }
    res.writeHead(302, {
      Location: "/?action=signin&success=true",
      "Set-Cookie": [
        `ghost-members-ssr=${SESSION.cookie}; Path=/; HttpOnly; Max-Age=${MAX_AGE}`,
        `ghost-members-ssr.sig=${SESSION.sig}; Path=/; HttpOnly; Max-Age=${MAX_AGE}`,
      ],
    });
    return res.end();
  }

  if (path === "/members/api/member/") {
    if (!signedIn(req)) return json(res, 401, { errors: [{ message: "Unauthorized" }] });
    return json(res, 200, { email: MEMBER, name: "A Member" });
  }

  // ─── Content API ───
  if (path.startsWith("/ghost/api/content/")) {
    if (url.searchParams.get("key") !== KEY)
      return json(res, 401, { errors: [{ message: "Unknown Content API Key" }] });
    const rest = path.slice("/ghost/api/content/".length).replace(/\/$/, "");

    if (rest.startsWith("posts/slug/")) {
      const post = POSTS.find((p) => p.slug === rest.slice("posts/slug/".length));
      return post ? json(res, 200, { posts: [post] }) : json(res, 404, { posts: [] });
    }
    if (rest === "posts") {
      const filter = url.searchParams.get("filter") ?? "";
      const wanted = filter.match(/visibility:(\w+)/)?.[1];
      const posts = wanted ? POSTS.filter((p) => p.visibility === wanted) : POSTS;
      return json(res, 200, {
        posts,
        meta: { pagination: { total: posts.length, pages: 1, page: 1 } },
      });
    }
    if (rest === "tags")
      return json(res, 200, {
        tags: [{ name: "Media", slug: "media", count: { posts: 2 }, description: "About media" }],
      });
    if (rest === "authors")
      return json(res, 200, {
        authors: [{ name: "Osman", slug: "osman", bio: "Writes things", count: { posts: 1 } }],
      });
    return json(res, 404, { errors: [{ message: "Unknown endpoint" }] });
  }

  // ─── Rendered pages ───
  const post = POSTS.find((p) => path === `/${p.slug}/`);
  if (post) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(page(post, post.visibility === "public" || signedIn(req)));
  }

  res.writeHead(404).end("not found");
}).listen(PORT, () => console.log(`mock ghost on http://localhost:${PORT}`));
