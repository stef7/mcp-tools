/**
 * Set in the dashboard under Settings -> Variables and Secrets; `keep_vars` keeps it across
 * deploys.
 *
 * ICON_URL (plain text) is the https address of the image served as the icon. It lives in the
 * dashboard so that which image it is stays out of this repo. Unset, every request is a 404.
 */
interface Env {
  ICON_URL?: string;
}
