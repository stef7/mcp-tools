/**
 * mcp-ghost — Ghost publications, including the paid posts you subscribe to.
 *
 *   ghost_search_posts    filter by tag, author, date or visibility
 *   ghost_get_post        one post; full text when you are signed in, excerpt when you are not
 *   ghost_list_tags       tags with post counts, to find slugs for search_posts
 *   ghost_list_authors    authors with bios and post counts
 *   ghost_login           emails you a sign-in link for a site
 *   ghost_login_complete  hand that link back here to finish signing in
 *   ghost_session_status  who you are signed in as, per site, and what is missing
 *   ghost_sign_out        forget a stored session
 *
 * Sign-in is per person: sessions are stored against the Cloudflare Access email, so each
 * person reads paid posts on their own subscription.
 *
 *   POST /?site=https://www.lamestream.com.au   tools drop the `site` argument
 *   POST /                                      tools take `site` on every call
 */
import cfg from "../wrangler.json";
import pkg from "../package.json";
import { mcpWorker, tool, type Ctx, type JSONSchema, type Tools } from "../../../core/mcp";
import { ICONS } from "../../../core/icons";
import {
  buildFilter,
  contentApi,
  formatAuthors,
  formatPost,
  formatTags,
  fullPostText,
  markdownish,
  type Author,
  type Post,
  type Site,
  type Tag,
} from "./ghost";
import { capture, forget, load, save, send, whoami, type Session } from "./session";

const SITE = {
  type: "string",
  description: 'Ghost site base URL, e.g. "https://www.lamestream.com.au".',
} as const;

type Entry = { key?: string; cookie?: string; cookie_sig?: string };
/** Spelled out rather than left as JSONSchema, so `run` still gets an indexable args object. */
type ObjSchema = { type: "object"; properties: Record<string, JSONSchema>; required: string[] };

/** GHOST_SITES arrives already parsed when the dashboard variable is typed JSON. */
const readSites = (v: unknown): Record<string, Entry> => {
  if (v && typeof v === "object") return v as Record<string, Entry>;
  if (typeof v !== "string") return {};
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
};

const entryFor = (host: string, env: Env) => readSites(env.GHOST_SITES)[host];

/** A site needs only its public Content API key; signing in is separate and optional. */
const siteFrom = (raw: string, env: Env): Site => {
  const url = (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, "");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`Invalid site URL: ${raw}`);
  }
  const key = entryFor(host, env)?.key ?? env.GHOST_CONTENT_KEY;
  if (!key)
    throw new Error(
      `No Content API key for ${host}. Add it to the GHOST_SITES variable as ` +
        `{"${host}": {"key": "..."}}. Ghost calls the content key safe to expose, so it can be ` +
        "a plain variable rather than a secret.",
    );
  return { url, host, key };
};

/**
 * The session to read paid posts with: this person's own first, then the shared cookies an
 * entry may carry from before per-person sign-in existed.
 */
const sessionFor = async (site: Site, c: Ctx): Promise<Session | null> => {
  const email = await c.email();
  if (email) {
    const mine = await load(c.env.SESSIONS, email, site.host);
    if (mine) return mine;
  }
  const shared = entryFor(site.host, c.env);
  return shared?.cookie && shared.cookie_sig
    ? { cookie: shared.cookie, sig: shared.cookie_sig, at: 0 }
    : null;
};

/** Signing in needs somewhere to keep the result, and that means knowing who you are. */
const whoAmI = async (c: Ctx) => {
  const email = await c.email();
  if (!email)
    throw new Error(
      "Signing in needs a signed-in identity and none arrived. Turn on Cloudflare Access for " +
        "this worker; the session is stored against your Access email so it stays yours.",
    );
  return email;
};

const sitesOf = (c: Ctx) => c.params.get("site") ?? c.params.get("ghost");

