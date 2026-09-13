/** Bits every worker that touches the open web ends up needing. */

/**
 * For third-party sites that refuse or challenge anything that does not look like a browser.
 * A worker talking to a site that *should* recognise it sends its own name instead — see the
 * `User-Agent` mcp-wp sets, which exists so a site can allowlist it.
 */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0 Safari/537.36";

/**
 * HTML to readable plain text. Block endings become line breaks so paragraphs survive, scripts
 * and styles go entirely, and the entities WordPress emits are decoded rather than left raw.
 */
export const stripHtml = (html = "") =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;/g, "’")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#8230;/g, "…")
    .replace(/&#0?38;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#?\w+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Cut to `max` characters on a word boundary, marking that something was left out. */
export const truncate = (s = "", max = 800) =>
  s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "") + "…";
