/**
 * Set these in the dashboard under Settings -> Variables and Secrets; `keep_vars` keeps them
 * across deploys.
 *
 * APIFY_PROXY_PASSWORD (secret) pays for the `smart` route in core/egress.ts. It is the
 * password on Apify Console -> Proxy, not an API token, and it only works from outside Apify on a
 * paid plan. Unset, that route is skipped.
 *
 * EGRESS_VIA (plain text, optional) is the order routes are tried in when a call does not say,
 * e.g. `tunnel,smart`. Unset, it is `smart`. Cloudflare's own fetch is always the fallback after
 * them and is not named.
 */
interface Env {
  APIFY_PROXY_PASSWORD?: string;
  EGRESS_VIA?: string;
}
