// Right to Know runs Alaveteli. Request, authority and user pages have a JSON twin (`.json`),
// but message bodies and attachments are only in the HTML, and search is only an Atom feed.
// Everything here is plain string work so it can be tested outside a Worker.

export const ORIGIN = "https://www.righttoknow.org.au";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1),
      );
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** HTML to readable text: paragraphs and line breaks kept, everything else dropped. */
export const htmlToText = (html: string): string =>
  decode(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      // Alaveteli writes "\n<br />", so take the source newline with it.
      .replace(/\s*<br\s*\/?>\s*/gi, "\n")
      .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const abs = (href: string) => new URL(decode(href), ORIGIN).href;
const first = (s: string, re: RegExp) => s.match(re)?.[1];

// ---------------------------------------------------------------- feeds

export type FeedEntry = {
  event_id: number;
  published: string;
  title: string;
  /** "Response", "Request sent", "Clarification sent", "Follow up sent"… */
  event: string;
  status?: string | undefined;
  authority?: string | undefined;
  authority_slug?: string | undefined;
  requester?: string | undefined;
  requester_slug?: string | undefined;
  snippet?: string | undefined;
  /** Redirects to the request; pass it to `righttoknow_request`. */
  url: string;
};

export const parseFeed = (xml: string): FeedEntry[] =>
  [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const e = m[1] ?? "";
    const content = decode(first(e, /<content[^>]*>([\s\S]*?)<\/content>/) ?? "");
    const who = first(content, /class="requester">([\s\S]*?)<\/div>/) ?? "";
    const body = who.match(/href="[^"]*\/body\/([^"/]+)"[^>]*>([\s\S]*?)<\/a>/);
    const user = who.match(/href="[^"]*\/user\/([^"/]+)"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = first(content, /class="desc">([\s\S]*?)<\/span>/);
    return {
      event_id: +(first(e, /InfoRequestEvent\/(\d+)/) ?? 0),
      published: first(e, /<published>([^<]+)/) ?? "",
      title: decode(first(e, /<title[^>]*>([\s\S]*?)<\/title>/) ?? ""),
      event: first(htmlToText(who), /^([\s\S]*?)\s+(?:by|to)\s/) ?? "",
      status: htmlToText(first(content, /<strong>([\s\S]*?)<\/strong>/) ?? "") || undefined,
      authority: body ? htmlToText(body[2] ?? "") : undefined,
      authority_slug: body?.[1],
      requester: user ? htmlToText(user[2] ?? "") : undefined,
      requester_slug: user?.[1],
      snippet: snippet ? htmlToText(snippet) : undefined,
      url: abs(first(e, /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) ?? ""),
    };
  });

// ---------------------------------------------------------------- correspondence

export type Attachment = {
  name: string;
  size?: string | undefined;
  url: string;
  view_url?: string | undefined;
};
export type Message = {
  id: string;
  direction: "incoming" | "outgoing";
  author: string;
  date: string;
  text: string;
  truncated?: boolean | undefined;
  attachments: Attachment[];
  link: string;
};

const parseAttachments = (block: string): Attachment[] =>
  [...block.matchAll(/<li class="attachment"[\s\S]*?<\/li>/g)].map(([li = ""]) => ({
    name: htmlToText(first(li, /class="attachment__name">([\s\S]*?)<\/p>/) ?? ""),
    size: first(li, /class="attachment__meta">\s*([^<\s]+)/),
    url: abs(first(li, /href="([^"]*\/attach\/(?!html\/)[^"]*)"/) ?? ""),
    view_url: ((v) => v && abs(v))(first(li, /href="([^"]*\/attach\/html\/[^"]*)"/)),
  }));

/** Every message on a request page, oldest first. Annotations and the sidebar are ignored. */
export const parseCorrespondence = (html: string, pageUrl: string): Message[] =>
  html
    .split(/(?=<div class="(?:incoming|outgoing) correspondence)/)
    // A zero-width split at index 0 yields no empty first piece, so filter rather than slice.
    .filter((chunk) => chunk.startsWith("<div class="))
    .map((chunk) => {
      const [, direction, num] = chunk.match(/id="(incoming|outgoing)-(\d+)"/) ?? [];
      let body =
        first(chunk, /<div class="correspondence_text">([\s\S]*?)<p class="event_actions">/) ?? "";
      const attachBlock =
        first(
          body,
          /(<div class="attachments">[\s\S]*?attachments__show-more[^>]*><\/a>\s*<\/div>)/,
        ) ?? "";
      body = body
        .replace(attachBlock, "")
        .replace(/<span class="unfold_link">[\s\S]*?<\/span>/g, "");
      return {
        id: `${direction}-${num}`,
        direction: direction as Message["direction"],
        author: htmlToText(
          first(chunk, /correspondence__header__author[^>]*>([\s\S]*?)<\/span>/) ?? "",
        ).replace(/\s*\n\s*/g, " "),
        date: first(chunk, /<time datetime="([^"]+)"/) ?? "",
        text: htmlToText(body),
        attachments: parseAttachments(attachBlock),
        link: `${pageUrl.split(/[?#]/)[0]}#${direction}-${num}`,
      };
    })
    .filter((m) => m.direction);

// ---------------------------------------------------------------- references

/**
 * Accepts a slug, a numeric request id, or any Right to Know URL for a request or one of its
 * events. Returns either the slug, or a path that redirects to it.
 */
export const requestRef = (input: string): { slug: string } | { redirect: string } => {
  const s = input.trim();
  if (/^\d+$/.test(s)) return { redirect: `/request/${s}` };
  if (!/^https?:|^\//.test(s)) return { slug: s };
  const path = new URL(s, ORIGIN).pathname;
  const slug = first(path, /^\/request\/([^/]+)/);
  if (slug) return /^\d+$/.test(slug) ? { redirect: `/request/${slug}` } : { slug };
  if (/^\/request_event\/\d+/.test(path)) return { redirect: path };
  throw new Error(`Not a Right to Know request reference: ${input}`);
};

/** `anu`, `/body/anu` or a full URL to `anu`. Works for users too. */
export const slugOf = (input: string, kind: "body" | "user"): string => {
  const s = input.trim();
  return first(s, new RegExp(`/${kind}/([^/?#.]+)`)) ?? s;
};
