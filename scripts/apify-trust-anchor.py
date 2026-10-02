#!/usr/bin/env python3
"""
Makes the certificate core/apify-ca.ts trusts, from certificates Apify's Unblocker presented.

Unblocker re-signs HTTPS with a key it calls "Apify Proxy CA", but sends only the site's
certificate, never its own, and Apify does not publish it. An ECDSA signature gives away the
signer's public key up to two candidates; two certificates signed by the same key share exactly
one. That key is checked against every certificate given, then wrapped in a certificate under
Apify's name, with the CA flag and long dates, so subtls can use it as a trusted root.

The wrapper is signed with a throwaway key, since Apify's private key is not ours. subtls never
checks a trusted root's own signature: like RFC 5280 (6.1.1 d), it takes a trust anchor to be a
name and a public key.

    python3 scripts/apify-trust-anchor.py leaf1.pem leaf2.pem [...] > anchor.pem

Get the leaves with scripts/apify-tls-probe.mjs, for two or more different sites. Needs the
`cryptography` package.
"""
import datetime
import hashlib
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.x509.oid import NameOID

# NIST P-256
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)
ECDSA_SHA256 = "1.2.840.10045.4.3.2"


def add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    if p1[0] == p2[0] and (p1[1] + p2[1]) % P == 0:
        return None
    if p1 == p2:
        slope = (3 * p1[0] * p1[0] + A) * pow(2 * p1[1], -1, P) % P
    else:
        slope = (p2[1] - p1[1]) * pow(p2[0] - p1[0], -1, P) % P
    x = (slope * slope - p1[0] - p2[0]) % P
    return (x, (slope * (p1[0] - x) - p1[1]) % P)


def mul(k, point):
    out = None
    while k:
        if k & 1:
            out = add(out, point)
        point = add(point, point)
        k >>= 1
    return out


def signers(cert):
    """Every P-256 public key that could have made this certificate's signature."""
    if cert.signature_algorithm_oid.dotted_string != ECDSA_SHA256:
        sys.exit(f"{cert.subject.rfc4514_string()}: not signed with ECDSA and SHA-256")
    r, s = decode_dss_signature(cert.signature)
    e = int.from_bytes(hashlib.sha256(cert.tbs_certificate_bytes).digest(), "big") % N
    found = set()
    for x in (r, r + N):
        if x >= P:
            continue
        y2 = (pow(x, 3, P) + A * x + B) % P
        y = pow(y2, (P + 1) // 4, P)
        if y * y % P != y2:
            continue
        for point in ((x, y), (x, P - y)):
            found.add(mul(pow(r, -1, N), add(mul(s, point), mul(-e % N, G))))
    return found


def main(paths):
    if len(paths) < 2:
        sys.exit("Give two or more leaf certificates, for different sites.")
    leaves = [x509.load_pem_x509_certificate(open(p, "rb").read()) for p in paths]
    issuers = {leaf.issuer for leaf in leaves}
    if len(issuers) != 1:
        sys.exit("The certificates name different issuers.")
    keys = set.intersection(*(signers(leaf) for leaf in leaves))
    if len(keys) != 1:
        sys.exit(f"{len(keys)} keys fit every signature; expected exactly one.")
    (x, y) = keys.pop()
    key = ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()
    for leaf in leaves:  # the library's own check, independent of the arithmetic above
        key.verify(leaf.signature, leaf.tbs_certificate_bytes, ec.ECDSA(hashes.SHA256()))

    name = issuers.pop()
    throwaway = ec.generate_private_key(ec.SECP256R1())
    anchor = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc))
        .not_valid_after(datetime.datetime(2050, 1, 1, tzinfo=datetime.timezone.utc))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(throwaway, hashes.SHA256())
    )
    spki = key.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    print(f"issuer: {name.rfc4514_string()}", file=sys.stderr)
    print(f"key SHA-256 (SPKI): {hashlib.sha256(spki).hexdigest()}", file=sys.stderr)
    print(f"verified against {len(leaves)} certificates", file=sys.stderr)
    sys.stdout.write(anchor.public_bytes(serialization.Encoding.PEM).decode())


if __name__ == "__main__":
    main(sys.argv[1:])
