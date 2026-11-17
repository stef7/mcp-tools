/**
 * The calendar tools, and the rules about what may be written.
 *
 *   reading                    runs freely
 *   anything that writes       needs user_confirmed (the core enforces it)
 *   an event with attendees    also needs notify_attendees, because Nextcloud emails them
 *
 * An event is changed by editing the properties asked about inside the object as stored, and
 * saving it only if the server still holds the version that was read. Whatever this worker does
 * not understand (attendees, attachments, another client's X- properties) goes back untouched.
 */
import { tool, type Ctx, type Tools } from "../../../core/mcp";
import {
  baseOf,
  connOf,
  createCalendar,
  discover,
  eventByUid,
  eventsBetween,
  homeBase,
  listCalendars,
  moveStored,
  putNew,
  putOver,
  updateCalendar,
  zoneParam,
  type Calendar,
  type Conn,
} from "./dav";
import {
  all,
  clone,
  escapeText,
  get,
  param,
  parse,
  remove,
  serialise,
  set,
  splitList,
  text,
  unescapeText,
  type Comp,
  type Prop,
} from "./ical";
import {
  DAY,
  HOUR,
  icalDate,
  icalDateTime,
  instantToWall,
  isoDate,
  isoIn,
  parseDuration,
  parseIcal,
  parseWhen,
  validZone,
  wallToInstant,
  type When,
} from "./time";

const PRODID = "-//mcp-tools//mcp-nc//EN";
const MAX_RANGE_DAYS = 800;
const LIST_DESCRIPTION_CHARS = 300;

// ─── Time zones ────────────────────────────────────────────────────────────────────────────────

const NO_ZONE =
  "has no UTC offset, and no time zone is known for it. Pass timezone (an IANA name such as " +
  "Australia/Melbourne), or put ?tz=Australia/Melbourne on the connector URL.";

/** The zone a call asked for, else the connector's `?tz=`. Undefined when neither is set. */
const zoneFor = (arg: string | undefined, c: Ctx) => {
  const zone = arg?.trim() || zoneParam(c.params);
  if (zone && !validZone(zone))
    throw new Error(`"${zone}" is not a time zone name. Use an IANA name: Australia/Melbourne.`);
  return zone;
};

/** A property's own TZID, when it is one the runtime knows. */
const zoneOf = (p: Prop | undefined) => {
  const tzid = p && param(p, "TZID");
  return tzid && validZone(tzid) ? tzid : undefined;
};

/** A When as epoch milliseconds, reading clock times and dates in `zone`. */
const toMs = (w: When, zone: string) => (w.kind === "instant" ? w.ms : wallToInstant(w.wall, zone));

/** A stored DTSTART-like property -> when it is. Null when the value is unreadable. */
const moment = (p: Prop | undefined, fallback: string) => {
  const w = p && parseIcal(p.value);
  if (!w) return null;
  if (w.kind === "date") return { allDay: true, wall: w.wall, ms: toMs(w, fallback) };
  return { allDay: false, wall: 0, ms: toMs(w, zoneOf(p) ?? fallback) };
};

/** A When -> the property that stores it: a DATE, a clock time in a named zone, or UTC. */
const stamp = (name: string, w: When, zone: string | undefined, what: string): Prop => {
  if (w.kind === "date") return { name, params: ";VALUE=DATE", value: icalDate(w.wall) };
  if (zone && zone !== "UTC") {
    const wall = w.kind === "wall" ? w.wall : instantToWall(w.ms, zone);
    return { name, params: `;TZID=${zone}`, value: icalDateTime(wall) };
  }
  if (w.kind === "wall" && zone !== "UTC") throw new Error(`${what} ${NO_ZONE}`);
  return { name, params: "", value: `${icalDateTime(w.kind === "wall" ? w.wall : w.ms)}Z` };
};

const put = (c: Comp, p: Prop) => set(c, p.name, p.value, p.params);
const nowStamp = () => `${icalDateTime(Date.now())}Z`;

// ─── Showing an event ──────────────────────────────────────────────────────────────────────────

const span = (ev: Comp, zone: string) => {
  const start = moment(get(ev, "DTSTART"), zone);
  if (!start) return null;
  const dtend = moment(get(ev, "DTEND"), zone);
  const duration = parseDuration(get(ev, "DURATION")?.value ?? "");
  // No end at all means a day for an all-day event and no length for a timed one.
  const length = dtend
    ? start.allDay
      ? dtend.wall - start.wall
      : dtend.ms - start.ms
    : (duration ?? (start.allDay ? DAY : 0));
  return { start, length: Math.max(length, 0) };
};

/** Minutes before the start, for the common kind of reminder; the raw trigger otherwise. */
const reminders = (ev: Comp) =>
  ev.comps
    .filter((c) => c.name === "VALARM")
    .map((alarm) => {
      const trigger = get(alarm, "TRIGGER");
      const ms = trigger && !/RELATED=END/i.test(trigger.params) && parseDuration(trigger.value);
      return typeof ms === "number" && ms <= 0 ? -ms / 60_000 : (trigger?.value ?? "");
    });

const address = (p: Prop) => p.value.replace(/^mailto:/i, "");

/**
 * One VEVENT as a tool shows it. Times are given in `wanted` when the caller named a zone, else
 * in the event's own, else UTC. An all-day event's `end` is its last day, not the day after.
 */
