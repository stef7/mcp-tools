/**
 * A fake Nextcloud, as much of its CalDAV as mcp-nc uses, to test against without an account.
 *
 * It answers the way Nextcloud (sabre/dav) does where that matters:
 *   - Basic auth on everything under /remote.php/dav/, with sabre's XML error body on a 401
 *   - the principal is /principals/users/<login>/, found only by asking, as on the real thing
 *   - the calendar home also holds an inbox, an outbox and a trash bin, which are not calendars
 *   - calendars are made with extended MKCOL; MKCALENDAR is not needed and Workers cannot send it
 *   - a calendar-query with <expand> returns one VEVENT per occurrence, in UTC, each with a
 *     RECURRENCE-ID, honouring EXDATE and overridden occurrences
 *   - PUT and DELETE honour If-Match and If-None-Match, and every save changes the ETag
 *   - MOVE carries an object to another calendar, honouring If-Match and never overwriting
 *
 * And three things exist only to misbehave:
 *   team      a calendar shared read-only by "alex": every write to it is a 403
 *   broken    a calendar whose REPORT fails with a 500 that echoes the Authorization it was sent
 *   /moved    an address that redirects, to prove the login is not carried along
 *
 * Recurrence is expanded for FREQ=DAILY and FREQ=WEEKLY with INTERVAL, COUNT and UNTIL, which is
 * what the tests use. The suite also runs against a real sabre/dav (see test/global-setup.ts),
 * which is where the rest of the protocol is checked.
 *
 * GET /__mock/requests lists every DAV request received; POST /__mock/reset clears the log and
 * the data; POST /__mock/race makes the next PUT find that the event changed under it.
 *
 * Usage: node scripts/mock-nextcloud.mjs [port] [login:password]
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8794);
const LOGIN = process.argv[3] ?? "stef:app-pass-12345";
const USER = LOGIN.split(":")[0];
const DAV = "/remote.php/dav";
const PRINCIPAL = `${DAV}/principals/users/${USER}/`;
const HOME = `${DAV}/calendars/${USER}/`;
const DAY = 86_400_000;

/** id -> { name, color, description, readOnly, owner, objects: Map<file, { ics, etag }> } */
let calendars;
let log = [];
let race = false;
let serial = 0;
const etag = () => `"mock-${++serial}"`;

const reset = () => {
  log = [];
  race = false;
  const cal = (name, more = {}) => ({ name, color: "#0082c9", objects: new Map(), ...more });
  calendars = new Map([
    ["personal", cal("Personal")],
    ["team", cal("Team (alex)", { readOnly: true, owner: "alex" })],
    ["broken", cal("Broken")],
  ]);
};
reset();

// ─── iCalendar, just enough ────────────────────────────────────────────────────────────────────

const parseIcs = (text) => {
  const root = { name: "", props: [], comps: [] };
  const stack = [root];
  for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    const m = /^([^;:]+)((?:;[^=]+=(?:"[^"]*"|[^;:]*))*):(.*)$/.exec(line);
    if (!m) continue;
    const top = stack[stack.length - 1];
    if (m[1] === "BEGIN") {
      const comp = { name: m[3], props: [], comps: [] };
      top.comps.push(comp);
      stack.push(comp);
    } else if (m[1] === "END") stack.pop();
    else top.props.push({ name: m[1].toUpperCase(), params: m[2], value: m[3] });
  }
  return root.comps[0];
};
const write = (c) =>
  [
    `BEGIN:${c.name}`,
    ...c.props.map((p) => `${p.name}${p.params}:${p.value}`),
    ...c.comps.map(write),
    `END:${c.name}`,
  ].join("\r\n");
const prop = (c, name) => c.props.find((p) => p.name === name);

const offsetAt = (ms, tz) => {
  const p = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms)))
    p[part.type] = part.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
};
const toUtc = (wall, tz) => wall - offsetAt(wall - offsetAt(wall, tz), tz);

/** A DTSTART-like property -> { date, wall, tz }: `wall` is the clock reading as if UTC. */
const read = (p) => {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z)?)?$/.exec(p.value);
  const wall = Date.UTC(m[1], m[2] - 1, m[3], m[4] ?? 0, m[5] ?? 0, m[6] ?? 0);
  const tz = m[7] ? "UTC" : (/TZID=([^;:]+)/.exec(p.params)?.[1] ?? "UTC");
  return { date: m[4] === undefined, wall, tz };
};
const instant = (t) => (t.date ? t.wall : toUtc(t.wall, t.tz));
const stampUtc = (ms) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, "");
const stampDate = (ms) => stampUtc(ms).slice(0, 8);

