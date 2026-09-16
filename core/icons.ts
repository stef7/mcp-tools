/**
 * One mark per worker: a coloured rounded square with a white glyph.
 *
 * They are deliberately tiny. Every tool carries its own icon, so a toolkit listing forty tools
 * pays for forty of these, and a real brand logo runs five times the size of a whole mark here.
 * They are written as SVG rather than pasted in as base64 so that changing one stays a text edit.
 *
 * Served inline as `data:` URIs. The protocol would rather an icon URL sat on the server's own
 * domain, but these servers are behind Cloudflare Access, which would answer a client's image
 * request with a login page. A `data:` URI is explicitly allowed and needs nobody signed in.
 */
export type Icon = { src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" };

/** Font size and baseline per glyph count: one glyph is large, three are small. */
const FIT: Record<number, [number, number]> = { 1: [15, 17.4], 2: [11, 16], 3: [8, 15] };

/** Percent-encoded rather than base64: it is shorter, and base64 cannot carry an emoji. */
const mark = (colour: string, glyph: string): Icon => {
  // Spread, not `.length`: an emoji is a surrogate pair, and would count as two glyphs.
  const [size, y] = FIT[[...glyph].length] ?? [7, 14.5];
  return {
    src:
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
          `<rect width="24" height="24" rx="5" fill="${colour}"/>` +
          `<text x="12" y="${y}" fill="#fff" font-family="sans-serif" font-weight="700"` +
          ` font-size="${size}" text-anchor="middle">${glyph}</text></svg>`,
      ),
    mimeType: "image/svg+xml",
    sizes: ["any"],
  };
};

/** Keyed by worker, so `icon: ICONS.ghost` is the whole of what a worker has to say about it. */
export const ICONS = {
  toolkit: mark("#111827", "🛠"),
  wordpress: mark("#21759b", "W"),
  fetch: mark("#0284c7", "F"),
  archives: mark("#6d28d9", "AR"),
  unDocs: mark("#4b92db", "UN"),
  abcSearch: mark("#0a7cff", "ABC"),
  abcOmbudsman: mark("#c4122e", "ABC"),
  dataGovAu: mark("#006544", "AU"),
  ghost: mark("#15171a", "G"),
  apify: mark("#ff9012", "AP"),
};
