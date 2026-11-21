/** Set in the dashboard (Settings -> Variables and Secrets), so `wrangler types` cannot see them. */
interface Env {
  /**
   * Who may send mail in: comma-separated envelope senders, a whole address (`me@proton.me`) or a
   * domain (`@proton.me`). Unset or `*` means anyone, which leaves the routed address itself as
   * the only gate, so make it one nobody would guess. Set it in the dashboard to narrow it.
   * `*` means nothing in MAIL_READERS, which must always list readers.
   */
  MAIL_ALLOWED_FROM?: string;
  /**
   * Who may read: comma-separated Cloudflare Access emails. Checked by the worker itself on every
   * tool call, on top of the Access policy, so a policy that is loosened, switched off or bypassed
   * by a service binding still reads nothing. Unset, every tool refuses.
   */
  MAIL_READERS?: string;
}
