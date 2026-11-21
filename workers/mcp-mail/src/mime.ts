/**
 * Just enough MIME to file an email: headers (folded, RFC 2047 encoded words), multipart walked
 * to its first text/plain and text/html, base64 and quoted-printable undone in the part's own
 * charset, attachments kept with their bytes. A message/rfc822 part (a
 * "forward as attachment") is parsed too, since its headers say who the mail was really from.
 *
 * Written here rather than pulled from npm because no worker in this repo has dependencies of
 * its own: CI builds every worker with wrangler alone.
 */
import { stripHtml } from "../../../core/web";

export type Attachment = {
  filename: string;
  type: string;
  size: number;
  /** The decoded bytes; absent for an attached message, whose text is kept with the mail's. */
  data?: Uint8Array;
};
export type Parsed = {
  headers: Map<string, string>;
  text: string;
  attachments: Attachment[];
  /** The headers of a message attached whole (forward as attachment), if there was one. */
  inner?: Map<string, string> | undefined;
};

/** Bytes to a string holding one char per byte, so offsets survive the round trip. */
const binary = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

const decodeBytes = (bytes: Uint8Array, charset = "utf-8") => {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // an unknown charset: best effort
  }
};

const unBase64 = (s: string) => {
  try {
    return bytesOf(atob(s.replace(/[^A-Za-z0-9+/=]/g, "")));
  } catch {
    return bytesOf(s);
  }
};
const unQP = (s: string) =>
  bytesOf(
    s
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
  );

/** `=?utf-8?B?…?=` and `=?iso-8859-1?Q?…?=` in a header, with the space between two words gone. */
export const decodeWords = (value: string) =>
  value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, data: string) =>
      decodeBytes(
        enc.toUpperCase() === "B" ? unBase64(data) : unQP(data.replace(/_/g, " ")),
        cs.split("*")[0],
      ),
    );

const splitHead = (raw: string): [string, string] => {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ""];
};

export const parseHeaders = (head: string) => {
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(i + 1).trim()); // the first one wins
  }
  return headers;
};

/** `text/plain; charset="utf-8"; name=a.txt` -> value plus lower-cased parameters. */
const params = (value = "") => {
  const [first = "", ...rest] = value.split(";");
  const p: Record<string, string> = {};
  for (const part of rest) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    p[part.slice(0, i).trim().toLowerCase().replace(/\*$/, "")] = part
      .slice(i + 1)
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/^[\w-]+''/, ""); // RFC 2231 charset'' prefix
  }
  return { value: first.trim().toLowerCase(), p };
};

type Walk = {
  plain?: string;
  html?: string;
  attachments: Attachment[];
  inner?: Map<string, string>;
  innerText?: string;
};

const walk = (raw: string, out: Walk, depth = 0) => {
  if (depth > 10) return; // a pathological nest is not worth following
  const [head, body] = splitHead(raw);
  const h = parseHeaders(head);
  const type = params(h.get("content-type") ?? "text/plain");
  const disposition = params(h.get("content-disposition"));
  const encoding = (h.get("content-transfer-encoding") ?? "").toLowerCase();

  if (type.value.startsWith("multipart/") && type.p["boundary"]) {
    const marker = "--" + type.p["boundary"];
    const parts = body.split(marker).slice(1);
    for (const part of parts) {
      if (part.startsWith("--")) break; // the closing marker
      walk(part.replace(/^\r?\n/, ""), out, depth + 1);
    }
    return;
  }

  const bytes =
    encoding === "base64"
      ? unBase64(body)
      : encoding === "quoted-printable"
        ? unQP(body)
        : bytesOf(body);
  const filename = decodeWords(disposition.p["filename"] ?? type.p["name"] ?? "");

  if (type.value === "message/rfc822") {
    // Its text is the forwarded mail, which is the point, so it is kept beside the outer text.
    const inner = binary(bytes);
    const sub: Walk = { attachments: out.attachments };
    walk(inner, sub, depth + 1);
    if (!out.inner) {
      out.inner = parseHeaders(splitHead(inner)[0]);
      out.innerText = sub.plain ?? stripHtml(sub.html ?? "");
    }
    out.attachments.push({
      filename: filename || "(attached message)",
      type: type.value,
      size: bytes.length,
    });
    return;
  }
  const isAttachment = disposition.value === "attachment" || !!filename;
  if (!isAttachment && type.value === "text/plain" && out.plain === undefined) {
    out.plain = decodeBytes(bytes, type.p["charset"]);
  } else if (!isAttachment && type.value === "text/html" && out.html === undefined) {
    out.html = decodeBytes(bytes, type.p["charset"]);
  } else if (isAttachment || !type.value.startsWith("text/")) {
    out.attachments.push({
      filename: filename || "(unnamed)",
      type: type.value,
      size: bytes.length,
      data: bytes,
    });
  }
};

export const parseMail = (raw: Uint8Array): Parsed => {
  const s = binary(raw);
  const out: Walk = { attachments: [] };
  walk(s, out);
  const headers = parseHeaders(splitHead(s)[0]);
  for (const [k, v] of headers) headers.set(k, decodeWords(v));
  if (out.inner) for (const [k, v] of out.inner) out.inner.set(k, decodeWords(v));
  const own = out.plain ?? stripHtml(out.html ?? "");
  const text = (out.innerText ? `${own}\n\n--- Attached message ---\n${out.innerText}` : own)
    .replace(/\r\n/g, "\n")
    .trim();
  return { headers, text, attachments: out.attachments, inner: out.inner };
};

/** The bare address in `Name <a@b>` or `a@b`, lower-cased. */
export const addressOf = (value = "") =>
  (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();

/**
 * The header block a mail client writes when you forward inline:
 *
 *   ------- Forwarded Message -------          (Proton)
 *   ---------- Forwarded message ---------     (Gmail)
 *   -----Original Message-----                 (Outlook)
 *   From: Name <a@b>
 *   Date: …
 *   Subject: …
 *
 * Returns what it says about the mail you forwarded, or nothing when there is no such block.
 */
export const forwardedBlock = (text: string) => {
  const marker = /^[>\s]*-{2,}\s*(?:Original Message|Forwarded [Mm]essage)\s*-{2,}\s*$/m.exec(text);
  if (!marker) return undefined;
  const found: Record<string, string> = {};
  const lines = text.slice(marker.index + marker[0].length).split("\n");
  for (const line of lines.slice(0, 15)) {
    const clean = line.replace(/^[>\s]*/, "").replace(/\*/g, "");
    if (!clean.trim()) {
      if (Object.keys(found).length) break; // the blank line that ends the block
      continue;
    }
    const m = /^(From|Date|Sent|Subject|To):\s*(.*)$/i.exec(clean);
    if (m) found[m[1]!.toLowerCase() === "sent" ? "date" : m[1]!.toLowerCase()] = m[2]!.trim();
  }
  return found["from"] ? found : undefined;
};
