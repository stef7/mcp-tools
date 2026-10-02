#!/usr/bin/env node
/**
 * Can a Worker do TLS itself through Apify's Unblocker? Unblocker re-signs HTTPS, so the Worker
 * would need Apify's signing certificate to trust, and the handshake must fit subtls: TLS 1.3,
 * TLS_AES_128_GCM_SHA256, P-256, and ECDSA-P256-SHA256 or RSA-PSS-SHA256 signatures.
 *
 *   read -rs APIFY_PROXY_PASSWORD; export APIFY_PROXY_PASSWORD
 *   node scripts/apify-tls-probe.mjs [host]
 *
 * Prints what the proxy negotiates under those limits (and without them, if they fail), then the
 * certificates it sent, as PEM. Certificates are public; the password is never printed.
 */
import http from "node:http";
import tls from "node:tls";

const host = process.argv[2] ?? "example.com";
const proxyHost = process.env.PROBE_PROXY_HOST ?? "proxy.apify.com";
const proxyPort = Number(process.env.PROBE_PROXY_PORT ?? 8000);
const user = process.env.PROBE_PROXY_USER ?? "groups-UNBLOCKER";
const password = process.env.APIFY_PROXY_PASSWORD;

const SUBTLS = {
  minVersion: "TLSv1.3",
  maxVersion: "TLSv1.3",
  ciphers: "TLS_AES_128_GCM_SHA256",
  ecdhCurve: "P-256",
  sigalgs: "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256",
};

const tunnel = () =>
  new Promise((resolve, reject) => {
    const headers = password
      ? { "Proxy-Authorization": "Basic " + Buffer.from(`${user}:${password}`).toString("base64") }
      : {};
    http
      .request({
        host: proxyHost,
        port: proxyPort,
        method: "CONNECT",
        path: `${host}:443`,
        headers,
      })
      .on("connect", (res, socket) =>
        res.statusCode === 200 ? resolve(socket) : reject(new Error(`CONNECT ${res.statusCode}`)),
      )
      .on("error", reject)
      .end();
  });

const handshake = async (limits) => {
  const socket = await tunnel();
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: host, rejectUnauthorized: false, ...limits }, () =>
      resolve(s),
    );
    s.on("error", reject);
  });
};

const pem = (der) =>
  `-----BEGIN CERTIFICATE-----\n${der
    .toString("base64")
    .match(/.{1,64}/g)
    .join("\n")}\n-----END CERTIFICATE-----`;

let s;
try {
  s = await handshake(SUBTLS);
  console.log("subtls limits: OK");
} catch (e) {
  console.log(`subtls limits: FAILED (${e.message})`);
  s = await handshake({});
}
const key = s.getEphemeralKeyInfo();
console.log(`negotiated: ${s.getProtocol()} ${s.getCipher().standardName} ${key.name ?? key.type}`);
console.log(`trusted by this machine: ${s.authorized ? "yes" : `no (${s.authorizationError})`}`);

const seen = new Set();
for (
  let c = s.getPeerCertificate(true);
  c?.raw && !seen.has(c.fingerprint256);
  c = c.issuerCertificate
) {
  seen.add(c.fingerprint256);
  console.log(
    `\nsubject: ${c.subject?.CN ?? JSON.stringify(c.subject)}\nissuer:  ${c.issuer?.CN ?? JSON.stringify(c.issuer)}`,
  );
  console.log(pem(c.raw));
}
s.destroy();
