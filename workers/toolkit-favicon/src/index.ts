/**
 * The icon paths of the bare domain above the toolkit's connector hostname, answered with the
 * toolkit's icon. PUBLIC ON PURPOSE, and only those paths.
 *
 * WHY. Claude.ai ignores the icons an MCP server declares for a custom connector
 * (anthropics/claude-ai-mcp#152) and asks Google's favicon service about the connector URL's
 * last two labels instead (#838). So a connector at toolkit.example.com is drawn with whatever
 * example.com offers, and the toolkit itself sits behind Access, where a crawler gets a login.
 *
 * NEITHER THE DOMAIN NOR THE IMAGE IS IN THIS REPO, deliberately. The routes are set in the
 * dashboard (`<bare domain>/favicon*` and `<bare domain>/apple-touch-icon*`), and so is ICON_URL,
 * the image this passes through. It is fetched through Cloudflare's cache for a day, so its
 * source is asked about once a day per data centre, not once per request. Anything that is not
 * an image is refused rather than served under this domain. A redirect rule on that domain has
 * to skip these paths, because redirect rules run before any Worker.
 */
const DAY = 86_400;
const notFound = () => new Response("Not found", { status: 404 });

export default {
  async fetch(_request, env): Promise<Response> {
    const src = env.ICON_URL?.trim();
    if (!src?.startsWith("https://")) return notFound();
    const upstream = await fetch(src, { cf: { cacheTtl: DAY, cacheEverything: true } });
    const type = upstream.headers.get("Content-Type") ?? "";
    if (!upstream.ok || !type.startsWith("image/")) return notFound();
    return new Response(upstream.body, {
      headers: { "Content-Type": type, "Cache-Control": `public, max-age=${DAY}` },
    });
  },
} satisfies ExportedHandler<Env>;
