/** Set in the dashboard or with wrangler, so `wrangler types` cannot see them. Declared here. */
interface Env {
  /**
   * A Printify personal access token (Printify -> Account -> Connections -> Personal access
   * tokens). A secret: `npx wrangler secret put PRINTIFY_TOKEN`. It is sent to Printify as a
   * Bearer token and nowhere else; no tool result, error or log line carries it.
   */
  PRINTIFY_TOKEN?: string;
  /**
   * Only the exact string "true" lifts the block on creating orders or sending them to
   * production, deleting a product or disconnecting a shop, and changing webhooks. A plain
   * variable, so you can see at a glance that it is off. Leave it unset.
   */
  PRINTIFY_ALLOW_DESTRUCTIVE?: string;
  /** Somewhere other than https://api.printify.com. The tests point this at the mock. */
  PRINTIFY_API_URL?: string;
}