const describe = (ev: Comp, calendar: string, wanted: string | undefined, full: boolean) => {
  const dtstart = get(ev, "DTSTART");
  const zone = wanted ?? zoneOf(dtstart) ?? "UTC";
  const s = span(ev, zone);
  const recurrence = get(ev, "RECURRENCE-ID");
  const occurrence = recurrence && parseIcal(recurrence.value);
  const description = text(ev, "DESCRIPTION");
  const attendees = all(ev, "ATTENDEE").map(address);
  const organizer = get(ev, "ORGANIZER");
  const alarms = reminders(ev);
  const categories = all(ev, "CATEGORIES").flatMap((p) => splitList(p.value));
  const foreign = dtstart && param(dtstart, "TZID") && !zoneOf(dtstart);
  return {
    calendar,
    uid: text(ev, "UID") ?? "",
    summary: text(ev, "SUMMARY") ?? "",
    ...(s
      ? s.start.allDay
        ? {
            all_day: true,
            start: isoDate(s.start.wall),
            end: isoDate(s.start.wall + Math.max(s.length - DAY, 0)),
          }
        : {
            start: isoIn(s.start.ms, zone),
            end: isoIn(s.start.ms + s.length, zone),
            timezone: zone,
          }
      : { problem: "This event has no readable start." }),
    ...(foreign
      ? {
          timezone_problem:
            `The event names its time zone "${param(dtstart, "TZID")}", which is not an IANA ` +
            `name; its times were read as ${zone} and may be wrong.`,
        }
      : {}),
    ...(text(ev, "LOCATION") ? { location: text(ev, "LOCATION") } : {}),
    ...(description
      ? {
          description:
            full || description.length <= LIST_DESCRIPTION_CHARS
              ? description
              : `${description.slice(0, LIST_DESCRIPTION_CHARS)}… (nc_get_event has the rest)`,
        }
      : {}),
    ...(text(ev, "URL") ? { url: text(ev, "URL") } : {}),
    ...(text(ev, "STATUS") ? { status: text(ev, "STATUS")!.toLowerCase() } : {}),
    ...(text(ev, "TRANSP")?.toUpperCase() === "TRANSPARENT" ? { show_as: "free" } : {}),
    ...(categories.length ? { categories } : {}),
    ...(get(ev, "RRULE") ? { repeats: true, rrule: get(ev, "RRULE")!.value } : {}),
    ...(occurrence
      ? {
          repeats: true,
          // What nc_update_event and nc_delete_event take to mean this one occurrence.
          occurrence:
            occurrence.kind === "date"
              ? isoDate(occurrence.wall)
              : isoIn(toMs(occurrence, zoneOf(recurrence) ?? zone), "UTC"),
        }
      : {}),
    ...(alarms.length ? { reminders_minutes: alarms } : {}),
    ...(get(ev, "X-MCP-NC-BINNED-FROM")
      ? { binned_from: get(ev, "X-MCP-NC-BINNED-FROM")!.value }
      : {}),
    ...(organizer ? { organizer: address(organizer) } : {}),
    ...(attendees.length ? { attendees } : {}),
  };
};

// ─── What stays private ────────────────────────────────────────────────────────────────────────

/**
 * Two things are private, and neither is shown to the model or can be changed through it:
 *
 *   an event marked private or confidential    CLASS:PRIVATE / CLASS:CONFIDENTIAL, which is what
 *                                              Nextcloud's "When shared show" setting writes
 *   every event in a private calendar          one whose name contains a word in PRIVATE_WORDS
 *                                              or in the connector's ?private_calendars=
 *
 * A private calendar is not listed and cannot be named, and a private event's uid finds
 * nothing. What a listing of all calendars does carry is a bare busy block for each one: when,
 * and nothing else, not even which calendar, so nothing is booked over the top of it. With
 * ?private=hidden even that goes, and they do not exist as far as any tool can tell. The
 * filtering happens here, before a result is built, so nothing private reaches the model, the
 * conversation or anything downstream of them.
 */
const PRIVATE_WORDS = ["dating"];

type Privacy = { words: string[]; busy: boolean };
const privacyOf = (c: Ctx): Privacy => ({
  words: [
    ...PRIVATE_WORDS,
    ...(c.params.get("private_calendars") ?? "")
      .split(",")
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean),
  ],
  busy: c.params.get("private")?.trim().toLowerCase() !== "hidden",
});

const privateName = (name: string, p: Privacy) =>
  p.words.some((w) => name.toLowerCase().includes(w));
const privateCalendar = (cal: Calendar, p: Privacy) =>
  privateName(cal.name, p) || privateName(cal.id, p);
const privateEvent = (ev: Comp) =>
  ["PRIVATE", "CONFIDENTIAL"].includes(get(ev, "CLASS")?.value.trim().toUpperCase() ?? "");

/** The calendars a tool may see and name, and the ones it may not. */
const calendarsOf = async (conn: Conn, c: Ctx) => {
  const privacy = privacyOf(c);
  const events = (await listCalendars(conn)).filter(
    (cal) => !cal.components.length || cal.components.includes("VEVENT"),
  );
  return {
    privacy,
    shown: events.filter((cal) => !privateCalendar(cal, privacy)),
    hidden: events.filter((cal) => privateCalendar(cal, privacy)),
  };
};

/** All that is ever said about a private event, and not even this with ?private=hidden. */
const busyBlock = (ev: Comp, zone: string) => {
  const s = span(ev, zone);
  if (!s) return null;
  return {
    private: true,
    summary: "Busy",
    ...(s.start.allDay
      ? {
          all_day: true,
          start: isoDate(s.start.wall),
          end: isoDate(s.start.wall + Math.max(s.length - DAY, 0)),
        }
      : {
          start: isoIn(s.start.ms, zone),
          end: isoIn(s.start.ms + s.length, zone),
          timezone: zone,
        }),
  };
};

