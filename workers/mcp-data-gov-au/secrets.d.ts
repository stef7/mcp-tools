/**
 * Both are optional and set in the dashboard under Settings -> Variables and Secrets.
 *
 * CKAN_API_TOKEN is only needed if data.gov.au starts refusing anonymous SQL; get one from
 * your account under My API Tokens. DATA_GOV_AU_TOKEN is accepted as an older name for it.
 * CKAN_BASE repoints the whole worker at another CKAN site, e.g. discover.data.vic.gov.au.
 */
interface Env {
  CKAN_API_TOKEN?: string;
  DATA_GOV_AU_TOKEN?: string;
  CKAN_BASE?: string;
}