/** The start of every occurrence of a master VEVENT up to `until`, as wall times. */
const occurrences = (ev, until) => {
  const start = read(prop(ev, "DTSTART"));
  const rule = prop(ev, "RRULE");
  if (!rule) return [start.wall];
  const part = Object.fromEntries(rule.value.split(";").map((kv) => kv.split("=")));
  const step = (part.FREQ === "WEEKLY" ? 7 : 1) * Number(part.INTERVAL ?? 1) * DAY;
  const last = part.UNTIL ? instant(read({ value: part.UNTIL, params: "" })) : Infinity;
  const skipped = new Set(
    ev.props
      .filter((p) => p.name === "EXDATE")
      .flatMap((p) => p.value.split(",").map((value) => instant(read({ ...p, value })))),
  );
  const out = [];
  for (let i = 0, wall = start.wall; i < Number(part.COUNT ?? 1000); i++, wall += step) {
    const at = instant({ ...start, wall });
    if (at > until || at > last) break;
    if (!skipped.has(at)) out.push(wall);
  }
  return out;
};

/** What a calendar-query with <expand> gives back for one stored object, or null if nothing fits. */
const expand = (ics, from, to, expanding) => {
  const vcal = parseIcs(ics);
  const events = vcal.comps.filter((c) => c.name === "VEVENT");
  const master = events.find((e) => !prop(e, "RECURRENCE-ID"));
  const overrides = events.filter((e) => prop(e, "RECURRENCE-ID"));
  const out = [];
  const emit = (ev, start, recurrenceId) => {
    const s = read(prop(ev, "DTSTART"));
    const end = prop(ev, "DTEND")
      ? read(prop(ev, "DTEND"))
      : { ...s, wall: s.wall + (s.date ? DAY : 0) };
    const length = end.wall - s.wall;
    const begins = instant({ ...s, wall: start });
    const ends = instant({ ...s, wall: start + length });
    if (!(begins < to && (ends > from || (begins === ends && begins >= from)))) return;
    const fmt = (ms) => (s.date ? stampDate(ms) : stampUtc(ms));
    const params = s.date ? ";VALUE=DATE" : "";
    out.push({
      ...ev,
      props: [
        ...ev.props.filter(
          (p) =>
            !["DTSTART", "DTEND", "RRULE", "EXDATE", "RECURRENCE-ID", "DURATION"].includes(p.name),
        ),
        { name: "DTSTART", params, value: fmt(s.date ? start : begins) },
        { name: "DTEND", params, value: fmt(s.date ? start + length : ends) },
        ...(recurrenceId === undefined
          ? []
          : [{ name: "RECURRENCE-ID", params, value: fmt(recurrenceId) }]),
      ],
    });
  };
  const overridden = new Map(overrides.map((e) => [instant(read(prop(e, "RECURRENCE-ID"))), e]));
  if (master) {
    const s = read(prop(master, "DTSTART"));
    const repeats = !!prop(master, "RRULE");
    for (const wall of occurrences(master, to + 400 * DAY)) {
      const at = instant({ ...s, wall });
      const override = overridden.get(at);
      if (override) emit(override, read(prop(override, "DTSTART")).wall, at);
      else emit(master, wall, repeats ? at : undefined);
    }
  } else
    for (const e of overrides)
      emit(e, read(prop(e, "DTSTART")).wall, instant(read(prop(e, "RECURRENCE-ID"))));
  if (!out.length) return null;
  return expanding ? write({ ...vcal, comps: out }) + "\r\n" : ics;
};

// ─── DAV ───────────────────────────────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const NSS =
  'xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav" ' +
  'xmlns:cs="http://calendarserver.org/ns/" xmlns:oc="http://owncloud.org/ns" ' +
  'xmlns:nc="http://nextcloud.com/ns" xmlns:x1="http://apple.com/ns/ical/"';
const multistatus = (responses) =>
  `<?xml version="1.0"?>\n<d:multistatus ${NSS}>${responses.join("")}</d:multistatus>`;
const response = (href, props) =>
  `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${props}</d:prop>` +
  "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>";
const error = (exception, message) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">` +
  `<s:exception>${exception}</s:exception><s:message>${esc(message)}</s:message></d:error>`;