// ─── The Bin ───────────────────────────────────────────────────────────────────────────────────

/**
 * Nothing is erased through this worker. An event that is "deleted" moves to a calendar called
 * Bin, an ordinary calendar the user can open, restore from and empty in Nextcloud. It is left
 * out of listings of all calendars, so a binned event stops looking like an appointment.
 */
const BIN = { name: "Bin", color: "#8a8a8a", description: "Events removed through mcp-nc." };
const BINNED_FROM = "X-MCP-NC-BINNED-FROM";
const BINNED_AT = "X-MCP-NC-BINNED-AT";

const isBin = (cal: Calendar) => cal.id === "bin" || cal.name.trim().toLowerCase() === "bin";

function binFor(conn: Conn, make: true): Promise<Calendar>;
function binFor(conn: Conn, make: false): Promise<Calendar | undefined>;
async function binFor(conn: Conn, make: boolean) {
  const find = async () => {
    const all = await listCalendars(conn);
    return all.find((cal) => cal.id === "bin") ?? all.find(isBin);
  };
  const found = await find();
  if (found || !make) return found;
  await createCalendar(conn, BIN);
  const made = await find();
  if (!made) throw new Error("The Bin calendar could not be created, so nothing was moved.");
  return made;
}

// ─── Finding things ────────────────────────────────────────────────────────────────────────────

const calendarFor = async (conn: Conn, c: Ctx, wanted: string, toWrite: boolean) => {
  const calendars = (await calendarsOf(conn, c)).shown;
  const key = wanted.trim().toLowerCase();
  const byName = calendars.filter((c) => c.name.toLowerCase() === key);
  const found = calendars.find((c) => c.id === wanted.trim()) ?? (byName.length === 1 && byName[0]);
  if (!found) {
    const known = calendars.map((c) => `${c.id} ("${c.name}")`).join(", ");
    throw new Error(
      byName.length > 1
        ? `${byName.length} calendars are called "${wanted}". Use the id: ` +
            byName.map((c) => c.id).join(", ")
        : `No calendar "${wanted}". The calendars are: ${known || "none"}.`,
    );
  }
  if (toWrite && !found.can_write)
    throw new Error(
      `The calendar "${found.name}" is read-only for this login` +
        (found.subscribed_from
          ? ": it is a subscription."
          : found.shared_by
            ? ": it is shared read-only."
            : "."),
    );
  return found;
};

/** A stored object, parsed: the VCALENDAR, its events, and the one that defines the series. */
const open = async (conn: Conn, cal: Calendar, uid: string) => {
  const stored = await eventByUid(conn, cal, uid);
  const vcal = stored && parse(stored.ics).find((c) => c.name === "VCALENDAR");
  const events = vcal?.comps.filter((c) => c.name === "VEVENT") ?? [];
  // A private event answers exactly as a missing one does, so a uid cannot be used to probe.
  if (!stored || events.some(privateEvent))
    throw new Error(
      `No event with UID "${uid}" in "${cal.name}" that this connector can show. Take the uid ` +
        "from nc_list_events; events marked private are neither shown nor changed here.",
    );
  if (!vcal || !events.length) throw new Error(`"${uid}" is stored in a form this cannot read.`);
  // An invitation to one occurrence of someone else's series has no master; its first is used.
  const master = events.find((e) => !get(e, "RECURRENCE-ID")) ?? events[0]!;
  return { stored, vcal, events, master };
};

/** Nextcloud emails an event's attendees when it changes, so that needs its own yes. */
const attendeeGuard = (ev: Comp, agreed: boolean | undefined, doing: string) => {
  const attendees = all(ev, "ATTENDEE").map(address);
  if (attendees.length && agreed !== true)
    throw new Error(
      `This event has ${attendees.length} attendee(s): ${attendees.join(", ")}. ${doing} it may ` +
        "make Nextcloud email them. Nothing was changed. Ask the user, then pass " +
        "notify_attendees: true.",
    );
};

// ─── One occurrence of a repeating event ───────────────────────────────────────────────────────

/** What identifies an occurrence: its original date, or its original moment. */
const occurrenceKey = (w: When, zone: string) =>
  w.kind === "date" ? `d${w.wall}` : `t${toMs(w, zone)}`;

/**
 * Finds the VEVENT for one occurrence of a series. An occurrence already changed once has an
 * override in the stored object. One that never was has nothing, so the server is asked whether
 * the series really has an occurrence then, and `fresh` says what it would be stored as.
 */
