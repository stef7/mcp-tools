/** Set in the dashboard (Settings -> Variables and Secrets), so `wrangler types` cannot see them. */
interface Env {
  /**
   * Who may send mail in: comma-separated envelope senders. A whole address (`me@proton.me`) or a
   * domain (`@proton.me`), or `*` for any sender, which leaves the routed address itself as the
   * only gate (so make it one nobody would guess). Kept out of this public repo, so set it in the
   * dashboard. Unset, every message is refused. `*` means nothing in MAIL_READERS.
   */
  MAIL_ALLOWED_FROM?: string;
  /**
   * Who may read: comma-separated Cloudflare Access emails. Checked by the worker itself on every
   * tool call, on top of the Access policy, so a policy that is loosened, switched off or bypassed
   * by a service binding still reads nothing. Unset, every tool refuses.
   */
  MAIL_READERS?: string;
}
