/** Secrets are set in the dashboard, so `wrangler types` cannot see them. Declared here instead. */
interface Env {
  /**
   * Logins for sites you may edit, as JSON. Two shapes, both optional, mixed freely:
   *
   *   { "apil.au": { "user": "claude-mcp", "pass": "abcd efgh ijkl" } }          shared
   *   { "you@example.com": { "apil.au": { "user": "...", "pass": "..." } } }     per person
   *
   * `pass` is a WordPress Application Password (Users -> Profile -> Application Passwords).
   * A key containing "@" is an email, anything else is a hostname, so the shapes never collide.
   * With Cloudflare Access on, the email is the signed-in identity and cannot be spoofed.
   * Sites absent from the secret stay read-only.
   */
  WP_SITES?: string;
}
