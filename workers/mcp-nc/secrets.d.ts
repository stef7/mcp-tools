/** Set in the dashboard or with wrangler, so `wrangler types` cannot see them. Declared here. */
interface Env {
  /**
   * The Nextcloud to use when the connector URL names none: https://cloud.example.com, or with a
   * folder, https://example.com/nextcloud. A plain variable, so you can read it back. A
   * connector URL that names one (`/https://…` or `?nc=`) still wins for that connector.
   */
  NC_URL?: string;
  /**
   * A Nextcloud app password (Personal settings -> Security -> Devices & sessions), for
   * connectors that send only a login name, in X-API-Key. A secret:
   * `npx wrangler secret put NC_PASSWORD`. It is sent to NC_URL as Basic auth and to no other
   * host, whatever a connector URL names, and no tool result, error or log line carries it. A
   * connector that sends a whole login in X-Auth-Token does not use it.
   */
  NC_PASSWORD?: string;
}
