/**
 * The inbox: D1 for the messages, R2 for the bytes. The tables make themselves the first time they
 * are touched, and new columns are added the same way, so there is no migration step to forget.
 * Nothing here deletes a row or an object.
 */
import { addressOf, forwardedBlock, parseMail, unforward } from "./mime";

/**
 * Limits for D1 alone, used only when no R2 bucket is bound (as in older deployments). D1 holds up
 * to 2 MB a row; the raw message is kept only when it fits well inside that.
 */
export const RAW_LIMIT = 1_000_000;
/** Without R2, an attachment is kept when it fits in one D1 row (2 MB); a bigger one is listed. */
export const ATTACHMENT_LIMIT = 1_900_000;
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
  `CREATE TABLE IF NOT EXISTS attachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mail_id INTEGER NOT NULL REFERENCES mail (id),
    filename TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB
  )`,
  "CREATE INDEX IF NOT EXISTS attachment_mail ON attachment (mail_id)",
];

/** Columns added after the tables first shipped. Each runs once; "duplicate column" means done. */
const COLUMNS = [
  "ALTER TABLE mail ADD COLUMN raw_key TEXT",
  "ALTER TABLE attachment ADD COLUMN r2_key TEXT",
];

let ready: Promise<unknown> | undefined;
export const ensure = (db: D1Database) =>
  (ready ??= (async () => {
    await db.batch(SCHEMA.map((s) => db.prepare(s)));
    for (const sql of COLUMNS)
      await db
        .prepare(sql)
        .run()
        .catch((e) => {
          if (!/duplicate column/i.test(String(e))) throw e;
        });
  })().catch((e) => {
    ready = undefined; // try again next time rather than remembering a failure
    throw e;
  }));

/** A filename made safe for an R2 key. The real name stays in D1. */
const keyName = (name: string) => name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";

export type Incoming = { from: string; to: string; raw: Uint8Array; receivedAt?: Date };

/**
 * Files one message. Returns its id, or the id it already had if this Message-ID was seen.
 *
 * With a bucket, the raw message and every attachment go to R2 first, under fresh random keys, and
 * only then is the row written. If R2 fails nothing is in D1, so the bounce and the sender's retry
 * start clean; the other order would leave a row whose retry `INSERT OR IGNORE` skips, losing the
 * files for good. An object left behind by a failed insert is never read and costs nothing much.
 */
export const save = async (db: D1Database, files: R2Bucket | undefined, m: Incoming) => {
  await ensure(db);
  const p = parseMail(m.raw);
  const fwd = forwardedBlock(p.text);
  const inner = p.inner;
  const originalFrom = inner?.get("from") ?? fwd?.from ?? p.headers.get("from") ?? m.from;
  const originalDate = inner?.get("date") ?? fwd?.date ?? p.headers.get("date") ?? null;
  const subject =
    inner?.get("subject") ??
    fwd?.subject ??
    (inner || fwd ? unforward(p.headers.get("subject")) : p.headers.get("subject")) ??
    "";
  const text = p.text.length > TEXT_LIMIT ? p.text.slice(0, TEXT_LIMIT) : p.text;
  const messageId = p.headers.get("message-id") ?? null;

  const stem = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}`;
  const rawKey = files ? `${stem}/message.eml` : null;
  const kept = p.attachments
    .filter((a) => a.data)
    .map((a, i) => ({ ...a, key: files ? `${stem}/${i}-${keyName(a.filename)}` : null }));
  if (files)
    await Promise.all([
      files.put(rawKey!, m.raw, { httpMetadata: { contentType: "message/rfc822" } }),
      ...kept.map((a) => files.put(a.key!, a.data!, { httpMetadata: { contentType: a.type } })),
    ]);

  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO mail (received_at, envelope_from, envelope_to, header_from,
        original_from, original_date, subject, date_header, message_id, text, text_truncated,
        attachments, auth, raw, raw_size, raw_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify(p.attachments.map(({ data: _, ...meta }) => meta)),
      p.headers.get("arc-authentication-results") ??
        p.headers.get("authentication-results") ??
        null,
      files || m.raw.length > RAW_LIMIT ? null : m.raw,
      m.raw.length,
      rawKey,
    )
    .run();
  if (inserted.meta.changes) {
    const id = inserted.meta.last_row_id;
    if (kept.length)
      await db.batch(
        kept.map((a) =>
          db
            .prepare(
              `INSERT INTO attachment (mail_id, filename, type, size, data, r2_key)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              id,
              a.filename,
              a.type,
              a.size,
              a.key || a.size > ATTACHMENT_LIMIT ? null : a.data!,
              a.key,
            ),
        ),
      );
    return { id, duplicate: false };
  }
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

/** D1 hands a BLOB back as an ArrayBuffer or as an array of numbers, depending on the runtime. */
export const bytesFrom = (v: unknown) =>
  v instanceof ArrayBuffer
    ? new Uint8Array(v)
    : v instanceof Uint8Array
      ? v
      : Uint8Array.from(v as ArrayLike<number>);

export const base64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