export default mcpWorker({
  ...cfg,
  version: pkg.version,
  icon: ICONS.ghost,
  info: () => ({
    title: "Ghost",
    description: "Read Ghost publications, including the paid posts you subscribe to.",
    instructions:
      "The Content API returns an empty body for members-only and paid posts; the full text " +
      "needs a member session, which ghost_login sets up. Ghost has no full-text search — use " +
      "list_tags, then search_posts with a tag.",
  }),
  tools: (c: Ctx): Tools => {
    const fixed = sitesOf(c);
    // With the site fixed in the connector URL, every tool drops its `site` argument.
    const withSite = (props: Record<string, JSONSchema>, required: string[] = []): ObjSchema =>
      fixed
        ? { type: "object", properties: props, required }
        : { type: "object", properties: { site: SITE, ...props }, required: ["site", ...required] };
    const resolve = (args: Record<string, unknown>) =>
      siteFrom(String(fixed ?? args["site"] ?? ""), c.env);

    return {
      search_posts: tool({
        description:
          "Search Ghost posts by tag, author, date range or visibility. Ghost's Content API has " +
          "no full-text search, so filter by tag or author — call list_tags first to see what " +
          "there is. Returns titles, excerpts, dates, authors, tags and URLs. Works on any " +
          "Ghost publication: Lamestream, ETTE Media, Boiling Cold, Red Flag, The Betoota " +
          "Advocate, 404 Media, and many Australian regional papers.",
        input: withSite({
          tag: { type: "string", description: "Tag slug. list_tags has them." },
          author: { type: "string", description: 'Author slug, e.g. "osman".' },
          visibility: {
            type: "string",
            enum: ["public", "members", "paid"],
            description: "Filter by access level.",
          },
          date_from: {
            type: "string",
            description: 'ISO date; posts on or after, e.g. "2025-01-01".',
          },
          date_to: { type: "string", description: "ISO date; posts on or before." },
          filter: {
            type: "string",
            description:
              "Raw Ghost NQL, appended to the arguments above. See " +
              "https://ghost.org/docs/content-api/#filtering",
          },
          limit: { type: "integer", default: 15, description: "Per page, max 200." },
          page: { type: "integer", default: 1, description: "Page number." },
          order: { type: "string", default: "published_at desc", description: "Sort order." },
        }),
        async run(args) {
          const site = resolve(args);
          const limit = Math.min(Number(args["limit"]) || 15, 200);
          const page = Number(args["page"]) || 1;
          const data = await contentApi(site, "posts", {
            limit,
            page,
            order: args["order"] ?? "published_at desc",
            filter: buildFilter(args) || undefined,
            include: "tags,authors",
            fields: "id,slug,title,url,published_at,visibility,excerpt,html",
          });
          const posts = (data["posts"] ?? []) as Post[];
          if (!posts.length) return "No posts found matching those filters.";
          const meta = (data["meta"] as { pagination?: { total?: number; pages?: number } })
            ?.pagination;
          const total = meta?.total ?? posts.length;
          const pages = meta?.pages ?? 1;
          const body = posts.map((p, i) => `${(page - 1) * limit + i + 1}. ${formatPost(p)}`);
          const more = page < pages ? ["", `Call again with page=${page + 1} for more.`] : [];
          return [
            `Found ${total} post${total === 1 ? "" : "s"} (page ${page} of ${pages}):`,
            "",
            ...body,
            ...more,
          ].join("\n");
        },
      }),

      get_post: tool({
        description:
          "Read one post by slug or ID. When you are signed in as a member of that site, this " +
          "returns the full body of a paid post; otherwise Ghost gives only the excerpt, " +
          "because its Content API never serves gated content. Use ghost_login to sign in.",
        input: withSite({
          slug: { type: "string", description: "Post slug from its URL. Preferred over id." },
          id: { type: "string", description: "Ghost post ID." },
        }),
        async run(args, ctx) {
          const site = resolve(args);
          const slug = args["slug"] as string | undefined;
          const id = args["id"] as string | undefined;
          if (!slug && !id) return "Provide either slug or id.";
          const data = await contentApi(site, slug ? `posts/slug/${slug}` : `posts/${id}`, {
            include: "tags,authors",
            fields: "id,slug,title,url,published_at,visibility,excerpt,html,plaintext",
          });
          const post = ((data["posts"] ?? []) as Post[])[0];
          if (!post) return "Post not found.";

          const session = await sessionFor(site, ctx);
          const full = post.url ? await fullPostText(post.url, session) : undefined;
          // Reading one post means the whole thing: fall back to the API's body before the
          // excerpt, which is all `search_posts` wants.
          const body = full ?? (post.html ? markdownish(post.html) : undefined);
          if (body) return formatPost(post, body);
          if (post.visibility && post.visibility !== "public") {
            const why = session
              ? "Your session for this site did not return the body — it has probably lapsed. " +
                "Run ghost_login again."
              : "This post is gated and you are not signed in to this site. Run ghost_login to " +
                "read it in full.";
            return `${formatPost(post)}\n\n[${why}]`;
          }
          return formatPost(post);
        },
      }),

      list_tags: tool({
        description:
          "List the site's tags with post counts. Ghost has no full-text search, so this is how " +
          "you find something to filter search_posts by.",
        input: withSite({
          limit: { type: "integer", default: 50, description: "Max tags, up to 200." },
        }),
        async run(args) {
          const data = await contentApi(resolve(args), "tags", {
            limit: Math.min(Number(args["limit"]) || 50, 200),
            order: "count.posts desc",
            include: "count.posts",
          });
          return formatTags((data["tags"] ?? []) as Tag[]);
        },
      }),

      list_authors: tool({
        description: "List the site's authors, with bios and post counts.",
        input: withSite({}),
        async run(args) {
          const data = await contentApi(resolve(args), "authors", {
            limit: 50,
            include: "count.posts",
          });
          return formatAuthors((data["authors"] ?? []) as Author[]);
        },
      }),

      login: tool({
        description:
          "Start signing in to a Ghost site, so paid posts can be read in full. Ghost members " +
          "have no passwords: this asks the site to email a sign-in link to the address given. " +
          "Open the email, copy the link WITHOUT clicking it, and pass it to " +
          "ghost_login_complete — the link works once, and clicking it spends it on your " +
          "browser instead of here.",
        confirm: "Asks the site to send a sign-in email to that address.",
        annotations: { readOnlyHint: false, destructiveHint: false },
        input: withSite(
          {
            email: {
              type: "string",
              description: "The address your membership of that site is under.",
            },
          },
          ["email"],
        ),
        async run(args, ctx) {
          const site = resolve(args);
          await whoAmI(ctx); // fail now rather than after the email has gone out
          const sent = await send(site.url, args["email"] as string);
          if (!sent.ok)
            return (
              `${site.host} refused the sign-in request (${sent.status}). ${sent.body}\n\n` +
              (sent.hadToken
                ? ""
                : "It also has no integrity-token endpoint, so it may be an older Ghost.")
            );
          return (
            `Asked ${site.host} to email a sign-in link to ${args["email"]}.\n\n` +
            "Ghost answers the same way whether or not that address is a member, so this is not " +
            "confirmation that an email is coming.\n\n" +
            "Next: open the email, copy the link WITHOUT clicking it, and pass it to " +
            "ghost_login_complete. The link is single-use — clicking it first, or a mail " +
            "scanner following it, spends it."
          );
        },
      }),

      login_complete: tool({
        description:
          "Finish signing in: hand over the link from the sign-in email. It is followed here " +
          "rather than in a browser, and the session it returns is stored against your " +
          "Cloudflare Access identity, for this site only.",
        confirm: "Stores a member session for you on this worker.",
        annotations: { readOnlyHint: false, destructiveHint: false },
        input: withSite(
          {
            link: {
              type: "string",
              description: "The whole sign-in URL from the email, tokens and all.",
            },
          },
          ["link"],
        ),
        async run(args, ctx) {
          const site = resolve(args);
          const email = await whoAmI(ctx);
          const got = await capture(args["link"] as string);
          if ("problem" in got) return got.problem;
          const member = await whoami(site.url, got.session);
          const session = { ...got.session, ...(member ? { member } : {}) };
          await save(ctx.env.SESSIONS, email, site.host, session, got.ttl);
          const days = got.ttl ? Math.round(got.ttl / 86400) : null;
          return (
            `Signed in to ${site.host}${member ? ` as ${member}` : ""}, stored for ${email}.\n` +
            (member
              ? ""
              : "Ghost did not confirm the member, so the session may not work — try a paid " +
                "post and check.\n") +
            (days ? `The session lasts about ${days} days; sign in again after that.` : "")
          );
        },
      }),

      session_status: tool({
        description:
          "Who you are signed in as on each Ghost site, and what is missing. Start here when a " +
          "paid post comes back as an excerpt.",
        input: withSite({}),
        async run(args, ctx) {
          const email = await ctx.email();
          const lines = [`Access identity: ${email ?? "none — turn on Cloudflare Access"}`];
          const configured = Object.keys(readSites(ctx.env.GHOST_SITES));
          lines.push(
            `GHOST_SITES: ${configured.length ? configured.join(", ") : "empty or unreadable"}`,
          );
          let site: Site | undefined;
          try {
            site = resolve(args);
          } catch (e) {
            lines.push("", e instanceof Error ? e.message : String(e));
          }
          if (site) {
            lines.push("", `site: ${site.host}`, "content key: set");
            const mine = email ? await load(ctx.env.SESSIONS, email, site.host) : null;
            const shared = entryFor(site.host, ctx.env);
            lines.push(
              mine
                ? `your session: stored${mine.member ? ` as ${mine.member}` : ""}, ` +
                    `signed in ${new Date(mine.at).toISOString().slice(0, 10)}`
                : "your session: none — run ghost_login",
            );
            if (shared?.cookie && shared.cookie_sig)
              lines.push("shared cookies: present in GHOST_SITES, used when you have no session");
            lines.push(
              "",
              mine || shared?.cookie
                ? "verdict: paid posts readable"
                : "verdict: public posts only",
            );
          }
          return lines.join("\n");
        },
      }),

      sign_out: tool({
        description: "Forget your stored session for a site. It does not sign you out elsewhere.",
        confirm: "Deletes your stored session for that site.",
        annotations: { readOnlyHint: false, destructiveHint: true },
        input: withSite({}),
        async run(args, ctx) {
          const site = resolve(args);
          const email = await whoAmI(ctx);
          await forget(ctx.env.SESSIONS, email, site.host);
          return `Forgot the session for ${site.host} under ${email}.`;
        },
      }),
    };
  },
});