const occurrenceOf = async (
  conn: Conn,
  cal: Calendar,
  o: Awaited<ReturnType<typeof open>>,
  asked: string,
  fallback: string | undefined,
) => {
  const { master, events } = o;
  if (!get(master, "RRULE") && !get(master, "RDATE"))
    throw new Error("This event does not repeat, so it has no occurrences. Leave occurrence out.");
  const dtstart = get(master, "DTSTART");
  const first = dtstart && parseIcal(dtstart.value);
  if (!dtstart || !first) throw new Error("This series has no readable start.");
  if (param(dtstart, "TZID") && !zoneOf(dtstart))
    throw new Error(
      `This series names its time zone "${param(dtstart, "TZID")}", which is not an IANA name, ` +
        "so one occurrence cannot be placed reliably. Change the whole series instead.",
    );
  const zone = zoneOf(dtstart) ?? fallback ?? "UTC";
  const when = parseWhen(asked, "occurrence");
  if ((when.kind === "date") !== (first.kind === "date"))
    throw new Error(
      first.kind === "date"
        ? "This is an all-day series: give occurrence as a date, 2026-11-20."
        : "Give occurrence as a moment, 2026-11-20T10:00+11:00, as nc_list_events shows it.",
    );
  const key = occurrenceKey(when, zone);
  const existing = events.find((e) => {
    const r = get(e, "RECURRENCE-ID");
    const w = r && parseIcal(r.value);
    return w && occurrenceKey(w, zoneOf(r) ?? zone) === key;
  });
  // The occurrence in the same form as the series' own start, as the format requires.
  const ms = toMs(when, zone);
  const original: When =
    first.kind === "date"
      ? when
      : first.kind === "instant"
        ? { kind: "instant", ms }
        : { kind: "wall", wall: instantToWall(ms, zone) };
  const form = (name: string, w: When): Prop =>
    w.kind === "date"
      ? { name, params: ";VALUE=DATE", value: icalDate(w.wall) }
      : w.kind === "instant"
        ? { name, params: "", value: `${icalDateTime(w.ms)}Z` }
        : { name, params: dtstart.params, value: icalDateTime(w.wall) };
  if (!existing) {
    const [from, to] = when.kind === "date" ? [ms - DAY, ms + 2 * DAY] : [ms, ms + 1000];
    const uid = text(master, "UID");
    const real = (await eventsBetween(conn, cal, from, to)).some((s) =>
      parse(s.ics)
        .flatMap((c) => c.comps)
        .some((e) => {
          const r = get(e, "RECURRENCE-ID");
          const w = r && parseIcal(r.value);
          return text(e, "UID") === uid && w && occurrenceKey(w, zoneOf(r) ?? zone) === key;
        }),
    );
    if (!real)
      throw new Error(
        `The series has no occurrence at ${asked}. nc_list_events gives each occurrence's ` +
          "`occurrence` value; pass that exactly.",
      );
  }
  return { existing, original, form };
};

// ─── Applying a change ─────────────────────────────────────────────────────────────────────────

const FIELDS = {
  summary: { type: "string", description: "The title." },
  location: { type: "string", description: "Where. An empty string clears it." },
  description: { type: "string", description: "Notes. An empty string clears it." },
  url: { type: "string", description: "A link for the event. An empty string clears it." },
  status: { enum: ["confirmed", "tentative", "cancelled"] },
  show_as: { enum: ["busy", "free"], description: "Whether it blocks time. Default busy." },
  private: {
    type: "boolean",
    description:
      "true marks the event private. From then on this connector neither shows nor changes " +
      "it, so this cannot be undone here: the user unmarks it in Nextcloud.",
  },
  categories: { type: "array", items: { type: "string" }, description: "Tags. [] clears them." },
  rrule: {
    type: "string",
    description:
      "How it repeats, as an iCalendar RRULE: FREQ=WEEKLY;BYDAY=MO,WE or " +
      "FREQ=MONTHLY;BYMONTHDAY=1;COUNT=6 or FREQ=YEARLY. An empty string stops it repeating.",
  },
  reminders_minutes: {
    type: "array",
    items: { type: "integer", minimum: 0 },
    description: "Reminders, each as minutes before the start: [15, 1440]. [] removes them all.",
  },
} as const;

type Fields = {
  summary?: string;
  location?: string;
  description?: string;
  url?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  show_as?: "busy" | "free";
  private?: boolean;
  categories?: string[];
  rrule?: string;
  reminders_minutes?: number[];
};

const apply = (ev: Comp, f: Fields) => {
  const textual = (name: string, value: string | undefined) => {
    if (value !== undefined) set(ev, name, value.trim() ? escapeText(value) : undefined);
  };
  if (f.summary !== undefined) {
    if (!f.summary.trim()) throw new Error("summary cannot be empty.");
    set(ev, "SUMMARY", escapeText(f.summary));
  }
  textual("LOCATION", f.location);
  textual("DESCRIPTION", f.description);
  if (f.url !== undefined) set(ev, "URL", f.url.trim() || undefined);
  if (f.status) set(ev, "STATUS", f.status.toUpperCase());
  if (f.show_as) set(ev, "TRANSP", f.show_as === "free" ? "TRANSPARENT" : "OPAQUE");
  if (f.private !== undefined) set(ev, "CLASS", f.private ? "PRIVATE" : "PUBLIC");
  if (f.categories) {
    const tags = f.categories.map((t) => t.trim()).filter(Boolean);
    set(ev, "CATEGORIES", tags.length ? tags.map(escapeText).join(",") : undefined);
  }
  if (f.rrule !== undefined) {
    const rule = f.rrule.trim().replace(/^RRULE:/i, "");
    if (rule && !/(^|;)FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;|$)/i.test(rule))
      throw new Error(
        `rrule: "${f.rrule}" needs FREQ=DAILY, WEEKLY, MONTHLY or YEARLY, as in ` +
          "FREQ=WEEKLY;BYDAY=MO.",
      );
    if (/[\r\n:]/.test(rule)) throw new Error("rrule: one rule, with no colon or line break.");
    set(ev, "RRULE", rule ? rule.toUpperCase() : undefined);
    if (!rule) remove(ev, "RDATE", "EXDATE", "EXRULE");
  }
  if (f.reminders_minutes) {
    const label = get(ev, "SUMMARY")?.value ?? "Reminder";
    ev.comps = [
      ...ev.comps.filter((c) => c.name !== "VALARM"),
      ...[...new Set(f.reminders_minutes)].map((minutes) => {
        if (!Number.isInteger(minutes) || minutes < 0)
          throw new Error("reminders_minutes: whole minutes before the start, 0 or more.");
        return {
          name: "VALARM",
          props: [
            { name: "ACTION", params: "", value: "DISPLAY" },
            { name: "DESCRIPTION", params: "", value: label },
            { name: "TRIGGER", params: "", value: minutes ? `-PT${minutes}M` : "PT0S" },
          ],
          comps: [],
        };
      }),
    ];
  }
};

