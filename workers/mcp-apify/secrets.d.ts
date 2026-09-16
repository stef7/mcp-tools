/**
 * APIFY_TOKEN is a personal API token from Apify Console -> Settings -> API & Integrations.
 * Set it in the dashboard under Settings -> Variables and Secrets.
 *
 * These three tools only read; a token scoped to nothing but account reads would be enough, and
 * is worth preferring over a full-access one. mcp-ytt holds a token under the same name, but
 * secrets are per worker — this one needs its own copy.
 */
interface Env {
  APIFY_TOKEN?: string;
}
