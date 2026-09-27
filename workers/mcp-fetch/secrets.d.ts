/**
 * APIFY_PROXY_PASSWORD pays for the middle route in core/egress.ts: Apify's Unblocker, for
 * when the tunnel is down. It is the password on Apify Console -> Proxy, not an
 * API token, and it only works from outside Apify on a paid plan. Set it in the dashboard under
 * Settings -> Variables and Secrets. Leave it unset and that route is skipped — pages go straight
 * from Cloudflare instead.
 */
interface Env {
  APIFY_PROXY_PASSWORD?: string;
}