/**
 * Sets start and end. `end` for an all-day event is its last day, so it is stored as the day
 * after, which is what the format means by an end. A start moved on its own keeps the length.
 */
const retime = (
  ev: Comp,
  a: { start?: string | undefined; end?: string | undefined },
  zone: string | undefined,
) => {
  if (a.start === undefined && a.end === undefined) return;
  const reading = zone ?? "UTC";
  const was = span(ev, zoneOf(get(ev, "DTSTART")) ?? reading);
  const start = a.start === undefined ? null : parseWhen(a.start, "start");
  const given = a.end === undefined ? null : parseWhen(a.end, "end");
  const allDay = start ? start.kind === "date" : !!was?.start.allDay;
  if (given && (given.kind === "date") !== allDay)
    throw new Error(
      "start and end must both be dates (an all-day event) or both be times. To change which " +
        "kind an event is, give both.",
    );
  let end: When;
  if (given) end = given.kind === "date" ? { kind: "date", wall: given.wall + DAY } : given;
  else if (!start) return;
  else if (start.kind === "date")
    end = {
      kind: "date",
      wall: start.wall + (was?.start.allDay ? Math.max(was.length, DAY) : DAY),
    };
  else {
    const length = was && !was.start.allDay ? was.length : HOUR;
    end =
      start.kind === "wall"
        ? { kind: "wall", wall: start.wall + length }
        : { kind: "instant", ms: start.ms + length };
  }
  const startMs = start ? toMs(start, reading) : (was?.start.ms ?? -Infinity);
  if (toMs(end, reading) < startMs + (allDay ? DAY : 0)) throw new Error("end is before start.");
  if (start) put(ev, stamp("DTSTART", start, zone, "start"));
  // An end on its own is written in the zone the start already uses.
  put(ev, stamp("DTEND", end, start ? zone : (zoneOf(get(ev, "DTSTART")) ?? zone), "end"));
  remove(ev, "DURATION");
};

const touch = (ev: Comp) => {
  const now = nowStamp();
  set(ev, "DTSTAMP", now);
  set(ev, "LAST-MODIFIED", now);
  set(ev, "SEQUENCE", String((Number(get(ev, "SEQUENCE")?.value) || 0) + 1));
};

/** Whether a call asked for any change. The confirmation the core adds is not one. */
const anything = (fields: object) =>
  Object.entries(fields).some(([k, v]) => k !== "user_confirmed" && v !== undefined);

// ─── The GET page and nc_status ────────────────────────────────────────────────────────────────

/** Whether this connector can reach its Nextcloud, in words. Never throws, never names a secret. */
export const report = async (c: Ctx) => {
  let base: string | null;
  let own: string | null;
  try {
    base = baseOf(c);
    own = homeBase(c.env);
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : String(e) };
  }
  const zone = zoneParam(c.params);
  const about = {
    nextcloud: base
      ? `${base} (${c.params.get("nc") ? "named by the connector URL" : "the worker's NC_URL"})`
      : "not set: add /https://<your nextcloud> or ?nc=<host> to the connector URL, or set NC_URL",
    timezone: zone
      ? validZone(zone)
        ? zone
        : `"${zone}" is not an IANA time zone name`
      : "not set: add ?tz=Australia/Melbourne so times without an offset mean local time",
    stored_password: c.env.NC_PASSWORD?.trim()
      ? `NC_PASSWORD is set, for X-API-Key logins to ${own ?? "NC_URL, which is not set"}`
      : "NC_PASSWORD is not set, so the whole login must come in X-Auth-Token",
  };
  if (!("x-auth-token" in c.headers) && !("x-api-key" in c.headers))
    return {
      ok: false,
      ...about,
      login:
        "No login header was sent. A browser never sends one; the connector does. Set " +
        'X-Auth-Token there to "login:app password", or X-API-Key to the login name alone.',
    };
  try {
    const conn = connOf(c);
    const { principal } = await discover(conn);
    const calendars = (await calendarsOf(conn, c)).shown;
    return {
      ok: true,
      ...about,
      login:
        `${conn.via}: accepted, signed in as ${conn.user}` +
        (conn.via === "X-API-Key" ? " with the worker's NC_PASSWORD" : ""),
      principal,
      calendars: calendars.map(
        (cal) => `${cal.id} ("${cal.name}")${cal.can_write ? "" : " read-only"}`,
      ),
    };
  } catch (e) {
    return { ok: false, ...about, problem: e instanceof Error ? e.message : String(e) };
  }
};

// ─── The tools ─────────────────────────────────────────────────────────────────────────────────

