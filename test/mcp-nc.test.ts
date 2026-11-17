/**
 * mcp-nc against the fake Nextcloud in scripts/mock-nextcloud.mjs, or, with NC_TEST_BASE set,
 * against a real CalDAV server (see test/global-setup.ts).
 *
 * Three things are pinned down. The journey: calendars, then events created, read, moved and
 * deleted, with time zones and all-day ends coming back as they went in. Repeating events: one
 * occurrence changed or removed without touching the rest. And what must NOT happen: a write
 * without confirmation, a private event or calendar reaching a result, a password in any output,
 * a login following a redirect.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import Worker, { nextcloudInPath } from "../workers/mcp-nc/src/index";
import { unseal } from "../workers/mcp-nc/src/dav";
// @ts-expect-error a plain script, with no types of its own
import { seal } from "../scripts/seal-nextcloud.mjs";
import { parse, serialise } from "../workers/mcp-nc/src/ical";
import { isoIn, parseWhen, wallToInstant } from "../workers/mcp-nc/src/time";

const base = inject("ncBase");
const real = inject("ncReal");
const LOGIN = inject("ncLogin");
const [USER, PASS] = LOGIN.split(":") as [string, string];
const TZ = "Australia/Melbourne";
const HOME = `${base}/remote.php/dav/calendars/${USER}`;
const BASIC = { Authorization: `Basic ${btoa(LOGIN)}` };

type Res = { content: { text: string }[]; isError?: boolean };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Opts = { search?: string; headers?: Record<string, string> };

const search = (more = "") => `?nc=${encodeURIComponent(base)}&tz=${TZ}${more}`;
const call = (name: string, args: Json = {}, o: Opts = {}) =>
  new Worker(createExecutionContext(), env).call(name, args, {
    search: o.search ?? search(),
    headers: o.headers ?? { "x-auth-token": LOGIN },
  }) as Promise<Res>;
const ok = async (name: string, args: Json = {}, o: Opts = {}): Promise<Json> => {
  const r = await call(name, args, o);
  expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Json;
};
const fails = async (name: string, args: Json = {}, o: Opts = {}) => {
  const r = await call(name, args, o);
  expect(r.isError, `${name} should have failed: ${r.content[0]?.text}`).toBe(true);
  return r.content[0]!.text;
};
const yes = { user_confirmed: true };
const create = async (args: Json) => (await ok("nc_create_event", { ...args, ...yes }))["created"];
const list = async (args: Json = {}, o: Opts = {}): Promise<Json[]> =>
  (await ok("nc_list_events", { from: "2026-11-01", to: "2026-12-31", ...args }, o))["events"];
/** The object as the server holds it, read behind the worker's back. */
const stored = async (calendar: string, uid: string) =>
  (await fetch(`${HOME}/${calendar}/${uid}.ics`, { headers: BASIC })).text();
/** Saves an object behind the worker's back, as another client would. */
const plant = async (calendar: string, uid: string, lines: string[]) => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//another client//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20261101T000000Z",
    ...lines,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const r = await fetch(`${HOME}/${calendar}/${uid}.ics`, {
    method: "PUT",
    headers: { ...BASIC, "Content-Type": "text/calendar; charset=utf-8" },
    body: ics,
  });
  expect(r.status, await r.text()).toBeLessThan(300);
};

beforeAll(async () => {
  if (!real) await fetch(`${base}/__mock/reset`, { method: "POST" });
  for (const name of ["Work", "Dating"]) await ok("nc_create_calendar", { name, ...yes });
});

