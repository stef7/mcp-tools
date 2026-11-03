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

/**
 * Give a page a `<base>` of its own URL, so a converter resolves `report.pdf` on /a/b/page to
 * /a/b/report.pdf the way a browser would. A page that already names its own base keeps it.
 */
export const withBase = (html: string, url: string) => {
  if (/<base\s[^>]*href\s*=/i.test(html)) return html;
  const tag = `<base href="${url.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
  const head = /<head(\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, (m) => m + tag) : tag + html;
};

/** Cut to `max` characters on a word boundary, marking that something was left out. */
export const truncate = (s = "", max = 800) =>
  s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "") + "…";

/**
 * The outer HTML of every element `selector` matches, cut from the page exactly as the server
 * sent it, in document order. A match inside another match is already part of the outer one, so
 * it is not repeated. Selectors are whatever HTMLRewriter accepts; an invalid one throws.
 *
 * HTMLRewriter cannot hand back an element's markup, so each match is fenced with comments
 * carrying a nonce the page cannot contain, and the pieces are cut out between the fences.
 */
export const selectHtml = async (html: string, selector: string): Promise<string[]> => {
  const nonce = crypto.randomUUID();
  const open = `<!--select-open-${nonce}-->`;
  const close = `<!--select-close-${nonce}-->`;
  const fenced = await new HTMLRewriter()
    .on(selector, {
      element(el) {
        el.before(open, { html: true });
        try {
          el.onEndTag((end) => {
            end.after(close, { html: true });
          });
        } catch {
          // A void element (<img>, <hr>…) has no end tag to wait for.
          el.after(close, { html: true });
        }
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html" } }))
    .text();
  const out: string[] = [];
  const fence = new RegExp(`${open}|${close}`, "g");
  let depth = 0;
  let start = 0;
  for (const m of fenced.matchAll(fence)) {
    if (m[0] === open) {
      if (depth++ === 0) start = m.index + open.length;
    } else if (depth > 0 && --depth === 0) {
      out.push(fenced.slice(start, m.index));
    }
  }
  // An element the page never closed runs to the end of the document.
  if (depth > 0) out.push(fenced.slice(start));
  return out.map((s) => s.replaceAll(open, "").replaceAll(close, ""));
};

/** The selector for the element a URL's #fragment points at, or null if it has none. */
export const fragmentSelector = (url: string) => {
  const hash = url.split("#")[1];
  if (!hash) return null;
  let id: string;
  try {
    id = decodeURIComponent(hash);
  } catch {
    id = hash;
  }
  // An attribute selector, not `#id`, so an id starting with a digit or holding a dot still works.
  return id ? `[id="${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]` : null;
};
