/**
 * Set in the dashboard under Settings -> Variables and Secrets.
 *
 * GHOST_SITES maps a hostname to its Content API key, which Ghost itself calls safe to expose —
 * it only ever reaches public data — so this can be a plain variable rather than a secret:
 *
 *   { "www.lamestream.com.au": { "key": "79b548ddd5142126203cac8f8f" } }
 *
 * The optional `cookie` and `cookie_sig` on an entry are a shared member session for that site,
 * kept for the sites that had one before per-person sign-in existed. They apply to everybody on
 * the connector, so prefer ghost_login: it gives each person their own session, and reads paid
 * posts on their own subscription rather than on somebody else's.
 */
interface Env {
  GHOST_SITES?: string | Record<string, unknown>;
  /** Older single-site setup, honoured when GHOST_SITES has no entry for the host. */
  GHOST_CONTENT_KEY?: string;
}
