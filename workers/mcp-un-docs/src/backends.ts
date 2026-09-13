/**
 * The four services behind mcp-un-docs, and the bits of parsing they each need. Every one of
 * them is a public read-only API; none takes a key.
 */
import { stripHtml, truncate } from "../../../core/web";

export const UA = "UN-Docs-MCP/1.0";
export const UNISPAL = "https://www.un.org/unispal/wp-json/wp/v2";
export const UNDL = "https://digitallibrary.un.org";

export const get = (url: URL | string) => fetch(url, { headers: { "User-Agent": UA } });
/** Same, but asking only for the headers — used to follow ODS's redirect to a PDF. */
export const head = (url: URL | string) =>
  fetch(url, { method: "HEAD", redirect: "follow", headers: { "User-Agent": UA } });

/**
 * HTML to markdown-ish text: links keep their target and list items keep their bullet, which
 * `stripHtml` alone would throw away. Everything after that is the shared cleanup.
 */
export const toMarkdown = (html = "") =>
  stripHtml(
    html
      .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<hr\s*\/?>/gi, "\n---\n"),
  );

export { truncate };

/**
 * Pull a UN document symbol out of a title: A/80/492, A/HRC/60/CRP.3, S/RES/2334,
 * ST/AI/189/Add.3/Rev.2, CCPR/C/130/D/2728/2016 all match.
 */
export const symbolIn = (text = "") =>
  text.match(/\b([A-Z]{1,5}(?:\/[A-Z0-9]+(?:\.[A-Z0-9]+)*)+)\b/)?.[1];

/** UNISPAL is a WordPress site, so a failed request has a body worth quoting back. */
export const wpFail = async (res: Response) => ({
  error: `UNISPAL ${res.status}: ${await res.text().catch(() => res.statusText)}`,
});

/** UN Digital Library file descriptions are in the language they name. */
export const UNDL_LANG: Record<string, string> = {
  العربية: "ar",
  中文: "zh",
  English: "en",
  Français: "fr",
  Русский: "ru",
  Español: "es",
};

/** `A_HRC_55_73-EN.pdf` is how UNDL spells the symbol A/HRC/55/73. */
export const symbolFromFile = (name: string) =>
  name
    .replace(/\.pdf$/i, "")
    .replace(/-[A-Z]{2}$/, "")
    .replace(/_/g, "/");
