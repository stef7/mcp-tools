/**
 * The inbox: one D1 table. The table makes itself the first time it is touched, so there is no
 * migration step to forget. Nothing here deletes a row.
 */
import { addressOf, forwardedBlock, parseMail } from "./mime";

/** D1 holds up to 2 MB a row; the raw message is kept only when it fits well inside that. */
export const RAW_LIMIT = 1_000_000;
/** Text beyond this is cut, and the row says so. */
export const TEXT_LIMIT = 400_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,
    envelope_from TEXT NOT NULL,
    envelope_to TEXT NOT NULL,
    header_from TEXT,
    original_from TEXT,
    original_date TEXT,
    subject TEXT,
    date_header TEXT,
    message_id TEXT UNIQUE,
    text TEXT,
    text_truncated INTEGER NOT NULL DEFAULT 0,
    attachments TEXT NOT NULL DEFAULT '[]',
    auth TEXT,
    raw BLOB,
    raw_size INTEGER NOT NULL,
    triaged INTEGER NOT NULL DEFAULT 0,
    triaged_at TEXT,
    note TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS mail_received ON mail (received_at)",
  "CREATE INDEX IF NOT EXISTS mail_triaged ON mail (triaged, received_at)",
];

let ready: Promise<unknown> | undefined;
export const ensure = (db: D1Database) =>
  (ready ??= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
    ready = undefined; // try again next time rather than remembering a failure
    throw e;
  }));

export type Incoming = { from: string; to: string; raw: Uint8Array; receivedAt?: Date };

/** Files one message. Returns its id, or the id it already had if this Message-ID was seen. */
export const save = async (db: D1Database, m: Incoming) => {
  await ensure(db);
  const p = parseMail(m.raw);
  const fwd = forwardedBlock(p.text);
  const inner = p.inner;
  const originalFrom = inner?.get("from") ?? fwd?.["from"] ?? p.headers.get("from") ?? m.from;
  const originalDate = inner?.get("date") ?? fwd?.["date"] ?? p.headers.get("date") ?? null;
  const subject = inner?.get("subject") ?? fwd?.["subject"] ?? p.headers.get("subject") ?? "";
  const text = p.text.length > TEXT_LIMIT ? p.text.slice(0, TEXT_LIMIT) : p.text;
  const messageId = p.headers.get("message-id") ?? null;

  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO mail (received_at, envelope_from, envelope_to, header_from,
        original_from, original_date, subject, date_header, message_id, text, text_truncated,
        attachments, auth, raw, raw_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      (m.receivedAt ?? new Date()).toISOString(),
      m.from.toLowerCase(),
      m.to.toLowerCase(),
      p.headers.get("from") ?? null,
      originalFrom,
      originalDate,
      subject,
      p.headers.get("date") ?? null,
      messageId,
      text,
      p.text.length > TEXT_LIMIT ? 1 : 0,
      JSON.stringify(p.attachments),
      p.headers.get("arc-authentication-results") ??
        p.headers.get("authentication-results") ??
        null,
      m.raw.length <= RAW_LIMIT ? m.raw : null,
      m.raw.length,
    )
    .run();
  if (inserted.meta.changes) return { id: inserted.meta.last_row_id, duplicate: false };
  const row = await db
    .prepare("SELECT id FROM mail WHERE message_id = ?")
    .bind(messageId)
    .first<{ id: number }>();
  return { id: row?.id ?? 0, duplicate: true };
};

/** `a@b.com, @proton.me` -> does this address match an entry. Unset matches nobody. */
export const listed = (list: string | undefined, address: string | undefined) => {
  if (!list || !address) return false;
  const a = addressOf(address);
  return list
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => (entry.startsWith("@") ? a.endsWith(entry) : a === entry));
};