const privileges = (names) =>
  `<d:current-user-privilege-set>${names.map((n) => `<d:privilege><d:${n}/></d:privilege>`).join("")}</d:current-user-privilege-set>`;

const calendarProps = (id, c) =>
  "<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>" +
  `<d:displayname>${esc(c.name)}</d:displayname>` +
  `<x1:calendar-color>${esc(c.color)}</x1:calendar-color>` +
  (c.description
    ? `<cal:calendar-description>${esc(c.description)}</cal:calendar-description>`
    : "") +
  '<cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>' +
  privileges(
    c.readOnly
      ? ["read"]
      : ["write", "write-properties", "write-content", "bind", "unbind", "read"],
  ) +
  `<oc:owner-principal>${DAV}/principals/users/${c.owner ?? USER}/</oc:owner-principal>`;

const body = (req) =>
  new Promise((done) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
  });

const handle = async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  const send = (status, text = "", headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/xml; charset=utf-8", ...headers });
    res.end(text);
  };
  if (path === "/__mock/requests")
    return send(200, JSON.stringify(log), { "Content-Type": "application/json" });
  if (path === "/__mock/reset") return (reset(), send(204));
  if (path === "/__mock/race") return ((race = true), send(204));

  log.push({ method: req.method, path });
  if (path.startsWith("/moved")) return send(302, "", { Location: "https://elsewhere.example/" });
  if (!path.startsWith(DAV)) return send(404, "Not here");
  const auth = req.headers.authorization ?? "";
  if (auth !== `Basic ${Buffer.from(LOGIN).toString("base64")}`)
    return send(
      401,
      error(
        "Sabre\\DAV\\Exception\\NotAuthenticated",
        "No public access to this resource., Username or password was incorrect",
      ),
      { "WWW-Authenticate": 'Basic realm="Nextcloud", charset="UTF-8"' },
    );
  const text = await body(req);
  const depth = req.headers.depth ?? "0";

  if (path === `${DAV}/` && req.method === "PROPFIND")
    return send(
      207,
      multistatus([
        response(
          path,
          `<d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal>`,
        ),
      ]),
    );
  if (path === PRINCIPAL && req.method === "PROPFIND")
    return send(
      207,
      multistatus([
        response(path, `<cal:calendar-home-set><d:href>${HOME}</d:href></cal:calendar-home-set>`),
      ]),
    );
  if (!path.startsWith(HOME))
    return send(404, error("Sabre\\DAV\\Exception\\NotFound", "Not found"));

  const [id, file] = path.slice(HOME.length).split("/");
  if (!id) {
    if (req.method !== "PROPFIND") return send(405);
    const plain = (name) =>
      response(`${HOME}${name}/`, "<d:resourcetype><d:collection/></d:resourcetype>");
    return send(
      207,
      multistatus([
        response(HOME, "<d:resourcetype><d:collection/></d:resourcetype>"),
        ...(depth === "1"
          ? [
              ...[...calendars].map(([cid, c]) =>
                response(`${HOME}${encodeURIComponent(cid)}/`, calendarProps(cid, c)),
              ),
              plain("inbox"),
              plain("outbox"),
              plain("trashbin"),
            ]
          : []),
      ]),
    );
  }
  const cal = calendars.get(id);
  const writing = !["PROPFIND", "REPORT", "GET"].includes(req.method);
  if (cal?.readOnly && writing)
    return send(
      403,
      error("Sabre\\DAV\\Exception\\Forbidden", "You are not allowed to write here"),
    );

  if (!file) {
    if (req.method === "MKCOL") {
      if (cal)
        return send(
          405,
          error(
            "Sabre\\DAV\\Exception\\MethodNotAllowed",
            "The resource you tried to create already exists",
          ),
        );
      if (!/<[a-z]+:calendar\s*\/>/.test(text))
        return send(400, error("Sabre\\DAV\\Exception\\BadRequest", "Not a calendar"));
      const pick = (name) => new RegExp(`<[a-z0-9]+:${name}>([^<]*)<`).exec(text)?.[1];
      calendars.set(id, {
        name: unesc(pick("displayname") ?? id),
        color: unesc(pick("calendar-color") ?? "#0082c9"),
        description: unesc(pick("calendar-description") ?? ""),
        objects: new Map(),
      });
      return send(201);
    }
    if (!cal)
      return send(404, error("Sabre\\DAV\\Exception\\NotFound", `Calendar ${id} not found`));
    if (req.method === "DELETE") return (calendars.delete(id), send(204));
    if (req.method === "PROPPATCH") {
      const pick = (name) => new RegExp(`<[a-z0-9]+:${name}>([^<]*)<`).exec(text)?.[1];
      if (pick("displayname") !== undefined) cal.name = unesc(pick("displayname"));
      if (pick("calendar-color") !== undefined) cal.color = unesc(pick("calendar-color"));
      if (pick("calendar-description") !== undefined)
        cal.description = unesc(pick("calendar-description"));
      return send(207, multistatus([response(path, "<d:displayname/>")]));
    }
    if (req.method === "REPORT") {
      if (id === "broken")
        return send(
          500,
          error("Sabre\\DAV\\Exception", `Database gone away while serving ${auth} (${LOGIN})`),
        );
      const uid = /<[a-z]+:text-match[^>]*>([^<]*)</.exec(text)?.[1];
      const range = /<[a-z]+:time-range start="([^"]+)" end="([^"]+)"/.exec(text);
      const expanding = /<[a-z]+:expand /.test(text);
      const out = [];
      for (const [name, o] of cal.objects) {
        let data = o.ics;
        if (uid !== undefined) {
          if (!parseIcs(o.ics).comps.some((e) => prop(e, "UID")?.value === unesc(uid))) continue;
        } else if (range) {
          const ms = (v) => instant(read({ value: v, params: "" }));
          data = expand(o.ics, ms(range[1]), ms(range[2]), expanding);
          if (!data) continue;
        }
        out.push(
          response(
            `${HOME}${encodeURIComponent(id)}/${encodeURIComponent(name)}`,
            `<d:getetag>${esc(o.etag)}</d:getetag><cal:calendar-data>${esc(data)}</cal:calendar-data>`,
          ),
        );
      }
      return send(207, multistatus(out));
    }
    return send(405);
  }

  if (!cal) return send(404, error("Sabre\\DAV\\Exception\\NotFound", `Calendar ${id} not found`));
  const had = cal.objects.get(file);
  if (race && req.method === "PUT" && had) {
    race = false;
    had.etag = etag(); // someone else saved it between the read and this write
  }
  const ifMatch = req.headers["if-match"];
  const precondition = () =>
    send(
      412,
      error(
        "Sabre\\DAV\\Exception\\PreconditionFailed",
        "An If-Match header was specified, but none of the specified ETags matched.",
      ),
    );
  if (req.method === "GET")
    return had
      ? send(200, had.ics, { "Content-Type": "text/calendar; charset=utf-8", ETag: had.etag })
      : send(404);
  if (req.method === "PUT") {
    if (req.headers["if-none-match"] === "*" && had) return precondition();
    if (ifMatch && (!had || had.etag !== ifMatch)) return precondition();
    if (!/BEGIN:VEVENT/.test(text))
      return send(415, error("Sabre\\DAV\\Exception\\UnsupportedMediaType", "Not iCalendar"));
    const saved = { ics: text, etag: etag() };
    cal.objects.set(file, saved);
    return send(had ? 204 : 201, "", { ETag: saved.etag });
  }
  if (req.method === "MOVE") {
    if (!had) return send(404);
    if (ifMatch && had.etag !== ifMatch) return precondition();
    const to = decodeURIComponent(
      new URL(req.headers.destination, `http://localhost:${PORT}`).pathname,
    );
    const [toId, toFile] = to.slice(HOME.length).split("/");
    const target = calendars.get(toId);
    if (!to.startsWith(HOME) || !target || !toFile)
      return send(409, error("Sabre\\DAV\\Exception\\Conflict", "No such destination"));
    if (target.readOnly)
      return send(
        403,
        error("Sabre\\DAV\\Exception\\Forbidden", "You are not allowed to write here"),
      );
    if (target.objects.has(toFile)) return precondition();
    cal.objects.delete(file);
    target.objects.set(toFile, { ics: had.ics, etag: etag() });
    return send(201);
  }
  if (req.method === "DELETE") {
    if (!had) return send(404);
    if (ifMatch && had.etag !== ifMatch) return precondition();
    cal.objects.delete(file);
    return send(204);
  }
  return send(405);
};

createServer((req, res) => {
  handle(req, res).catch((e) => {
    res.writeHead(500);
    res.end(String(e?.stack ?? e));
  });
}).listen(PORT, () => console.log(`mock Nextcloud on http://localhost:${PORT}`));
