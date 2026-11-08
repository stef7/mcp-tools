/**
 * Set in the dashboard under Settings -> Variables and Secrets. Both optional. Sessions are not
 * configured here at all: each administrator pastes their own Helios cookie on /login, and it
 * lives in the SESSIONS KV namespace against their Cloudflare Access email (see session.ts).
 */
interface Env {
  /** Default Helios server; the connector's `?helios=` overrides it. */
  HELIOS_URL?: string;
  /** Only if a self-hosted Helios renamed Django's "sessionid" cookie. */
  HELIOS_COOKIE_NAME?: string;
}
