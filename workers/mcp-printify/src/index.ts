/**
 * mcp-printify — Printify's REST API -> MCP, as three tools rather than one per endpoint.
 *
 *   printify_search        find operations in Printify's API description by keyword
 *   printify_call          run one, by method and path, validated against that description
 *   printify_upload_image  put artwork in the media library from a URL
 *
 * The API description is Printify's own OpenAPI document, trimmed and vendored into src/spec.json
 * by scripts/vendor-printify-spec.mjs. It ships in the bundle; nothing fetches it at runtime.
 *
 * One Printify account per worker: a personal access token in the PRINTIFY_TOKEN secret, which
 * no tool result, error or log carries. Who may use the worker is Cloudflare Access's business,
 * as for every worker here. Like mcp-helios it is not bound into mcp-toolkit: it acts on one
 * person's shops, so it gets its own URL and its own Access policy.
 *
 * GET runs freely. Anything else needs `confirm: true` and restates what it sent. Every write to
 * an order (creating, sending to production, cancelling, refunds, reprints, address changes),
 * deleting or unpublishing a product, deleting a shop, archiving an upload and changing webhooks
 * are refused unless PRINTIFY_ALLOW_DESTRUCTIVE is "true" (see tools.ts and secrets.d.ts).
 */
import cfg from "../wrangler.json";
import { version } from "../package.json";
import { mcpWorker } from "../../../core/mcp";
import { ALLOW, printifyTools, report } from "./tools";

export default mcpWorker({
  ...cfg,
  version,
  tools: printifyTools(),
  /** Opening the URL in a browser says whether the spec loaded and whether Printify answers. */
  status: (c) => report(c),
  info: () => ({
    title: "Printify",
    description: "Printify shops, catalogue, products, uploads and orders.",
    websiteUrl: "https://developers.printify.com",
    instructions:
      "Printify through three tools. printify_search finds an operation and shows its " +
      "parameters and body; printify_call runs it. Typical path to a product: GET " +
      "/v1/shops.json for the shop id; GET /v1/catalog/blueprints.json with find to get a " +
      "blueprint by name; its print_providers.json, then that provider's variants.json and " +
      "shipping.json; printify_upload_image for the artwork; POST " +
      "/v1/shops/{shop_id}/products.json with blueprint_id, print_provider_id, variants " +
      "(id, price in cents) and print_areas placing the image; PUT to change title, " +
      "description or price; POST .../publish.json to publish it to the shop's sales channel. " +
      "Every call but GET needs confirm: true, given only after the user has agreed to that " +
      "exact request. Never guess an ID: read it first. Creating, producing, cancelling, " +
      "refunding, reprinting or readdressing orders, deleting or unpublishing products, " +
      `deleting shops, archiving uploads and changing webhooks are off unless ${ALLOW} ` +
      "is enabled on the worker; say so rather than looking for another way.",
  }),
});
