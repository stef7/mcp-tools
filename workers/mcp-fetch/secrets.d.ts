/**
 * Set these in the dashboard under Settings -> Variables and Secrets; `keep_vars` keeps them
 * across deploys.
 *
 * APIFY_PROXY_PASSWORD (secret) pays for the `unblocker` route in core/egress.ts. It is the
 * password on Apify Console -> Proxy, not an API token, and it only works from outside Apify on a
 * paid plan. Unset, that route is skipped.
 *
 * EGRESS_VIA (plain text, optional) is the order routes are tried in when a call does not say,
 * e.g. `tunnel,unblocker,direct`. Unset, it is `unblocker,direct`.
 */
interface Env {
  APIFY_PROXY_PASSWORD?: string;
  EGRESS_VIA?: string;
}
