/**
 * Secrets, set in the dashboard under Settings -> Variables and Secrets. Both are needed only
 * by `save_wayback` and `save_status`; everything else reads the public Wayback APIs.
 * Get a pair at https://archive.org/account/s3.php.
 */
interface Env {
  IA_ACCESS_KEY?: string;
  IA_SECRET_KEY?: string;
}