describe("the connector", () => {
  it("offers calendar and event tools, with writes marked as such", async () => {
    const tools = (await new Worker(createExecutionContext(), env).tools({})) as {
      name: string;
      inputSchema: { required?: string[] };
      annotations: { readOnlyHint: boolean };
    }[];
    expect(tools.map((t) => t.name)).toEqual([
      "nc_status",
      "nc_list_calendars",
      "nc_create_calendar",
      "nc_update_calendar",
      "nc_list_events",
      "nc_get_event",
      "nc_create_event",
      "nc_update_event",
      "nc_delete_event",
      "nc_move_event",
    ]);
    for (const t of tools)
      expect(t.inputSchema.required?.includes("user_confirmed") ?? false, t.name).toBe(
        /_(create|update|delete|move)_/.test(t.name),
      );
  });

  it("takes the Nextcloud from the path, however a proxy mangles it", () => {
    const at = (path: string) => nextcloudInPath(new URL(`https://mcp-nc.example${path}`));
    expect(at("/https://cloud.example.com")).toBe("https://cloud.example.com");
    expect(at("/https:/cloud.example.com/nextcloud")).toBe("https://cloud.example.com/nextcloud");
    expect(at("/https%3A%2F%2Fcloud.example.com")).toBe("https://cloud.example.com");
    expect(at("/")).toBeNull();
    expect(at("/favicon.ico")).toBeNull();
  });

  it("serves the path form end to end", async () => {
    const worker = new Worker(createExecutionContext(), env);
    const res = await worker.fetch(
      new Request(`https://mcp-nc.example/${base}?tz=${TZ}`, {
        headers: { "x-auth-token": LOGIN },
      }),
    );
    const page = (await res.json()) as Json;
    expect(page["status"]["ok"], JSON.stringify(page["status"])).toBe(true);
    expect(page["status"]["login"]).toContain(`signed in as ${USER}`);
    expect(JSON.stringify(page)).not.toContain(PASS);
  });

  it("says what is missing rather than failing obscurely", async () => {
    expect(await fails("nc_list_calendars", {}, { search: "" })).toContain("No Nextcloud address");
    expect(await fails("nc_list_calendars", {}, { search: "", headers: {} })).toContain(
      "No X-Secret-Key or X-Auth-Token",
    );
    expect(await fails("nc_list_calendars", {}, { headers: {} })).toContain(
      "No X-Auth-Token header",
    );
    expect(
      await fails("nc_list_calendars", {}, { headers: { "x-auth-token": "nocolon" } }),
    ).toContain("unreadable");
    expect(
      await fails("nc_list_calendars", {}, { search: "?nc=http://cloud.example.com" }),
    ).toContain("must be https");
    expect(
      await fails("nc_list_calendars", {}, { search: "?nc=https://u:p@cloud.example.com" }),
    ).toContain("never in the Nextcloud address");
    const status = await ok("nc_status", {}, { headers: {} });
    expect(status["ok"]).toBe(false);
    expect(status["login"]).toContain("No login header was sent");
  });

  it("explains a refused login without repeating the password", async () => {
    const wrong = "definitely-the-wrong-password";
    const said = await fails(
      "nc_list_calendars",
      {},
      { headers: { "x-auth-token": `${USER}:${wrong}` } },
    );
    expect(said).toContain("HTTP 401");
    expect(said).toContain("app password");
    expect(said).not.toContain(wrong);
  });
});

