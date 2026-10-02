/**
 * core/apify-ca.ts holds a key recovered from signatures, not one Apify published. This checks it
 * the way subtls will use it: its key verifies the signature on each certificate Unblocker
 * presented (test/fixtures/apify-leaf-*.pem), and its name is theirs. A DER walk of its own keeps
 * the check independent of subtls.
 */
import { describe, expect, inject, it } from "vitest";
import { APIFY_PROXY_CA } from "../core/apify-ca";

/** One DER element: its tag, its contents, and everything it spans. */
type Tlv = { tag: number; body: Uint8Array; all: Uint8Array };

const tlv = (b: Uint8Array, at = 0): Tlv => {
  let len = b[at + 1]!;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[start + i]!;
    start += n;
  }
  return { tag: b[at]!, body: b.subarray(start, start + len), all: b.subarray(at, start + len) };
};

const children = (b: Uint8Array) => {
  const out: Tlv[] = [];
  for (let at = 0; at < b.length; at += out[out.length - 1]!.all.length) out.push(tlv(b, at));
  return out;
};

const der = (pem: string) =>
  Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));

/** Certificate ::= SEQUENCE { tbs, algorithm, signature BIT STRING } */
const parse = (pem: string) => {
  const [tbs, , sig] = children(tlv(der(pem)).body);
  // tbs: [0] version, serial, algorithm, issuer, validity, subject, subjectPublicKeyInfo, ...
  const fields = children(tbs!.body);
  return { tbs: tbs!, fields, signature: sig!.body.subarray(1) };
};

/** ECDSA-Sig-Value ::= SEQUENCE { r, s } to the fixed-width r ‖ s Web Crypto takes. */
const p1363 = (sig: Uint8Array) => {
  const out = new Uint8Array(64);
  children(tlv(sig).body).forEach((n, i) => {
    const v = n.body.subarray(Math.max(0, n.body.length - 32));
    out.set(v, i * 32 + 32 - v.length);
  });
  return out;
};

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("the Apify Proxy CA trusted by the smart route", () => {
  const anchor = parse(APIFY_PROXY_CA);
  const spki = anchor.fields[6]!.all;

  it("is the key recorded in core/apify-ca.ts", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spki));
    expect(hex(digest)).toBe("29bb5cee8f8509437f16dd113b2712ee7731bc32d33c862fbc36e8d4861291a8");
  });

  it("verifies every certificate Unblocker presented, and is named as their issuer", async () => {
    const key = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const leaves = inject("apifyLeaves");
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    for (const pem of leaves) {
      const leaf = parse(pem);
      expect(hex(leaf.fields[3]!.all)).toBe(hex(anchor.fields[5]!.all)); // issuer = subject
      const ok = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        p1363(leaf.signature),
        leaf.tbs.all,
      );
      expect(ok).toBe(true);
    }
  });

  it("does not verify a certificate it did not sign", async () => {
    const key = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const leaf = parse(inject("apifyLeaves")[0]!);
    const tampered = leaf.tbs.all.slice();
    tampered[tampered.length - 1]! ^= 1;
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      p1363(leaf.signature),
      tampered,
    );
    expect(ok).toBe(false);
  });
});
