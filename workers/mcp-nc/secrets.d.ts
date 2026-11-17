/** Set in the dashboard or with wrangler, so `wrangler types` cannot see them. Declared here. */
interface Env {
  /**
   * The Nextcloud to use when the connector URL names none: https://cloud.example.com, or with a
   * folder, https://example.com/nextcloud. A plain variable, or a secret if the address itself
   * should not be readable (`npx wrangler secret put NC_URL`): no result, error or status line
   * repeats it. A connector URL that names one (`/https://…` or `?nc=`) still wins for that
   * connector.
   */
  NC_URL?: string;
  /**
   * A Nextcloud app password (Personal settings -> Security -> Devices & sessions), for
   * connectors that send only a login name, in X-Account-Id. A secret:
   * `npx wrangler secret put NC_PASSWORD`. It is sent as Basic auth only to an address the
   * worker vouches for (NC_URL, or one matching NC_URL_SHA256), whatever a request names, and no
   * tool result, error or log line carries it. A connector that sends a whole login in
   * X-Auth-Token does not use it.
   */
  NC_PASSWORD?: string;
  /**
   * The SHA-256, in hex, of the one Nextcloud address NC_PASSWORD may also be sent to. It lets
   * the address itself live only in the connector's X-Tenant header: the worker then holds a
   * password and this fingerprint, and no address. Hash the address as the worker normalises
   * it: scheme and host in lower case, any folder, no trailing slash.
   *
   *   printf %s 'https://cloud.example.com' | sha256sum
   */
  NC_URL_SHA256?: string;
}
