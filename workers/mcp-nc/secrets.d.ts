/** Set with wrangler, so `wrangler types` cannot see them. Declared here. */
interface Env {
  /**
   * The Nextcloud address, login name and app password, encrypted (AES-256-GCM) by
   * scripts/seal-nextcloud.mjs. A secret: `npx wrangler secret put NC_SEALED`. The key that
   * opens it is not on the worker. It arrives in the connector's X-Token header with each
   * request and is kept nowhere, so this value alone gives nothing away, and no tool result,
   * error or log line carries what is inside it.
   *
   * A connector that names its Nextcloud in the URL and sends a whole login in X-Auth-Token
   * does not use it.
   */
  NC_SEALED?: string;
}
