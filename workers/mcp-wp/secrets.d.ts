/** Set in the dashboard, so `wrangler types` cannot see them. Declared here instead. */
interface Env {
  /**
   * Who may edit what, as JSON. A plain variable, not a secret, so you can read it back and edit
   * it. Keyed by Cloudflare Access email, then by hostname. `user` is the WordPress login; `pass`
   * is the NAME OF THE SECRET holding that login's Application Password, never the password:
   *
   *   {
   *     "you@example.com":  { "apil.au": { "user": "claude-mcp", "pass": "APIL_CLAUDE" } },
   *     "paul@example.com": { "apil.au": { "user": "paul-mcp",   "pass": "APIL_PAUL" } }
   *   }
   *
   * Then two secrets, APIL_CLAUDE and APIL_PAUL, hold the passwords themselves. Names are yours
   * to choose and are used exactly as written — nothing is derived from the host or the username,
   * because sanitising those into one identifier would let different pairs collide.
   *
   * Passwords are WordPress Application Passwords (Users -> Profile -> Application Passwords),
   * not account passwords. There is no shared fallback: a site you are not listed against is
   * read-only, and so is everything if Cloudflare Access is off, because then no identity
   * reaches the worker.
   */
  WP_SITES?: string;
}
// The password secrets are looked up by a name read from WP_SITES at runtime, so they cannot be
// declared here; credsFor reads them through a single narrow cast.
