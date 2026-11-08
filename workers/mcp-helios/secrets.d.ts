/**
 * Set in the dashboard under Settings -> Variables and Secrets. All optional: the public tools
 * need nothing, and an administrator can send their cookie per request instead (see index.ts).
 *
 * Helios has no API tokens. vote.heliosvoting.org signs administrators in with Google or GitHub,
 * so the only credential is the Django session cookie of a browser that has logged in. A cookie
 * is that person on Helios until they log out, so keep these as secrets, never variables.
 */
interface Env {
  /**
   * Session cookies by Cloudflare Access email, so each administrator acts as themselves:
   *   { "me@example.com": "<sessionid value>", "ro@example.org": "<sessionid value>" }
   * A value may also be an object `{ "cookie": "...", "url": "https://helios.example.org" }`
   * for someone whose Helios is not the connector's default.
   */
  HELIOS_SESSIONS?: string | Record<string, unknown>;
  /** One shared session, used when HELIOS_SESSIONS has no entry for the caller. */
  HELIOS_SESSION?: string;
  /** Default Helios server; the connector's `?helios=` overrides it. */
  HELIOS_URL?: string;
  /** Only if a self-hosted Helios renamed Django's "sessionid" cookie. */
  HELIOS_COOKIE_NAME?: string;
}
