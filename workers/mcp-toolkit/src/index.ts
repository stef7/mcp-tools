/**
 * mcp-toolkit — one connector for everything.
 *
 * Its own tools live below; every worker listed under `services` in wrangler.json is merged in
 * automatically (tool names already carry the worker's prefix, e.g. `wp_search_posts`).
 *
 *  POST /                           every tool
 *  POST /?tools=wp,substack_search  only those (a prefix or an exact tool name)
 *  POST /?wp=apil.au,crikey.com.au  params are forwarded, so mcp-wp builds site tools
 *
 * A bound worker that is down loses its own tools and nothing else; the GET page names it.
 */
import cfg from "../wrangler.json";
import pkg from "../package.json";
import { mcpWorker, tool } from "../../../core/mcp";
import { BROWSER_UA as UA } from "../../../core/web";
const SUBSTACK = {
  top: "https://substack.com/api/v1/top/search",
  recent: "https://substack.com/api/v1/recent/search",
  post: "https://substack.com/api/v1/post/search",
  publication: "https://substack.com/api/v1/publication/search",
  people: "https://substack.com/api/v1/profile/search",
};

export default mcpWorker({
  ...cfg,
  // Its own three tools are not a "toolkit" of anything, so they carry no prefix. Everything
  // bound under `services` still arrives with its own.
  prefix: "",
  version: pkg.version,
  tools: {
    acast_episodes: tool({
      description:
        "Fetch episode metadata from an Acast podcast. " +
        "Returns titles, dates, durations, and MP3 URLs.",
      input: {
        type: "object",
        required: ["show"],
        properties: {
          show: {
            type: "string",
            description: "Acast show slug (e.g. 'lamestream', 'we-used-to-be-journos')",
          },
          limit: {
            type: "integer",
            description: "Max episodes to return (default 200)",
            default: 200,
          },
        },
      },
      async run({ show, limit }) {
        const res = await fetch(`https://acastaway.deno.dev/${show}?limit=${limit}`);
        return res.ok ? res.json() : { error: `Acast returned ${res.status}` };
      },
    }),
    substack_search: tool({
      description:
        "Search Substack. Modes: 'top' and 'recent' return across the platform; 'post', " +
        "'publication', 'people' are paginated faceted searches. Returns raw Substack API JSON.",
      input: {
        type: "object",
        required: ["query", "mode"],
        properties: {
          query: {
            type: "string",
            description:
              "Search query. Wrap in double quotes for exact phrase, e.g. '\"press club\"'.",
          },
          mode: {
            type: "string",
            enum: ["top", "recent", "post", "publication", "people"],
            description: "Which Substack search endpoint to hit.",
          },
          page: {
            type: "integer",
            description: "Page number for paginated modes (post/publication/people). Default 0.",
            default: 0,
          },
        },
      },
      async run({ query, mode, page }) {
        const url = new URL(SUBSTACK[mode]);
        url.searchParams.set("query", query);
        if (mode === "post" || mode === "publication" || mode === "people")
          url.searchParams.set("page", String(page));
        if (mode === "post") url.search += "&includePlatformResults=true&filter=all";
        const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
        return res.ok ? res.json() : { error: `Substack returned ${res.status}`, url: url.href };
      },
    }),
    substack_latest: tool({
      description:
        "Fetch the raw RSS/XML feed for any Substack publication (or any site with a /feed " +
        "endpoint). Pass the publication's base URL, e.g. 'https://www.deepcutnews.com'. " +
        "Returns the unmodified XML as a string.",
      input: {
        type: "object",
        required: ["base_url"],
        properties: {
          base_url: {
            type: "string",
            description: "Publication base URL, e.g. 'https://www.deepcutnews.com'.",
          },
        },
      },
      async run({ base_url }) {
        const url = new URL("/feed", base_url);
        const res = await fetch(url, {
          headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml" },
        });
        return res.ok ? res.text() : { error: `Feed returned ${res.status}`, url: url.href };
      },
    }),
  },
});
