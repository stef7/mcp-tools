/**
 * APIFY_TOKEN pays for the middle route in core/egress.ts: a page through Apify's Australian
 * residential proxies when the tunnel is down. Set it in the dashboard under Settings -> Variables
 * and Secrets. Leave it unset and that route is skipped — pages go straight from Cloudflare
 * instead. Secrets are per worker, so this is a separate copy from mcp-apify's, and it needs
 * permission to run Actors, which mcp-apify's read-only token should not have.
 */
interface Env {
  APIFY_TOKEN?: string;
}