const CALENDAR = {
  type: "string",
  description: "A calendar's id from nc_list_calendars, or its name when only one has it.",
} as const;
const TIMEZONE = {
  type: "string",
  description:
    "An IANA time zone, Australia/Melbourne. Defaults to the connector's ?tz=, then to the " +
    "event's own zone.",
} as const;
const UID = { type: "string", description: "The event's uid, from nc_list_events." } as const;
const NOTIFY = {
  type: "boolean",
  description:
    "Needed only when the event has attendees: Nextcloud may email them about this. Set it " +
    "once the user has agreed to that.",
} as const;
const OCCURRENCE = {
  type: "string",
  description:
    "For a repeating event, the `occurrence` value nc_list_events gave for the one occurrence " +
    "meant. Leave it out to mean the whole series.",
} as const;

export const ncTools = (): Tools => ({
  status: tool({
    description:
      "Whether this connector reaches its Nextcloud: the address, whether the login was " +
      "accepted, the time zone in use, and the calendars found. Start here when anything fails.",
    run: (_, c) => report(c),
  }),

  list_calendars: tool({
    description:
      "The calendars of the signed-in Nextcloud user: id, name, colour, whether it can be " +
      "written to, and whether it is a subscription or shared by someone else.",
    run: async (_, c) => {
      const { shown } = await calendarsOf(connOf(c), c);
      return shown.map(({ href: _href, components: _components, ...rest }) => ({
        ...rest,
        ...(isBin(rest as Calendar)
          ? { bin: "Removed events are kept here. Left out when listing all calendars." }
          : {}),
      }));
    },
  }),

  create_calendar: tool({
    description: "Create a new, empty calendar for events.",
    confirm: "Adds a calendar to the Nextcloud account.",
    input: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        color: { type: "string", description: "A hex colour: #0082c9." },
        description: { type: "string" },
      },
    },
    run: async (a, c) => {
      if (!a.name.trim()) throw new Error("name cannot be empty.");
      const conn = connOf(c);
      const id = await createCalendar(conn, { ...a, name: a.name.trim() });
      return { created: { id, name: a.name.trim() } };
    },
  }),

  update_calendar: tool({
    description: "Rename a calendar, or change its colour or description. Its id stays the same.",
    confirm: "Changes a calendar's name, colour or description.",
    input: {
      type: "object",
      required: ["calendar"],
      properties: {
        calendar: CALENDAR,
        name: { type: "string" },
        color: { type: "string", description: "A hex colour: #0082c9." },
        description: { type: "string" },
      },
    },
    run: async ({ calendar, ...fields }, c) => {
      const conn = connOf(c);
      const cal = await calendarFor(conn, c, calendar, false);
      if (!anything(fields)) throw new Error("Nothing to change: give name, color or description.");
      if (fields.name !== undefined && !fields.name.trim())
        throw new Error("name cannot be empty.");
      await updateCalendar(conn, cal, fields);
      return { updated: cal.id, ...fields };
    },
  }),

  list_events: tool({
    description:
      "Events between two times, from one calendar or from all of them, soonest first. A " +
      "repeating event appears once per occurrence, each with an `occurrence` value. Defaults " +
      "to the next 30 days. `query` keeps only events whose title, location or notes contain " +
      "the text. An all-day event's `end` is its last day.",
    input: {
      type: "object",
      properties: {
        calendar: { ...CALENDAR, description: `${CALENDAR.description} Leave out for all.` },
        from: {
          type: "string",
          description: "Start of the span: 2026-11-20 or 2026-11-20T09:00. Defaults to now.",
        },
        to: {
          type: "string",
          description:
            "End of the span; a date includes that whole day. Defaults to from + 30 days.",
        },
        query: { type: "string" },
        timezone: TIMEZONE,
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
    },
    run: async (a, c) => {
      const conn = connOf(c);
      const wanted = zoneFor(a.timezone, c);
      const zone = wanted ?? "UTC";
      const from = a.from ? toMs(parseWhen(a.from, "from"), zone) : Date.now();
      const end = a.to ? parseWhen(a.to, "to") : null;
      const to = end ? toMs(end, zone) + (end.kind === "date" ? DAY : 0) : from + 30 * DAY;
      if (to <= from) throw new Error("to is not after from.");
      if (to - from > MAX_RANGE_DAYS * DAY)
        throw new Error(`That span is over ${MAX_RANGE_DAYS} days. Ask for less at a time.`);
      const every = await calendarsOf(conn, c);
      const { busy } = every.privacy;
      const hidden = new Set(a.calendar || !busy ? [] : every.hidden);
      const calendars = a.calendar
        ? [await calendarFor(conn, c, a.calendar, false)]
        : [...every.shown.filter((cal) => !isBin(cal)), ...hidden];
      const problems: string[] = [];
      const needle = a.query?.trim().toLowerCase();
      const found = (
        await Promise.all(
          calendars.map(async (cal) => {
            try {
              return (await eventsBetween(conn, cal, from, to)).flatMap((stored) =>
                parse(stored.ics)
                  .flatMap((v) => v.comps)
                  .filter((e) => e.name === "VEVENT")
                  .map((e) => ({
                    at: span(e, zone)?.start.ms ?? 0,
                    e,
                    cal,
                    secret: hidden.has(cal) || privateEvent(e),
                  })),
              );
            } catch (e) {
              // One unreadable calendar (a broken subscription, say) should not hide the rest.
              if (!hidden.has(cal))
                problems.push(`${cal.id}: ${e instanceof Error ? e.message : String(e)}`);
              return [];
            }
          }),
        )
      )
        .flat()
        // A private event is dropped when ?private=hidden says so, and always when
        // searching: a block that appears for one word and not another would leak its text.
        .filter(({ secret }) => !secret || (busy && !needle))
        .filter(
          ({ e, secret }) =>
            secret ||
            !needle ||
            ["SUMMARY", "LOCATION", "DESCRIPTION"].some((n) =>
              text(e, n)?.toLowerCase().includes(needle),
            ),
        )
        .sort((x, y) => x.at - y.at);
      const limit = Math.min(Math.max(a.limit ?? 100, 1), 500);
      return {
        from: isoIn(from, zone),
        to: isoIn(to, zone),
        timezone: zone,
        ...(wanted
          ? {}
          : {
              timezone_note:
                "No time zone was given, so times are UTC. Pass timezone, or set ?tz= on the connector.",
            }),
        count: Math.min(found.length, limit),
        ...(found.length > limit
          ? {
              truncated: `${found.length} events matched; the first ${limit} are shown. Narrow the span.`,
            }
          : {}),
        ...(problems.length ? { problems } : {}),
        events: found
          .slice(0, limit)
          .map(({ e, cal, secret }) =>
            secret ? busyBlock(e, zone) : describe(e, cal.id, wanted, false),
          ),
      };
    },
  }),

  get_event: tool({
    description:
      "One event in full, by uid: every field, the repeat rule, any occurrences that were " +
      "changed individually, and optionally the iCalendar text as stored.",
    input: {
      type: "object",
      required: ["calendar", "uid"],
      properties: {
        calendar: CALENDAR,
        uid: UID,
        timezone: TIMEZONE,
        include_ics: { type: "boolean", description: "Also return the stored iCalendar text." },
      },
    },
    run: async (a, c) => {
      const conn = connOf(c);
      const cal = await calendarFor(conn, c, a.calendar, false);
      const zone = zoneFor(a.timezone, c);
      const { stored, events, master } = await open(conn, cal, a.uid);
      const changed = events.filter((e) => e !== master);
      const excluded = all(master, "EXDATE").flatMap((p) => p.value.split(","));
      return {
        ...describe(master, cal.id, zone, true),
        ...(changed.length
          ? { changed_occurrences: changed.map((e) => describe(e, cal.id, zone, true)) }
          : {}),
        ...(excluded.length ? { removed_occurrences: excluded } : {}),
        ...(a.include_ics ? { ics: stored.ics } : {}),
      };
    },
  }),

  create_event: tool({
    description:
      "Add an event. For an all-day event give start (and end, its last day) as dates: " +
      "2026-11-20. For a timed one give times: 2026-11-20T10:00 means that clock time in " +
      "`timezone`; add an offset (2026-11-20T10:00+11:00) for an exact moment. Without `end` " +
      "a timed event lasts an hour and an all-day event one day. Attendees cannot be added " +
      "here: inviting people sends email, which this does not do.",
    confirm: "Adds an event to the calendar.",
    input: {
      type: "object",
      required: ["calendar", "summary", "start"],
      properties: {
        calendar: CALENDAR,
        start: { type: "string", description: "2026-11-20 (all day) or 2026-11-20T10:00." },
        end: { type: "string", description: "Same form as start. An all-day end is the last day." },
        timezone: TIMEZONE,
        ...FIELDS,
      },
    },
    run: async ({ calendar, start, end, timezone, ...fields }, c) => {
      const conn = connOf(c);
      const cal = await calendarFor(conn, c, calendar, true);
      const zone = zoneFor(timezone, c);
      const uid = crypto.randomUUID();
      const now = nowStamp();
      const ev: Comp = {
        name: "VEVENT",
        props: [
          { name: "UID", params: "", value: uid },
          { name: "DTSTAMP", params: "", value: now },
          { name: "CREATED", params: "", value: now },
          { name: "LAST-MODIFIED", params: "", value: now },
          { name: "SEQUENCE", params: "", value: "0" },
        ],
        comps: [],
      };
      retime(ev, { start, end }, zone);
      apply(ev, fields);
      const vcal: Comp = {
        name: "VCALENDAR",
        props: [
          { name: "VERSION", params: "", value: "2.0" },
          { name: "PRODID", params: "", value: PRODID },
          { name: "CALSCALE", params: "", value: "GREGORIAN" },
        ],
        comps: [ev],
      };
      await putNew(conn, cal, uid, serialise(vcal));
      return { created: describe(ev, cal.id, zone, true) };
    },
  }),

  update_event: tool({
    description:
      "Change an event: send only the fields that differ. Moving `start` on its own keeps " +
      "the event's length. For a repeating event this changes the whole series unless " +
      "`occurrence` names one occurrence, which is then changed on its own. Read the event " +
      "first; never guess a uid.",
    confirm: "Changes an event in the calendar.",
    input: {
      type: "object",
      required: ["calendar", "uid"],
      properties: {
        calendar: CALENDAR,
        uid: UID,
        occurrence: OCCURRENCE,
        start: { type: "string", description: "2026-11-20 (all day) or 2026-11-20T10:00." },
        end: { type: "string", description: "Same form as start. An all-day end is the last day." },
        timezone: TIMEZONE,
        ...FIELDS,
        notify_attendees: NOTIFY,
      },
    },
    run: async (
      { calendar, uid, occurrence, start, end, timezone, notify_attendees, ...fields },
      c,
    ) => {
      const conn = connOf(c);
      const cal = await calendarFor(conn, c, calendar, true);
      const asked = zoneFor(timezone, c);
      const o = await open(conn, cal, uid);
      if (start === undefined && end === undefined && !anything(fields))
        throw new Error("Nothing to change: give at least one field.");
      let target = o.master;
      if (occurrence !== undefined) {
        if (fields.rrule !== undefined)
          throw new Error("rrule belongs to the whole series: leave occurrence out to change it.");
        const found = await occurrenceOf(conn, cal, o, occurrence, asked);
        if (found.existing) target = found.existing;
        else {
          // A first change to this occurrence: a copy of the series' event, pinned to its date.
          const length = span(o.master, zoneOf(get(o.master, "DTSTART")) ?? asked ?? "UTC")?.length;
          target = clone(o.master);
          remove(target, "RRULE", "RDATE", "EXDATE", "EXRULE", "DURATION", "DTEND");
          put(target, found.form("RECURRENCE-ID", found.original));
          put(target, found.form("DTSTART", found.original));
          const w = found.original;
          const ends: When =
            w.kind === "instant"
              ? { kind: "instant", ms: w.ms + (length ?? 0) }
              : { ...w, wall: w.wall + (length ?? 0) };
          put(target, found.form("DTEND", ends));
          o.vcal.comps.push(target);
        }
      }
      attendeeGuard(target, notify_attendees, "Changing");
      retime(target, { start, end }, asked ?? zoneOf(get(target, "DTSTART")));
      apply(target, fields);
      touch(target);
      await putOver(conn, o.stored, serialise(o.vcal));
      return {
        updated: describe(target, cal.id, asked, true),
        ...(occurrence === undefined && get(o.master, "RRULE")
          ? { scope: "The whole repeating series was changed." }
          : {}),
      };
    },
  }),

  delete_event: tool({
    description:
      "Take an event off a calendar by moving it to the Bin calendar, which is made the first " +
      "time it is needed. Nothing is erased: the event stays in the Bin, out of listings of all " +
      "calendars, until the user empties the Bin in Nextcloud, and nc_move_event puts it back. " +
      "For a repeating event this bins the whole series unless `occurrence` names one " +
      "occurrence; that one is then skipped in the series (an edit, not a move), and " +
      "nc_get_event lists it under removed_occurrences.",
    confirm: "Moves an event to the Bin calendar.",
    input: {
      type: "object",
      required: ["calendar", "uid"],
      properties: {
        calendar: CALENDAR,
        uid: UID,
        occurrence: OCCURRENCE,
        notify_attendees: NOTIFY,
      },
    },
    run: async (a, c) => {
      const conn = connOf(c);
      const cal = await calendarFor(conn, c, a.calendar, true);
      const zone = zoneFor(undefined, c);
      const o = await open(conn, cal, a.uid);
      const summary = unescapeText(get(o.master, "SUMMARY")?.value ?? "");
      attendeeGuard(o.master, a.notify_attendees, "Removing");
      if (a.occurrence === undefined) {
        if (isBin(cal))
          throw new Error(
            "This event is already in the Bin. Erasing it for good is done in Nextcloud, not here.",
          );
        const bin = await binFor(conn, true);
        const moved = await moveStored(conn, o.stored, bin);
        // Where it came from, so it can be put back. The move is what matters; if this note
        // fails to save, the event is still safe in the Bin.
        set(o.master, BINNED_FROM, cal.id);
        set(o.master, BINNED_AT, nowStamp());
        const noted = await putOver(conn, moved, serialise(o.vcal)).then(
          () => true,
          () => false,
        );
        return {
          binned: { uid: a.uid, summary, from: cal.id, now_in: bin.id },
          ...(get(o.master, "RRULE") ? { scope: "The whole repeating series was moved." } : {}),
          restore: `nc_move_event with calendar "${bin.id}" and to "${cal.id}"`,
          ...(noted
            ? {}
            : { note: "The event moved, but its origin could not be recorded on it." }),
        };
      }
      const found = await occurrenceOf(conn, cal, o, a.occurrence, zone);
      if (found.existing) o.vcal.comps = o.vcal.comps.filter((e) => e !== found.existing);
      // EXDATE is how a series says "not this one"; several may be listed, one property each.
      o.master.props.push(found.form("EXDATE", found.original));
      touch(o.master);
      await putOver(conn, o.stored, serialise(o.vcal));
      return {
        removed: { calendar: cal.id, uid: a.uid, summary, occurrence: a.occurrence },
        scope: "Only that occurrence was skipped; the series continues.",
      };
    },
  }),

  move_event: tool({
    description:
      "Move an event, with everything in it, from one calendar to another. This is also how " +
      "an event comes back out of the Bin: its `binned_from` says which calendar it was in.",
    confirm: "Moves an event to another calendar.",
    input: {
      type: "object",
      required: ["calendar", "uid", "to"],
      properties: {
        calendar: {
          ...CALENDAR,
          description: `The calendar it is in now. ${CALENDAR.description}`,
        },
        uid: UID,
        to: { ...CALENDAR, description: `The calendar to move it to. ${CALENDAR.description}` },
        notify_attendees: NOTIFY,
      },
    },
    run: async (a, c) => {
      const conn = connOf(c);
      const from = await calendarFor(conn, c, a.calendar, true);
      const to = await calendarFor(conn, c, a.to, true);
      if (from.id === to.id) throw new Error(`The event is already in "${to.name}".`);
      const o = await open(conn, from, a.uid);
      attendeeGuard(o.master, a.notify_attendees, "Moving");
      const moved = await moveStored(conn, o.stored, to);
      if (get(o.master, BINNED_FROM) && !isBin(to)) {
        remove(o.master, BINNED_FROM, BINNED_AT);
        await putOver(conn, moved, serialise(o.vcal)).catch(() => undefined);
      }
      return { moved: describe(o.master, to.id, zoneFor(undefined, c), false), from: from.id };
    },
  }),
});
