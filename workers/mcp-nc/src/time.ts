/**
 * Dates and time zones, the part of a calendar that goes wrong quietly.
 *
 * Three kinds of time reach this worker, and they are kept apart rather than guessed between:
 *
 *   date     2026-11-20                 an all-day date, no clock
 *   wall     2026-11-20T10:00           a clock reading, meaningless until a time zone is named
 *   instant  2026-11-20T10:00+11:00     a moment, the same everywhere
 *
 * A wall time is held as "the epoch milliseconds of that clock reading, read as UTC", so plain
 * arithmetic adds hours and days to it. Zones are IANA names and the runtime's own tables do the
 * conversions; nothing here knows a rule about daylight saving.
 */
export type When =
  { kind: "date"; wall: number } | { kind: "wall"; wall: number } | { kind: "instant"; ms: number };

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

const INPUT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/i;

/** What a caller typed -> a When. `what` names the argument in the error. */
export const parseWhen = (text: string, what: string): When => {
  const m = INPUT.exec(text.trim());
  const bad = () =>
    new Error(
      `${what}: "${text}" is not a date this understands. Use 2026-11-20 for an all-day date, ` +
        "2026-11-20T10:00 for a time in the event's time zone, or 2026-11-20T10:00+11:00 for " +
        "an exact moment.",
    );
  if (!m) throw bad();
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(
    Number,
  ) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(wall);
  // Date.UTC rolls 31 February into March; a date that does not survive the trip was never one.
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59)
    throw bad();
  if (m[4] === undefined) return { kind: "date", wall };
  const zone = m[7];
  if (!zone) return { kind: "wall", wall };
  if (zone.toUpperCase() === "Z") return { kind: "instant", ms: wall };
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
  return { kind: "instant", ms: wall - offset };
};

const formats = new Map<string, Intl.DateTimeFormat>();
const formatFor = (tz: string) => {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(tz, f);
  }
  return f;
};

/** Whether the runtime knows this zone. Outlook's "AUS Eastern Standard Time" is not one. */
export const validZone = (tz: string) => {
  try {
    formatFor(tz);
    return true;
  } catch {
    return false;
  }
};

/** How far ahead of UTC the zone's clocks are at this instant, in milliseconds. */
export const offsetAt = (ms: number, tz: string) => {
  const p: Record<string, string> = {};
  for (const part of formatFor(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  const wall = Date.UTC(
    Number(p["year"]),
    Number(p["month"]) - 1,
    Number(p["day"]),
    Number(p["hour"]),
    Number(p["minute"]),
    Number(p["second"]),
  );
  return wall - Math.floor(ms / 1000) * 1000;
};

export const instantToWall = (ms: number, tz: string) => ms + offsetAt(ms, tz);

/**
 * A clock reading in a zone -> the moment it names. The offset is looked up twice because the
 * first guess is made at the wrong instant; the second lands right except inside the hour a
 * clock change skips, where no answer is right and this one is at most an hour out.
 */
export const wallToInstant = (wall: number, tz: string) => {
  const first = wall - offsetAt(wall, tz);
  return wall - offsetAt(first, tz);
};

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const parts = (wall: number) => {
  const d = new Date(wall);
  return {
    date: `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  };
};

/** 2026-11-20, from a wall time. */
export const isoDate = (wall: number) => parts(wall).date;

/** 2026-11-20T10:00:00+11:00: an instant as the clocks in `tz` showed it. */
export const isoIn = (ms: number, tz: string) => {
  const offset = offsetAt(ms, tz);
  const { date, time } = parts(ms + offset);
  if (offset === 0) return `${date}T${time}Z`;
  const minutes = Math.abs(offset) / 60_000;
  return `${date}T${time}${offset < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
};

/** iCalendar's own spellings: 20261120 and 20261120T100000. */
export const icalDate = (wall: number) => parts(wall).date.replaceAll("-", "");
export const icalDateTime = (wall: number) =>
  `${icalDate(wall)}T${parts(wall).time.replaceAll(":", "")}`;

const ICAL = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i;

/** An iCalendar DATE or DATE-TIME value -> a When, or null for anything else. */
export const parseIcal = (value: string): When | null => {
  const m = ICAL.exec(value.trim());
  if (!m) return null;
  const wall = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  );
  if (m[4] === undefined) return { kind: "date", wall };
  return m[7] ? { kind: "instant", ms: wall } : { kind: "wall", wall };
};

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

/** PT1H30M -> milliseconds, signed. Null for what is not a duration. */
export const parseDuration = (value: string): number | null => {
  const m = DURATION.exec(value.trim());
  if (!m) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const ms = n(2) * 7 * DAY + n(3) * DAY + n(4) * HOUR + n(5) * 60_000 + n(6) * 1000;
  return m[1] === "-" ? -ms : ms;
};
