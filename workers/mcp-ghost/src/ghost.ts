/**
 * Ghost's Content API, and reading a paid post despite it.
 *
 * The Content API only ever serves public data: for a members-only or paid post it returns the
 * metadata and an empty `html`. There is no key or token that changes that. The only way to the
 * body is to be signed in as a member and read the page Ghost renders, which is what
 * fullPostText does with the cookies from session.ts.
 */
import { BROWSER_UA, stripHtml as strip, truncate } from "../../../core/web";
import { cookieHeader, type Session } from "./session";

export type Site = { url: string; host: string; key: string };
export type Post = {
  id?: string;
  slug?: string;
  title?: string;
  url?: string;
  published_at?: string;
  visibility?: string;
  excerpt?: string;
  html?: string;
  plaintext?: string;
  primary_author?: { name?: string };
  tags?: { name?: string }[];
};
export type Tag = {
  name?: string;
  slug?: string;
  description?: string;
  count?: { posts?: number };
};
export type Author = {
  name?: string;
  slug?: string;
  bio?: string;
  website?: string;
  count?: { posts?: number };
};

/** One Content API request. `key` is Ghost's public content key, not a secret. */
export const contentApi = async (site: Site, endpoint: string, params: Record<string, unknown>) => {
  const url = new URL(`${site.url}/ghost/api/content/${endpoint}/`);
  url.searchParams.set("key", site.key);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { "Accept-Version": "v5.0", "User-Agent": BROWSER_UA } });
  if (!res.ok) throw new Error(`Ghost API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<Record<string, unknown>>;
};

// ─── Reading a paid post ───────────────────────────────────────────────────────────────────────

/**
 * Rebuilds the post body as HTML so the shared stripHtml can see hrefs and headings.
 *
 * The tag name is copied out before onEndTag is registered. An element token is only valid for
 * as long as its own handler is running, and the end-tag callback runs later — reading `el`
 * from inside it throws "This content token is no longer valid" and loses the whole body.
 */
class Collector {
  chunks: string[] = [];
  element(el: Element) {
    const name = el.tagName;
    let open = `<${name}`;
    for (const [k, v] of el.attributes) open += ` ${k}="${v}"`;
    this.chunks.push(open + ">");
    el.onEndTag(() => void this.chunks.push(`</${name}>`));
  }
  text(chunk: Text) {
    this.chunks.push(chunk.text);
  }
}

/**
 * The rendered body of a post, read as a signed-in member. Returns undefined when there is no
 * session, the session has lapsed, or the page has no article body — every one of which just
 * means "fall back to whatever the API gave us".
 */
export const fullPostText = async (postUrl: string, s: Session | null) => {
  if (!s) return undefined;
  let res: Response;
  try {
    res = await fetch(postUrl, { headers: { Cookie: cookieHeader(s), "User-Agent": BROWSER_UA } });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const collector = new Collector();
  try {
    await new HTMLRewriter().on(".gh-content *", collector).transform(res).text();
  } catch {
    return undefined;
  }
  const html = collector.chunks.join("").trim();
  return html ? markdownish(html) : undefined;
};

// ─── Formatting ────────────────────────────────────────────────────────────────────────────────

/** Like the shared stripHtml, but keeping the links, headings and bold a reader wants. */
export const markdownish = (html = "") =>
  strip(
    html
      .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text: string) => {
        const inner = text.replace(/<[^>]+>/g, "").trim();
        return inner ? `[${inner}](${href})` : String(href);
      })
      .replace(/<h1[^>]*>/gi, "# ")
      .replace(/<h2[^>]*>/gi, "## ")
      .replace(/<h3[^>]*>/gi, "### ")
      .replace(/<h4[^>]*>/gi, "#### ")
      .replace(/<(strong|b)>([\s\S]*?)<\/(strong|b)>/gi, "**$2**"),
  );

const formatDate = (s?: string) => {
  if (!s) return "";
  const at = new Date(s);
  return isNaN(at.getTime())
    ? s
    : at.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
};

/** Ghost's NQL filter, assembled from the convenience arguments plus any raw filter given. */
export const buildFilter = (o: Record<string, unknown>) =>
  [
    o["tag"] && `tag:${o["tag"]}`,
    o["author"] && `author:${o["author"]}`,
    o["visibility"] && `visibility:${o["visibility"]}`,
    o["date_from"] && `published_at:>='${o["date_from"]}'`,
    o["date_to"] && `published_at:<='${o["date_to"]}'`,
    o["filter"],
  ]
    .filter(Boolean)
    .join("+");

export const formatPost = (p: Post, body?: string) =>
  [
    `**${p.title}**`,
    `Published: ${formatDate(p.published_at)}`,
    p.primary_author?.name && `Author: ${p.primary_author.name}`,
    p.tags?.length && `Tags: ${p.tags.map((t) => t.name).join(", ")}`,
    `URL: ${p.url}`,
    p.visibility && p.visibility !== "public" && `Access: ${p.visibility}`,
    "",
    body ?? p.excerpt ?? truncate(markdownish(p.html || p.plaintext || ""), 300),
  ]
    .filter((l) => l !== false && l !== undefined && l !== 0)
    .join("\n");

export const formatTags = (tags: Tag[]) =>
  !tags.length
    ? "No tags found."
    : [
        `${tags.length} tag${tags.length === 1 ? "" : "s"}:`,
        "",
        ...tags.map(
          (t) =>
            `- **${t.name}** (slug: \`${t.slug}\`` +
            `${t.count?.posts ? `, ${t.count.posts} posts` : ""})` +
            (t.description ? `\n  ${t.description}` : ""),
        ),
      ].join("\n");

export const formatAuthors = (authors: Author[]) =>
  !authors.length
    ? "No authors found."
    : [
        `${authors.length} author${authors.length === 1 ? "" : "s"}:`,
        "",
        ...authors.map((a) =>
          [
            `**${a.name}** (slug: \`${a.slug}\`` +
              `${a.count?.posts ? `, ${a.count.posts} posts` : ""})`,
            a.bio && `  ${a.bio}`,
            a.website && `  Website: ${a.website}`,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ].join("\n");
