/**
 * The certificate core/proxy.ts trusts for HTTPS through Apify's Unblocker.
 *
 * Unblocker re-signs every HTTPS site with its own key, "Apify Proxy CA", which no runtime trusts,
 * and Apify neither sends nor publishes that certificate. Its public key was recovered from the
 * signatures on two certificates Unblocker presented (test/fixtures/apify-leaf-*.pem), and
 * wrapped in a certificate under the same name by scripts/apify-trust-anchor.py. The wrapper's own
 * signature is from a throwaway key and is never checked: only the name and the key count.
 *
 *   key SHA-256 (SPKI): 29bb5cee8f8509437f16dd113b2712ee7731bc32d33c862fbc36e8d4861291a8
 *
 * If Apify changes its key, every https URL fails the unblocker route on the certificate. Run
 * scripts/apify-tls-probe.mjs for two sites and that script on the two certificates, then
 * replace this one.
 */
export const APIFY_PROXY_CA = `-----BEGIN CERTIFICATE-----
MIIBfDCCASKgAwIBAgIUFBu0ZLPdt7qde/VXyqm8N0cmXFowCgYIKoZIzj0EAwIw
KTEXMBUGA1UEAxMOQXBpZnkgUHJveHkgQ0ExDjAMBgNVBAoTBUFwaWZ5MCAXDTIw
MDEwMTAwMDAwMFoYDzIwNTAwMTAxMDAwMDAwWjApMRcwFQYDVQQDEw5BcGlmeSBQ
cm94eSBDQTEOMAwGA1UEChMFQXBpZnkwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AAT/dWEWYg+Qn0D6+RdirL7X4N3qcIaSQYwPy3yJCSIXid+JnzjQI2/g6s82eays
1Sp0lwOQhAB0LV/AmdSy2vT9oyYwJDASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1Ud
DwEB/wQEAwIChDAKBggqhkjOPQQDAgNIADBFAiEAuPLVy445nOaUVWBvBD+4I1K2
x1JatZ+ZzTBS09QudUICIHlXZvS0WKzGdUrbEjS3qh/937NIQOQlWXwfyB0dV7MG
-----END CERTIFICATE-----`;
