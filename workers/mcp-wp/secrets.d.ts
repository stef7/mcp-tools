/** Set in the dashboard, so `wrangler types` cannot see them. Declared here instead. */
interface Env {
  /**
   * Who may edit what, as JSON. A plain variable, not a secret, so you can read it back and
   * edit it. Keyed by Cloudflare Access email, then by hostname, then the WordPress username:
   *
   *   {
   *     "you@example.com": { "apil.au": "claude-mcp" },
   *     "paul@example.com": { "apil.au": "paul-mcp", "example.org": "paul" }
   *   }
   *
   * The password lives in its own secret, named after the host: apil.au -> WP_PASS_APIL_AU.
   * Where two people use different logins on one host, name the secret explicitly instead:
   *
   *   { "you@example.com": { "apil.au": { "user": "claude-mcp", "pass": "WP_PASS_APIL_STEF" } } }
   *
   * Passwords are WordPress Application Passwords (Users -> Profile -> Application Passwords).
   * There is no shared fallback: a site nobody is listed against is read-only, and so is every
   * site if Cloudflare Access is off, because then no identity reaches the worker.
   */
  WP_SITES?: string;
}
// The WP_PASS_<HOST> secrets are looked up by a name built at runtime, so they cannot be
// declared here; credsFor reads them through a single narrow cast.
