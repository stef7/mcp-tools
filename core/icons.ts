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
const icon = (body: string): Icon => ({
  src:
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' + body + "</svg>",
    ),
  mimeType: "image/svg+xml",
  sizes: ["any"],
});

const mark = (colour: string, glyph: string): Icon => {
  // Spread, not `.length`: an emoji is a surrogate pair, and would count as two glyphs.
  const [size, y] = FIT[[...glyph].length] ?? [7, 14.5];
  return icon(
    `<rect width="24" height="24" rx="5" fill="${colour}"/>` +
      `<text x="12" y="${y}" fill="#fff" font-family="sans-serif" font-weight="700"` +
      ` font-size="${size}" text-anchor="middle">${glyph}</text>`,
  );
};

/**
 * The real WordPress mark, three times the size of a drawn one, so it is worth paying for once —
 * on the server, where someone picking a connector sees it — rather than on each of a site's
 * twenty tools. Blue on white, because the ring and the W are a single shape: fill that white and
 * all you get is a white disc. The path is broken across lines at fixed width, never on a space:
 * the spaces in it separate numbers, and losing one silently joins two coordinates into one.
 */
const WORDPRESS_LOGO = icon(
  '<rect width="24" height="24" rx="5" fill="#fff"/>' +
    '<path fill="#21759b" transform="translate(2.4 2.4) scale(.8)" d="' +
    "M21.469 6.825c.84 1.537 1.318 3.3 1.318 5.175 0 3.979-2.156 7.456-5.363 9.325l3." +
    "295-9.527c.615-1.54.82-2.771.82-3.864 0-.405-.026-.78-.07-1.11m-7.981.105c.647-." +
    "03 1.232-.105 1.232-.105.582-.075.514-.93-.067-.899 0 0-1.755.135-2.88.135-1.064" +
    " 0-2.85-.15-2.85-.15-.585-.03-.661.855-.075.885 0 0 .54.061 1.125.09l1.68 4.605-" +
    "2.37 7.08L5.354 6.9c.649-.03 1.234-.1 1.234-.1.585-.075.516-.93-.065-.896 0 0-1." +
    "746.138-2.874.138-.2 0-.438-.008-.69-.015C4.911 3.15 8.235 1.215 12 1.215c2.809 " +
    "0 5.365 1.072 7.286 2.833-.046-.003-.091-.009-.141-.009-1.06 0-1.812.923-1.812 1" +
    ".914 0 .89.513 1.643 1.06 2.531.411.72.89 1.643.89 2.977 0 .915-.354 1.994-.821 " +
    "3.479l-1.075 3.585-3.9-11.61.001.014zM12 22.784c-1.059 0-2.081-.153-3.048-.437l3" +
    ".237-9.406 3.315 9.087c.024.053.05.101.078.149-1.12.393-2.325.609-3.582.609M1.21" +
    "1 12c0-1.564.336-3.05.935-4.39L7.29 21.709C3.694 19.96 1.212 16.271 1.211 12M12 " +
    "0C5.385 0 0 5.385 0 12s5.385 12 12 12 12-5.385 12-12S18.615 0 12 0" +
    '"/>',
);

/** Keyed by worker, so `icon: ICONS.ghost` is the whole of what a worker has to say about it. */
export const ICONS = {
  toolkit: mark("#111827", "🛠"),
  wordpress: mark("#21759b", "W"),
  wordpressLogo: WORDPRESS_LOGO,
  fetch: mark("#0284c7", "F"),
  archives: mark("#6d28d9", "AR"),
  unDocs: mark("#4b92db", "UN"),
  abcSearch: mark("#0a7cff", "ABC"),
  abcOmbudsman: mark("#c4122e", "ABC"),
  dataGovAu: mark("#006544", "AU"),
  ghost: mark("#15171a", "G"),
  apify: mark("#ff9012", "AP"),
};