describe("a login sealed on the worker and opened by a key in the connector", () => {
  const vars = env as unknown as Record<string, unknown>;
  const bare = `?tz=${TZ}`;
  const host = new URL(base).host;
  let sealed: string;
  let key: string;
  const withKey = (k = key) => ({ search: bare, headers: { "x-secret-key": k } });
  const count = async () =>
    real ? 0 : ((await (await fetch(`${base}/__mock/requests`)).json()) as unknown[]).length;

  beforeAll(async () => {
    ({ sealed, key } = await seal({ url: `${base}/remote.php/dav/`, login: USER, password: PASS }));
  });
  afterEach(() => {
    delete vars["NC_SEALED"];
  });

  it("makes a seal that gives nothing away on its own", async () => {
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(key).toMatch(/^[\w-]{43}$/);
    for (const secret of [host, USER, PASS, btoa(PASS), btoa(USER)])
      expect(sealed + key).not.toContain(secret);
    // A new key and a new seal every time, even for the same answers.
    const again = await seal({ url: base, login: USER, password: PASS });
    expect(again.key).not.toBe(key);
    expect(again.sealed).not.toBe(sealed);
    expect(await unseal(sealed, key)).toEqual({
      url: `${base}/remote.php/dav/`,
      login: USER,
      password: PASS,
    });
  });

  it("signs in with nothing but the key, and names neither the address nor the login", async () => {
    vars["NC_SEALED"] = sealed;
    expect(JSON.stringify(await ok("nc_list_calendars", {}, withKey()))).toContain('"work"');
    const status = await ok("nc_status", {}, withKey());
    expect(status).toMatchObject({
      ok: true,
      nextcloud: "sealed (not shown)",
      login: "X-Secret-Key: opened NC_SEALED, and Nextcloud accepted the login inside it",
    });
    const said = JSON.stringify(status);
    for (const secret of [host, USER, PASS, key, sealed]) expect(said).not.toContain(secret);
    const init = await new Worker(createExecutionContext(), env).fetch(
      new Request("https://mcp-nc.example/", {
        method: "POST",
        headers: { "x-secret-key": key },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    expect(JSON.stringify(await init.json())).not.toContain(host);
  });

  it("opens for the right key only, and sends nothing to anyone otherwise", async () => {
    vars["NC_SEALED"] = sealed;
    const before = await count();
    const other = (await seal({ url: base, login: USER, password: PASS })).key;
    for (const wrong of [other, key.slice(0, -2) + "AA", "short", "not base64 !!"]) {
      const said = await fails("nc_list_calendars", {}, withKey(wrong));
      expect(said).toContain("X-Secret-Key does not open NC_SEALED");
      for (const secret of [host, USER, PASS]) expect(said).not.toContain(secret);
    }
    // A seal that was tampered with fails the same way: it is authenticated, not just scrambled.
    const [v, iv, data] = sealed.split(".") as [string, string, string];
    vars["NC_SEALED"] =
      `${v}.${iv}.${data.slice(0, -4)}${data.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    expect(await fails("nc_list_calendars", {}, withKey())).toContain("does not open NC_SEALED");
    vars["NC_SEALED"] = "something else entirely";
    expect(await fails("nc_list_calendars", {}, withKey())).toContain(
      "not a seal this worker made",
    );
    delete vars["NC_SEALED"];
    expect(await fails("nc_list_calendars", {}, withKey())).toContain("no NC_SEALED secret");
    expect(await count()).toBe(before);
  });

  it("cannot be pointed at another host: the address is inside the seal", async () => {
    const mine = await seal({
      url: "https://nothing-listens.invalid",
      login: USER,
      password: PASS,
    });
    vars["NC_SEALED"] = mine.sealed;
    const before = await count();
    // The connector URL names the test server. The sealed address still wins, and is not named.
    const said = await fails(
      "nc_list_calendars",
      {},
      { search: search(), headers: { "x-secret-key": mine.key } },
    );
    expect(said).toContain("Could not reach Nextcloud");
    expect(said).not.toContain("nothing-listens");
    expect(said).not.toContain(PASS);
    expect(await count()).toBe(before);
  });

  it("keeps a sealed address out of errors without touching event data that mentions it", async () => {
    const bad = await seal({ url: base, login: USER, password: "wrong-password" });
    vars["NC_SEALED"] = bad.sealed;
    const said = await fails("nc_list_calendars", {}, withKey(bad.key));
    expect(said).toContain("HTTP 401");
    expect(said).not.toContain(host);
    vars["NC_SEALED"] = sealed;
    await plant("work", "mentions-host", [
      "DTSTART:20261215T010000Z",
      "DTEND:20261215T020000Z",
      "SUMMARY:Host check",
      `URL:http://${host}/apps/calendar`,
    ]);
    const seen = await ok("nc_get_event", { calendar: "work", uid: "mentions-host" }, withKey());
    expect(seen["url"]).toBe(`http://${host}/apps/calendar`);
    await ok(
      "nc_update_event",
      { calendar: "work", uid: "mentions-host", location: "x", ...yes },
      withKey(),
    );
    expect(await stored("work", "mentions-host")).toContain(`URL:http://${host}/apps/calendar`);
  });

  it("still takes a whole login with the request, storing nothing", async () => {
    const status = await ok("nc_status");
    expect(status).toMatchObject({
      ok: true,
      nextcloud: base,
      sealed_login: "NC_SEALED is not set",
    });
    expect(status["login"]).toBe(`X-Auth-Token: accepted, signed in as ${USER}`);
  });
});

describe("calendars", () => {
  it("lists them, without inbox, outbox or anything private", async () => {
    const calendars = (await ok("nc_list_calendars")) as unknown as Json[];
    const work = calendars.find((c) => c["id"] === "work");
    expect(work).toMatchObject({ id: "work", name: "Work", can_write: true });
    expect(calendars.map((c) => c["id"])).not.toContain("inbox");
    expect(JSON.stringify(calendars)).not.toMatch(/dating/i);
  });

  it("will not write without confirmation", async () => {
    expect(await fails("nc_create_calendar", { name: "Nope" })).toContain("user_confirmed");
    expect(JSON.stringify(await ok("nc_list_calendars"))).not.toContain("Nope");
  });

  it("creates, recolours and renames one, and has no way to delete it", async () => {
    const made = await ok("nc_create_calendar", { name: "Côté Jardin", color: "#ff8800", ...yes });
    expect(made["created"]["id"]).toBe("cote-jardin");
    await ok("nc_update_calendar", {
      calendar: "cote-jardin",
      name: "Garden",
      color: "#00aa00",
      ...yes,
    });
    const now = ((await ok("nc_list_calendars")) as unknown as Json[]).find(
      (c) => c["id"] === "cote-jardin",
    );
    expect(now).toMatchObject({ name: "Garden", color: "#00aa00" });
    expect(
      await fails("nc_update_calendar", { calendar: "Garden", color: "green", ...yes }),
    ).toContain("hex");
    expect(
      await fails("nc_delete_calendar", { calendar: "Garden", confirm_name: "Garden", ...yes }),
    ).toContain("Unknown tool");
    expect(JSON.stringify(await ok("nc_list_calendars"))).toContain("Garden");
  });

  it("names the calendars when asked for one that is not there", async () => {
    expect(await fails("nc_list_events", { calendar: "holidays" })).toContain('work ("Work")');
  });
});

describe("events", () => {
  it("stores a clock time in the connector's zone and shows it back with its offset", async () => {
    const made = await create({
      calendar: "Work",
      summary: "Planning; budget, roster",
      start: "2026-11-20T10:00",
      location: "Trades Hall",
      description: "Line one\nLine two",
      reminders_minutes: [15],
    });
    expect(made).toMatchObject({
      calendar: "work",
      start: "2026-11-20T10:00:00+11:00",
      end: "2026-11-20T11:00:00+11:00",
      timezone: TZ,
      reminders_minutes: [15],
    });
    const ics = await stored("work", made["uid"]);
    expect(ics).toContain(`DTSTART;TZID=${TZ}:20261120T100000`);
    expect(ics).toContain("SUMMARY:Planning\; budget\\, roster");
    const [listed] = await list({ calendar: "work", query: "roster" });
    expect(listed).toMatchObject({
      uid: made["uid"],
      summary: "Planning; budget, roster",
      start: "2026-11-20T10:00:00+11:00",
      location: "Trades Hall",
      description: "Line one\nLine two",
    });
    // The same moment, seen from somewhere else.
    const [perth] = await list({ calendar: "work", query: "roster", timezone: "Australia/Perth" });
    expect(perth!["start"]).toBe("2026-11-20T07:00:00+08:00");
  });

  it("refuses a clock time when no zone is known, and takes an exact moment as it is", async () => {
    const bare = { search: `?nc=${encodeURIComponent(base)}` };
    const said = await fails(
      "nc_create_event",
      { calendar: "work", summary: "When?", start: "2026-11-21T10:00", ...yes },
      bare,
    );
    expect(said).toContain("no time zone is known");
    const made = (
      await ok(
        "nc_create_event",
        { calendar: "work", summary: "Exact", start: "2026-11-21T10:00+11:00", ...yes },
        bare,
      )
    )["created"];
    expect(made["start"]).toBe("2026-11-20T23:00:00Z");
    expect(await stored("work", made["uid"])).toContain("DTSTART:20261120T230000Z");
  });

  it("treats an all-day end as the last day, and stores the day after", async () => {
    const made = await create({
      calendar: "work",
      summary: "Conference",
      start: "2026-12-01",
      end: "2026-12-03",
    });
    expect(made).toMatchObject({ all_day: true, start: "2026-12-01", end: "2026-12-03" });
    const ics = await stored("work", made["uid"]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261201");
    expect(ics).toContain("DTEND;VALUE=DATE:20261204");
    const [listed] = await list({ calendar: "work", query: "Conference" });
    expect(listed).toMatchObject({ all_day: true, start: "2026-12-01", end: "2026-12-03" });
    expect(
      await fails("nc_create_event", {
        calendar: "work",
        summary: "Mixed",
        start: "2026-12-01",
        end: "2026-12-01T10:00",
        ...yes,
      }),
    ).toContain("both be dates");
  });

  it("moves a start and keeps the length, clears a field, and leaves the rest alone", async () => {
    await plant("work", "from-a-phone", [
      `DTSTART;TZID=${TZ}:20261125T140000`,
      `DTEND;TZID=${TZ}:20261125T153000`,
      "SUMMARY:Dentist",
      "LOCATION:Collins St",
      "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
      "SEQUENCE:4",
      "BEGIN:VALARM",
      "ACTION:AUDIO",
      "TRIGGER:-PT30M",
      "END:VALARM",
    ]);
    const { updated } = await ok("nc_update_event", {
      calendar: "work",
      uid: "from-a-phone",
      start: "2026-11-26T09:00",
      location: "",
      ...yes,
    });
    expect(updated).toMatchObject({
      start: "2026-11-26T09:00:00+11:00",
      end: "2026-11-26T10:30:00+11:00",
      reminders_minutes: [30],
    });
    expect(updated["location"]).toBeUndefined();
    const ics = await stored("work", "from-a-phone");
    expect(ics).toContain("X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC");
    expect(ics).toContain("ACTION:AUDIO");
    expect(ics).toContain("SEQUENCE:5");
    expect(ics).not.toContain("LOCATION");
    expect(
      await fails("nc_update_event", { calendar: "work", uid: "from-a-phone", ...yes }),
    ).toContain("Nothing to change");
    expect(
      await fails("nc_update_event", {
        calendar: "work",
        uid: "from-a-phone",
        end: "2026-11-26T08:00",
        ...yes,
      }),
    ).toContain("end is before start");
  });

  it("will not touch an event with attendees until told the emails are wanted", async () => {
    await plant("work", "with-guests", [
      "DTSTART:20261127T010000Z",
      "DTEND:20261127T020000Z",
      "SUMMARY:Committee",
      "ORGANIZER:mailto:s@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:alex@example.com",
    ]);
    const change = { calendar: "work", uid: "with-guests", summary: "Committee (moved)", ...yes };
    expect(await fails("nc_update_event", change)).toContain("alex@example.com");
    expect(
      await fails("nc_delete_event", { calendar: "work", uid: "with-guests", ...yes }),
    ).toContain("notify_attendees");
    expect(await stored("work", "with-guests")).toContain("SUMMARY:Committee\r\n");
    await ok("nc_update_event", { ...change, notify_attendees: true });
    const ics = await stored("work", "with-guests");
    expect(ics).toContain("SUMMARY:Committee (moved)");
    expect(ics).toContain("ATTENDEE;PARTSTAT=ACCEPTED:mailto:alex@example.com");
  });

  it("moves a deleted event to the Bin instead of erasing it, and brings it back", async () => {
    const made = await create({
      calendar: "work",
      summary: "Short-lived",
      start: "2026-11-28T10:00",
      location: "Room 9",
    });
    const args = { calendar: "work", uid: made["uid"] };
    expect(await fails("nc_delete_event", args)).toContain("user_confirmed");
    const out = await ok("nc_delete_event", { ...args, ...yes });
    expect(out["binned"]).toMatchObject({ from: "work", now_in: "bin", summary: "Short-lived" });
    // Gone from where it was, and from what is on across all calendars...
    expect(await fails("nc_get_event", args)).toContain("No event with UID");
    expect(await list({ query: "Short-lived" })).toEqual([]);
    // ...but whole, in a calendar anyone can open, and saying where it came from.
    const calendars = (await ok("nc_list_calendars")) as unknown as Json[];
    expect(calendars.find((c) => c["id"] === "bin")).toMatchObject({ name: "Bin" });
    const [binned] = await list({ calendar: "Bin", query: "Short-lived" });
    expect(binned).toMatchObject({ uid: made["uid"], location: "Room 9", binned_from: "work" });
    expect(await stored("bin", made["uid"])).toContain("SUMMARY:Short-lived");
    // Deleting it again does not erase it either.
    expect(await fails("nc_delete_event", { calendar: "bin", uid: made["uid"], ...yes })).toContain(
      "already in the Bin",
    );
    const back = await ok("nc_move_event", {
      calendar: "bin",
      uid: made["uid"],
      to: "work",
      ...yes,
    });
    expect(back["moved"]).toMatchObject({ calendar: "work", summary: "Short-lived" });
    expect(back["moved"]["binned_from"]).toBeUndefined();
    const [again] = await list({ calendar: "work", query: "Short-lived" });
    expect(again).toMatchObject({ start: "2026-11-28T10:00:00+11:00", location: "Room 9" });
    expect(await stored("work", made["uid"])).not.toContain("BINNED");
  });

  it("uses the one Bin for the next event too, and moves between ordinary calendars", async () => {
    const one = await create({ calendar: "work", summary: "Bin me too", start: "2026-11-29" });
    await ok("nc_delete_event", { calendar: "work", uid: one["uid"], ...yes });
    const bins = ((await ok("nc_list_calendars")) as unknown as Json[]).filter((c) => c["bin"]);
    expect(bins).toHaveLength(1);
    const two = await create({ calendar: "work", summary: "Wrong calendar", start: "2026-11-29" });
    const move = { calendar: "work", uid: two["uid"], to: "Garden" };
    expect(await fails("nc_move_event", move)).toContain("user_confirmed");
    await ok("nc_move_event", { ...move, ...yes });
    expect((await list({ calendar: "Garden" })).map((e) => e["summary"])).toEqual([
      "Wrong calendar",
    ]);
    expect(await fails("nc_move_event", { ...move, calendar: "Garden", ...yes })).toContain(
      "already in",
    );
  });

  it("covers every calendar when none is named, soonest first", async () => {
    const events = await list();
    const starts = events.map((e) => new Date(e["start"]).getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(events.length).toBeGreaterThan(3);
  });
});

describe("repeating events", () => {
  let uid: string;
  const mondays = async () =>
    (await list({ calendar: "work", query: "Stand-up", to: "2026-11-30" })).map((e) => e["start"]);

  it("appear once per occurrence, each with the value that names it", async () => {
    uid = (
      await create({
        calendar: "work",
        summary: "Stand-up",
        start: "2026-11-02T09:30",
        end: "2026-11-02T09:45",
        rrule: "FREQ=WEEKLY;COUNT=8",
      })
    )["uid"];
    const events = await list({ calendar: "work", query: "Stand-up", to: "2026-11-30" });
    expect(events.map((e) => e["start"])).toEqual([
      "2026-11-02T09:30:00+11:00",
      "2026-11-09T09:30:00+11:00",
      "2026-11-16T09:30:00+11:00",
      "2026-11-23T09:30:00+11:00",
      "2026-11-30T09:30:00+11:00",
    ]);
    expect(events[1]).toMatchObject({ repeats: true, occurrence: "2026-11-08T22:30:00Z", uid });
  });

  it("change one occurrence and leave the others where they were", async () => {
    const { updated } = await ok("nc_update_event", {
      calendar: "work",
      uid,
      occurrence: "2026-11-08T22:30:00Z",
      start: "2026-11-10T14:00",
      summary: "Stand-up (moved)",
      ...yes,
    });
    expect(updated).toMatchObject({
      start: "2026-11-10T14:00:00+11:00",
      end: "2026-11-10T14:15:00+11:00",
      occurrence: "2026-11-08T22:30:00Z",
    });
    expect(await mondays()).toEqual([
      "2026-11-02T09:30:00+11:00",
      "2026-11-10T14:00:00+11:00",
      "2026-11-16T09:30:00+11:00",
      "2026-11-23T09:30:00+11:00",
      "2026-11-30T09:30:00+11:00",
    ]);
    const ics = await stored("work", uid);
    expect(ics).toContain(`RECURRENCE-ID;TZID=${TZ}:20261109T093000`);
    expect(ics.match(/RRULE/g)).toHaveLength(1);
    // Changing it a second time edits the same override rather than adding another.
    await ok("nc_update_event", {
      calendar: "work",
      uid,
      occurrence: "2026-11-08T22:30:00Z",
      location: "Room 2",
      ...yes,
    });
    expect((await stored("work", uid)).match(/BEGIN:VEVENT/g)).toHaveLength(2);
    const full = await ok("nc_get_event", { calendar: "work", uid });
    expect(full["rrule"]).toBe("FREQ=WEEKLY;COUNT=8");
    expect(full["changed_occurrences"][0]).toMatchObject({ location: "Room 2" });
  });

  it("remove one occurrence and keep the series", async () => {
    const out = await ok("nc_delete_event", {
      calendar: "work",
      uid,
      occurrence: "2026-11-16T09:30+11:00",
      ...yes,
    });
    expect(out["scope"]).toContain("Only that occurrence");
    expect(await mondays()).toEqual([
      "2026-11-02T09:30:00+11:00",
      "2026-11-10T14:00:00+11:00",
      "2026-11-23T09:30:00+11:00",
      "2026-11-30T09:30:00+11:00",
    ]);
    expect(await stored("work", uid)).toContain(`EXDATE;TZID=${TZ}:20261116T093000`);
  });

  it("refuse an occurrence the series does not have", async () => {
    const args = {
      calendar: "work",
      uid,
      occurrence: "2026-11-17T09:30+11:00",
      summary: "x",
      ...yes,
    };
    expect(await fails("nc_update_event", args)).toContain("no occurrence at");
    expect(await fails("nc_update_event", { ...args, occurrence: "2026-11-23" })).toContain(
      "as a moment",
    );
    expect(
      await fails("nc_update_event", {
        calendar: "work",
        uid,
        occurrence: "2026-11-22T22:30:00Z",
        rrule: "",
        ...yes,
      }),
    ).toContain("whole series");
  });

  it("handle all-day series by date", async () => {
    const made = await create({
      calendar: "work",
      summary: "Bin night",
      start: "2026-11-03",
      rrule: "FREQ=WEEKLY;COUNT=4",
    });
    const args = { calendar: "work", uid: made["uid"] };
    await ok("nc_delete_event", { ...args, occurrence: "2026-11-10", ...yes });
    const days = (await list({ calendar: "work", query: "Bin night" })).map((e) => e["start"]);
    expect(days).toEqual(["2026-11-03", "2026-11-17", "2026-11-24"]);
    expect(await stored("work", made["uid"])).toContain("EXDATE;VALUE=DATE:20261110");
  });

  it("say so when the whole series is what changed", async () => {
    const out = await ok("nc_update_event", {
      calendar: "work",
      uid,
      description: "Daily-ish",
      ...yes,
    });
    expect(out["scope"]).toContain("whole repeating series");
  });
});

describe("what stays private", () => {
  const hidden = { search: search("&private=hidden") };
  let secret: string;

  it("hides an event once it is marked private, from listing, search and lookup alike", async () => {
    const made = await create({
      calendar: "work",
      summary: "Specialist appointment",
      start: "2026-12-07T11:00",
      location: "Clinic",
      private: true,
    });
    secret = made["uid"];
    expect(await stored("work", secret)).toContain("CLASS:PRIVATE");
    const all = JSON.stringify(await list());
    expect(all).not.toContain("Specialist");
    expect(all).not.toContain(secret);
    expect(await list({ query: "Specialist" })).toEqual([]);
    const said = await fails("nc_get_event", { calendar: "work", uid: secret });
    expect(said).toContain("No event with UID");
    expect(said).not.toContain("Specialist");
    for (const tool of ["nc_update_event", "nc_delete_event"])
      expect(await fails(tool, { calendar: "work", uid: secret, summary: "x", ...yes })).toContain(
        "No event with UID",
      );
    expect(await stored("work", secret)).toContain("SUMMARY:Specialist appointment");
  });

  it("treats CONFIDENTIAL the same, and one private occurrence hides its whole event", async () => {
    await plant("work", "confidential-one", [
      "DTSTART:20261208T010000Z",
      "DTEND:20261208T020000Z",
      "SUMMARY:Union legal advice",
      "CLASS:CONFIDENTIAL",
    ]);
    expect(JSON.stringify(await list())).not.toContain("Union legal");
    expect(await fails("nc_get_event", { calendar: "work", uid: "confidential-one" })).toContain(
      "No event with UID",
    );
  });

  it("shows a private event as a bare busy block, and as nothing once the connector says hidden", async () => {
    const events = await list();
    const block = events.find((e) => e["start"] === "2026-12-07T11:00:00+11:00");
    expect(block).toEqual({
      private: true,
      summary: "Busy",
      start: "2026-12-07T11:00:00+11:00",
      end: "2026-12-07T12:00:00+11:00",
      timezone: TZ,
    });
    // Searching never surfaces one, or the words that find it would give it away.
    expect(await list({ query: "Specialist" })).toEqual([]);
    expect(await list({ query: "Clinic" })).toEqual([]);
    expect((await list({}, hidden)).some((e) => e["private"])).toBe(false);
  });

  it("keeps a calendar with Dating in its name out of sight entirely", async () => {
    await plant("dating", "a-date", [
      `DTSTART;TZID=${TZ}:20261211T190000`,
      `DTEND;TZID=${TZ}:20261211T210000`,
      "SUMMARY:Dinner with Sam",
      "LOCATION:Lygon St",
    ]);
    expect(JSON.stringify(await ok("nc_list_calendars"))).not.toMatch(/dating/i);
    expect(JSON.stringify(await ok("nc_status"))).not.toMatch(/dating/i);
    const all = JSON.stringify(
      await ok("nc_list_events", { from: "2026-11-01", to: "2026-12-31" }, hidden),
    );
    expect(all).not.toMatch(/dating|Sam|Lygon|a-date|19:00|"private"/i);
    expect(
      JSON.stringify(await ok("nc_list_events", { from: "2026-11-01", to: "2026-12-31" })),
    ).not.toMatch(/dating|Sam|Lygon|a-date/i);
    for (const name of ["dating", "Dating"]) {
      const said = await fails("nc_list_events", { calendar: name });
      expect(said).toContain("No calendar");
      expect(said).not.toMatch(/dating \(/i);
    }
    expect(await fails("nc_get_event", { calendar: "dating", uid: "a-date" })).toContain(
      "No calendar",
    );
    expect(
      await fails("nc_create_event", {
        calendar: "Dating",
        summary: "x",
        start: "2026-12-12",
        ...yes,
      }),
    ).toContain("No calendar");
    expect(
      await fails("nc_move_event", { calendar: "work", uid: "from-a-phone", to: "Dating", ...yes }),
    ).toContain("No calendar");
  });

  it("gives its events as busy blocks that do not say which calendar", async () => {
    const out = await ok("nc_list_events", { from: "2026-12-11", to: "2026-12-11" });
    expect(out["events"]).toEqual([
      {
        private: true,
        summary: "Busy",
        start: "2026-12-11T19:00:00+11:00",
        end: "2026-12-11T21:00:00+11:00",
        timezone: TZ,
      },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/dating|Sam|Lygon/i);
  });

  it("lets the connector name more private calendars", async () => {
    const o = { search: search("&private_calendars=Health,%20wor") };
    expect(JSON.stringify(await ok("nc_list_calendars", {}, o))).not.toContain('"work"');
    expect(await fails("nc_list_events", { calendar: "work" }, o)).toContain("No calendar");
  });
});

describe.skipIf(real)("against a server that misbehaves", () => {
  const requests = async () =>
    (await (await fetch(`${base}/__mock/requests`)).json()) as { method: string; path: string }[];

  it("sends nothing when a write is not confirmed", async () => {
    const before = (await requests()).length;
    await fails("nc_create_event", { calendar: "work", summary: "x", start: "2026-12-12" });
    await fails("nc_delete_event", { calendar: "work", uid: "from-a-phone" });
    expect((await requests()).length).toBe(before);
  });

  it("has never sent a DELETE, for anything", async () => {
    expect((await requests()).filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("marks a calendar shared read-only and will not write to it", async () => {
    const team = ((await ok("nc_list_calendars")) as unknown as Json[]).find(
      (c) => c["id"] === "team",
    );
    expect(team).toMatchObject({ can_write: false, shared_by: "alex" });
    expect(
      await fails("nc_create_event", {
        calendar: "team",
        summary: "x",
        start: "2026-12-12",
        ...yes,
      }),
    ).toContain("read-only");
  });

  it("reports one broken calendar without losing the rest or leaking the password", async () => {
    const out = await ok("nc_list_events", { from: "2026-11-01", to: "2026-12-31" });
    expect(out["problems"][0]).toContain("broken");
    expect(out["events"].length).toBeGreaterThan(3);
    expect(JSON.stringify(out)).not.toContain(PASS);
    expect(JSON.stringify(out)).toContain("[password]");
  });

  it("does not follow a redirect with the login", async () => {
    const before = (await requests()).length;
    const said = await fails(
      "nc_list_calendars",
      {},
      { search: `?nc=${encodeURIComponent(base + "/moved")}` },
    );
    expect(said).toContain("redirected");
    expect((await requests()).length).toBe(before + 1);
  });

  it("refuses to save over an event that changed since it was read", async () => {
    const made = await create({ calendar: "work", summary: "Racy", start: "2026-12-14T10:00" });
    await fetch(`${base}/__mock/race`, { method: "POST" });
    const said = await fails("nc_update_event", {
      calendar: "work",
      uid: made["uid"],
      summary: "Mine",
      ...yes,
    });
    expect(said).toContain("HTTP 412");
    expect(said).toContain("Nothing was written");
  });
});

describe("the parts underneath", () => {
  it("round-trips iCalendar without losing folding, escapes or parameters", () => {
    const long = "x".repeat(200) + "é".repeat(40);
    const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nATTENDEE;CN="Doe, Jane";ROLE=CHAIR:mailto:j@example.com\r\nSUMMARY:${long}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const [vcal] = parse(ics);
    const out = serialise(vcal!);
    for (const line of out.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(parse(out)).toEqual(parse(ics));
    expect(parse(out)[0]!.comps[0]!.props[0]).toEqual({
      name: "ATTENDEE",
      params: ';CN="Doe, Jane";ROLE=CHAIR',
      value: "mailto:j@example.com",
    });
  });

  it("knows daylight saving on both sides of a change", () => {
    const at = (wall: string) => {
      const w = parseWhen(wall, "t");
      return isoIn(wallToInstant(w.kind === "instant" ? w.ms : w.wall, TZ), TZ);
    };
    expect(at("2026-07-01T09:00")).toBe("2026-07-01T09:00:00+10:00");
    expect(at("2026-10-04T09:00")).toBe("2026-10-04T09:00:00+11:00"); // the day clocks go forward
    expect(at("2027-04-04T09:00")).toBe("2027-04-04T09:00:00+10:00"); // the day they go back
    expect(() => parseWhen("2026-02-30", "t")).toThrow("not a date");
    expect(() => parseWhen("tomorrow", "t")).toThrow("not a date");
  });
});
