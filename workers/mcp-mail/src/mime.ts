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

/** `Fw: Fwd: FW: subject` -> `subject`. */
export const unforward = (subject = "") => subject.replace(/^(\s*(fwd?|fw)\s*:\s*)+/i, "");

/**
 * What a mail client writes when you forward inline. Either a header block:
 *
 *   ------- Forwarded Message -------          (Proton, older)
 *   ---------- Forwarded message ---------     (Gmail)
 *   -----Original Message-----                 (Outlook)
 *   From: Name <a@b>
 *   Date: …
 *   Subject: …
 *
 * or an attribution line, which is what Proton writes now:
 *
 *   -------- Original Message --------
 *   On Wednesday, 11/04/26 at 21:44 Name <a@b> wrote:
 *
 * Returns who the forwarded mail was from, its date and subject where given, and `note`: whatever
 * the forwarder wrote above it. Nothing when there is no such block.
 */
export const forwardedBlock = (text: string) => {
  const marker = /^[>\s]*-{2,}\s*(?:Original Message|Forwarded [Mm]essage)\s*-{2,}\s*$/m.exec(text);
  if (!marker) return undefined;
  const found: Record<string, string> = {};
  const note = text.slice(0, marker.index).trim();
  const lines = text.slice(marker.index + marker[0].length).split("\n");
  for (const line of lines.slice(0, 15)) {
    const clean = line
      .replace(/^[>\s]*/, "")
      .replace(/\*/g, "")
      .trim();
    if (!clean) {
      if (Object.keys(found).length) break; // the blank line that ends the block
      continue;
    }
    const header = /^(From|Date|Sent|Subject|To):\s*(.*)$/i.exec(clean);
    if (header) {
      const key = header[1]!.toLowerCase();
      found[key === "sent" ? "date" : key] = header[2]!.trim();
      continue;
    }
    // "On <date>[,] Name <a@b> wrote:" — the sender is the last "Name <address>" before "wrote:".
    // The date ends at its time (Proton: "at 21:44 Name <a@b>") or at its last comma (Gmail).
    const said =
      /^On\s+(.+?\d{1,2}[:.]\d{2}(?:\s?[ap]\.?m\.?)?),?\s+([^,<]*<[^>]+>)\s*wrote:\s*$/i.exec(
        clean,
      ) ?? /^On\s+(.+),\s*([^,<]*<[^>]+>)\s*wrote:\s*$/i.exec(clean);
    if (said && !found["from"]) {
      found["from"] = said[2]!.trim();
      found["date"] ??= said[1]!.trim().replace(/,$/, "");
      break;
    }
    if (!Object.keys(found).length) break; // something else first: not a forward block
  }
  if (!found["from"]) return undefined;
  return { ...found, ...(note ? { note } : {}) } as {
    from: string;
    date?: string;
    subject?: string;
    to?: string;
    note?: string;
  };
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type When = {
  /** For reading: `4 Nov 2026`. */
  date: string;
  /** `21:44`, when the text gave a time. */
  time: string | null;
  /** For sorting and filing: `2026-11-04`. */
  iso: string;
};

const pad = (n: number) => String(n).padStart(2, "0");
const when = (y: number, m: number, d: number, time: string | null): When | undefined => {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d)
    return undefined;
  return { date: `${d} ${SHORT[m - 1]} ${y}`, time, iso: `${y}-${pad(m)}-${pad(d)}` };
};
const weekdayOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** `9:44 PM`, `21:44`, `21.44` -> `21:44`. */
const timeIn = (s: string) => {
  const m = /\b(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?\b/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const half = m[3]?.toLowerCase();
  if (half === "p" && h < 12) h += 12;
  if (half === "a" && h === 12) h = 0;
  return h < 24 ? `${pad(h)}:${m[2]}` : null;
};

/**
 * A date as a mail client writes it, made unambiguous. Handles a header with a time zone
 * (`Sat, 21 Nov 2026 12:08:01 +0000`, shown in Melbourne time), month names in either order
 * (`Nov 4, 2026`, `4 November 2026`), and the numeric form Proton uses on phones
 * (`Wednesday, 11/04/26 at 21:44`), where the weekday decides between month-first and
 * day-first; with no weekday to go on, a part over 12 decides, and otherwise month-first.
 */
export const normaliseDate = (text: string | null | undefined): When | undefined => {
  if (!text) return undefined;
  const s = text.trim();

  // A header date carries its own offset: show it as Melbourne sees it.
  if (/[+-]\d{4}\b|\bGMT\b|\bUTC\b|Z$/.test(s) && !Number.isNaN(Date.parse(s))) {
    const parts = new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Melbourne",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(s));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return when(get("year"), get("month"), get("day"), `${pad(get("hour"))}:${pad(get("minute"))}`);
  }

  const time = timeIn(s);
  const yearOf = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

  // Month written as a word, either side of the day.
  const name = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/i.exec(s);
  if (name) {
    const m = MONTHS.indexOf(name[1]!.toLowerCase()) + 1;
    const rest = s.slice(0, name.index) + " " + s.slice(name.index + name[0].length);
    const year = /\b(\d{4})\b/.exec(rest)?.[1];
    const day = /\b(\d{1,2})(?:st|nd|rd|th)?\b(?![:.]\d)/.exec(rest.replace(/\b\d{4}\b/, ""))?.[1];
    if (year && day) return when(Number(year), m, Number(day), time);
  }

  // Numeric a/b/y: let the weekday, then a part over 12, decide the order.
  const num = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(s);
  if (num) {
    const a = Number(num[1]);
    const b = Number(num[2]);
    const y = yearOf(num[3]!);
    const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*/i.exec(s)?.[1]?.toLowerCase();
    const monthFirst = when(y, a, b, time);
    const dayFirst = when(y, b, a, time);
    if (wd) {
      const want = WEEKDAYS.indexOf(wd);
      if (monthFirst && weekdayOf(y, a, b) === want) return monthFirst;
      if (dayFirst && weekdayOf(y, b, a) === want) return dayFirst;
    }
    if (a > 12) return dayFirst;
    return monthFirst ?? dayFirst;
  }

  if (!Number.isNaN(Date.parse(s))) {
    const d = new Date(s);
    return when(d.getFullYear(), d.getMonth() + 1, d.getDate(), time);
  }
  return undefined;
};
