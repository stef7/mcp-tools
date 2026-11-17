/**
 * The one place that talks to Nextcloud: CalDAV over HTTP with Basic auth.
 *
 * Two promises are kept here. The login goes to the Nextcloud the connector names and nowhere
 * else: every address is checked against that origin and no redirect is followed. And nothing
 * that leaves this file can contain the password: errors are scrubbed before they are thrown.
 */
import type { Ctx } from "../../../core/mcp";
import { version } from "../package.json";

export const UA = `mcp-nc/${version} (MCP server for Nextcloud calendars, on Cloudflare Workers)`;
const TIMEOUT_MS = 30_000;

export const NS = {
  D: "DAV:",
  C: "urn:ietf:params:xml:ns:caldav",
  CS: "http://calendarserver.org/ns/",
  A: "http://apple.com/ns/ical/",
  OC: "http://owncloud.org/ns",
  NC: "http://nextcloud.com/ns",
  S: "http://sabredav.org/ns",
} as const;
const XMLNS =
  `xmlns:d="${NS.D}" xmlns:c="${NS.C}" xmlns:cs="${NS.CS}" xmlns:a="${NS.A}" ` +
  `xmlns:oc="${NS.OC}" xmlns:nc="${NS.NC}"`;

// ─── Which Nextcloud, and whose login ──────────────────────────────────────────────────────────

export type Conn = {
  base: string;
  user: string;
  pass: string;
  /** Which header the login came by, for nc_status. */
  via: "X-Auth-Token" | "X-API-Key";
};

const SETUP =
  "Name the Nextcloud in the connector URL, as a path (https://mcp-nc…/https://cloud.example.com) " +
  "or as ?nc=cloud.example.com, or set NC_URL on the worker. Send the login in the X-Auth-Token " +
  'header as "login:app password" (Nextcloud -> Personal settings -> Security -> Devices & ' +
  "sessions -> Create new app password), or send just the login name in X-API-Key and keep the " +
  "app password in the worker's NC_PASSWORD secret.";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An address as someone typed it -> where Nextcloud is installed, with no trailing slash. */
const normalise = (raw: string, where: string) => {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`${where}: "${raw}" is not an address. ${SETUP}`);
  }
  if (url.username || url.password)
    throw new Error("Put the login in a header, never in the Nextcloud address.");
  if (url.protocol !== "https:" && !LOCAL.has(url.hostname))
    throw new Error("The Nextcloud address must be https: the login travels with every request.");
  // Someone pasting the CalDAV address from Nextcloud's settings means the install it is under.
  const path = url.pathname.replace(/\/(remote\.php|index\.php|apps)(\/.*)?$/, "");
  return url.origin + path.replace(/\/+$/, "");
};

type Where = Pick<Ctx, "params" | "env">;

/** The worker's own Nextcloud: the NC_URL variable. Null when unset. */
export const homeBase = (env: Env) => {
  const raw = env.NC_URL?.trim();
  return raw ? normalise(raw, "NC_URL") : null;
};

/**
 * Which Nextcloud this request is for: the one the connector URL names (`?nc=`, which is also
 * where a path ends up), else the worker's NC_URL. Null when neither is set.
 */
export const baseOf = (c: Where): string | null => {
  const raw = c.params.get("nc")?.trim();
  return raw ? normalise(raw, "The connector URL") : homeBase(c.env);
};

/** The display zone the connector asked for with `?tz=`, if any. */
export const zoneParam = (params: URLSearchParams) => params.get("tz")?.trim() || undefined;

/**
 * Who is signing in. Either the whole login arrives with the request:
 *
 *   X-Auth-Token: login:app password      a login name cannot contain a colon; a password can
 *
 * or only the name does, and the worker supplies the password it keeps:
 *
 *   X-API-Key: login                      + the NC_PASSWORD secret
 *
 * Both names are ones Claude lets any connector send. X-Auth-Token wins when both are there.
 *
 * The stored password goes to the worker's own NC_URL and nowhere else. A connector URL can name
 * any host, so sending NC_PASSWORD wherever the URL points would hand it to whoever asked; a
 * request for another Nextcloud has to bring its own X-Auth-Token.
 */
export const connOf = (c: Pick<Ctx, "params" | "headers" | "env">): Conn => {
  const base = baseOf(c);
  if (!base)
    throw new Error(`No Nextcloud address: none on the connector, and no NC_URL. ${SETUP}`);
  const token = c.headers["x-auth-token"]?.trim();
  if (token) {
    const at = token.indexOf(":");
    if (at <= 0 || at === token.length - 1)
      throw new Error('X-Auth-Token is unreadable: it should be "login:app password".');
    return {
      base,
      user: token.slice(0, at).trim(),
      pass: token.slice(at + 1).trim(),
      via: "X-Auth-Token",
    };
  }
  const user = c.headers["x-api-key"]?.trim();
  if (!user) throw new Error(`No X-Auth-Token or X-API-Key header reached this worker. ${SETUP}`);
  if (user.includes(":"))
    throw new Error(
      "X-API-Key carries the login name only. A whole login:password belongs in X-Auth-Token.",
    );
  const pass = c.env.NC_PASSWORD?.trim();
  if (!pass)
    throw new Error(
      "X-API-Key names a login, but the worker has no NC_PASSWORD secret to go with it. Set " +
        "one (npx wrangler secret put NC_PASSWORD), or send the whole login in X-Auth-Token.",
    );
  if (base !== homeBase(c.env))
    throw new Error(
      "The worker's stored password is sent only to its own Nextcloud (NC_URL), and this " +
        "connector names a different one. Send that Nextcloud's login in X-Auth-Token.",
    );
  return { base, user, pass, via: "X-API-Key" };
};

// ─── XML, as much of it as WebDAV uses ─────────────────────────────────────────────────────────

export type Node = {
  ns: string;
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
};

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1))
      : (ENTITIES[e.toLowerCase()] ?? whole),
  );
export const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (ch) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot", "'": "apos" }[ch]};`,
  );

const TOKEN =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^>\s]+)\s*>|<([^>\s/]+)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A namespace-aware tree of a WebDAV response. */
export const parseXml = (source: string): Node => {
  const root: Node = { ns: "", name: "", attrs: {}, children: [], text: "" };
  const stack: { node: Node; scope: Record<string, string> }[] = [{ node: root, scope: {} }];
  for (const m of source.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.node.text += m[1];
    else if (m[6] !== undefined) top.node.text += decode(m[6]);
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const scope = { ...top.scope };
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(ATTR)) {
        const value = decode(a[2] ?? a[3] ?? "");
        if (a[1] === "xmlns") scope[""] = value;
        else if (a[1]!.startsWith("xmlns:")) scope[a[1]!.slice(6)] = value;
        else attrs[a[1]!] = value;
      }
      const colon = m[3].indexOf(":");
      const node: Node = {
        ns: scope[colon < 0 ? "" : m[3].slice(0, colon)] ?? "",
        name: m[3].slice(colon + 1),
        attrs,
        children: [],
        text: "",
      };
      top.node.children.push(node);
      if (!m[5]) stack.push({ node, scope });
    }
  }
  return root;
};

export const child = (n: Node | undefined, ns: string, name: string) =>
  n?.children.find((c) => c.ns === ns && c.name === name);
export const children = (n: Node | undefined, ns: string, name: string) =>
  n?.children.filter((c) => c.ns === ns && c.name === name) ?? [];
/** The first descendant with this name, depth first. */
export const descend = (n: Node | undefined, ns: string, name: string): Node | undefined => {
  for (const c of n?.children ?? []) {
    if (c.ns === ns && c.name === name) return c;
    const deeper = descend(c, ns, name);
    if (deeper) return deeper;
  }
  return undefined;
};

// ─── Requests ──────────────────────────────────────────────────────────────────────────────────

export type Answer = { status: number; text: string; etag: string | null };

const scrub = (text: string, conn: Conn) =>
  conn.pass ? text.replaceAll(conn.pass, "[password]") : text;

const basic = (conn: Conn) => {
  const bytes = new TextEncoder().encode(`${conn.user}:${conn.pass}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
};

/**
 * An address the server handed back (an href in a listing) -> a full URL, refused unless it is
 * on the Nextcloud this connector names. That is what keeps the login from following a response
 * to some other host.
 */
export const resolve = (conn: Conn, href: string) => {
  const url = new URL(href, conn.base + "/");
  if (url.origin !== new URL(conn.base).origin)
    throw new Error(`Nextcloud pointed at another host (${url.origin}); not following it.`);
  return url.href;
};

type Init = { depth?: "0" | "1"; body?: string; type?: string; headers?: Record<string, string> };

export const dav = async (
  conn: Conn,
  method: string,
  href: string,
  init: Init = {},
): Promise<Answer> => {
  const url = resolve(conn, href);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      redirect: "manual",
      headers: {
        Authorization: basic(conn),
        "User-Agent": UA,
        ...(init.depth ? { Depth: init.depth } : {}),
        ...(init.body === undefined
          ? {}
          : { "Content-Type": init.type ?? "application/xml; charset=utf-8" }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(scrub(`Could not reach Nextcloud at ${new URL(url).origin}: ${why}`, conn));
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new Error(
      scrub(
        `Nextcloud at ${conn.base} redirected to ${res.headers.get("location") ?? "elsewhere"}. ` +
          "The login is not sent after a redirect: put the address it redirects to on the connector.",
        conn,
      ),
    );
  }
  const text = await res.text().catch(() => "");
  return { status: res.status, text: scrub(text, conn), etag: res.headers.get("etag") };
};

const hint = (status: number) =>
  status === 401
    ? " Nextcloud did not accept the login in X-Auth-Token: the login name or app password is " +
      "wrong, or the app password was revoked."
    : status === 403
      ? " The login may not do this here: a calendar shared read-only, or a subscription."
      : status === 404
        ? " Nothing is at that address: the calendar or event was deleted or renamed, or the " +
          "connector's Nextcloud address is not where Nextcloud is installed."
        : status === 412
          ? " The event changed on the server since it was read (or one with that UID already " +
            "exists). Nothing was written. Read it again and repeat the change."
          : status === 423
            ? " The calendar is locked by another operation. Try again shortly."
            : status === 503
              ? " Nextcloud is in maintenance mode or overloaded."
              : status === 507
                ? " The account is out of storage."
                : "";

/** Throws unless the status is one the caller expected, in Nextcloud's own words where it gave any. */
export const expect = (a: Answer, ok: number[], doing: string) => {
  if (ok.includes(a.status)) return a;
  let said = "";
  if (a.text.includes("<")) {
    const doc = parseXml(a.text);
    said = descend(doc, NS.S, "message")?.text.trim() ?? "";
  }
  if (!said && a.text && !/<html/i.test(a.text)) said = a.text.trim().slice(0, 500);
  throw new Error(
    `${doing}: Nextcloud answered HTTP ${a.status}.${hint(a.status)}${said ? ` It said: ${said}` : ""}`,
  );
};

/** One <response> of a multistatus: its address and the properties that were found. */
export type Entry = { href: string; props: Node };

export const multistatus = (text: string): Entry[] =>
  children(child(parseXml(text), NS.D, "multistatus"), NS.D, "response").map((r) => {
    // Only the propstat that succeeded: a 404 one lists the properties this resource lacks.
    const found = children(r, NS.D, "propstat").filter((p) =>
      / 2\d\d/.test(child(p, NS.D, "status")?.text ?? " 200"),
    );
    const props: Node = { ns: NS.D, name: "prop", attrs: {}, text: "", children: [] };
    for (const p of found) props.children.push(...(child(p, NS.D, "prop")?.children ?? []));
    return { href: child(r, NS.D, "href")?.text.trim() ?? "", props };
  });

const propfind = async (conn: Conn, href: string, depth: "0" | "1", props: string, doing: string) =>
  multistatus(
    expect(
      await dav(conn, "PROPFIND", href, {
        depth,
        body: `<?xml version="1.0"?><d:propfind ${XMLNS}><d:prop>${props}</d:prop></d:propfind>`,
      }),
      [207],
      doing,
    ).text,
  );

// ─── Discovery ─────────────────────────────────────────────────────────────────────────────────

/** Where each login's calendars live, remembered for the life of the isolate. */
const homes = new Map<string, { principal: string; home: string }>();

/**
 * The login's principal and calendar home, asked of the server rather than built from the login
 * name: someone who signs in with an email address has a user ID that is something else.
 */
export const discover = async (conn: Conn) => {
  const key = `${conn.base}\n${conn.user}`;
  const known = homes.get(key);
  if (known) return known;
  const root = await propfind(
    conn,
    `${conn.base}/remote.php/dav/`,
    "0",
    "<d:current-user-principal/>",
    "Signing in",
  );
  const principal = child(
    child(root[0]?.props, NS.D, "current-user-principal"),
    NS.D,
    "href",
  )?.text.trim();
  if (!principal)
    throw new Error(
      `${conn.base} answered, but not as a Nextcloud that knows who is signed in. Check the ` +
        "address on the connector.",
    );
  const who = await propfind(conn, principal, "0", "<c:calendar-home-set/>", "Finding calendars");
  const home = child(child(who[0]?.props, NS.C, "calendar-home-set"), NS.D, "href")?.text.trim();
  if (!home) throw new Error("This Nextcloud login has no calendars: is the Calendar app on?");
  const found = { principal, home: home.endsWith("/") ? home : home + "/" };
  homes.set(key, found);
  return found;
};

// ─── Calendars ─────────────────────────────────────────────────────────────────────────────────

export type Calendar = {
  /** The last part of its address: what tools take as `calendar`. */
  id: string;
  href: string;
  name: string;
  color?: string;
  description?: string;
  components: string[];
  can_write: boolean;
  /** Set for a calendar subscribed to from a URL: Nextcloud refreshes it, nobody edits it. */
  subscribed_from?: string;
  /** Set when someone else owns it and shared it with this login. */
  shared_by?: string;
};

const CALENDAR_PROPS =
  "<d:resourcetype/><d:displayname/><a:calendar-color/><c:calendar-description/>" +
  "<c:supported-calendar-component-set/><d:current-user-privilege-set/><cs:source/>" +
  "<oc:owner-principal/><nc:deleted-at/>";

const lastSegment = (href: string) => {
  const part = href.replace(/\/+$/, "").split("/").pop() ?? "";
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

export const listCalendars = async (conn: Conn): Promise<Calendar[]> => {
  const { home, principal } = await discover(conn);
  const entries = await propfind(conn, home, "1", CALENDAR_PROPS, "Listing calendars");
  const out: Calendar[] = [];
  for (const { href, props } of entries) {
    const type = child(props, NS.D, "resourcetype");
    const subscribed = !!child(type, NS.CS, "subscribed");
    if (!child(type, NS.C, "calendar") && !subscribed) continue; // inbox, outbox, trash bin
    if (child(props, NS.NC, "deleted-at")?.text.trim()) continue; // in the trash bin
    const privileges = children(
      child(props, NS.D, "current-user-privilege-set"),
      NS.D,
      "privilege",
    );
    const may = (name: string) => privileges.some((p) => child(p, NS.D, name));
    const color = child(props, NS.A, "calendar-color")?.text.trim();
    const description = child(props, NS.C, "calendar-description")?.text.trim();
    const source = child(child(props, NS.CS, "source"), NS.D, "href")?.text.trim();
    const owner = child(props, NS.OC, "owner-principal")?.text.trim();
    const components = children(
      child(props, NS.C, "supported-calendar-component-set"),
      NS.C,
      "comp",
    );
    const id = lastSegment(href);
    out.push({
      id,
      href: href.endsWith("/") ? href : href + "/",
      name: child(props, NS.D, "displayname")?.text.trim() || id,
      ...(color ? { color } : {}),
      ...(description ? { description } : {}),
      components: components.map((c) => c.attrs["name"] ?? "").filter(Boolean),
      can_write: !subscribed && (may("write") || may("write-content") || may("all")),
      ...(subscribed ? { subscribed_from: source ?? "a URL" } : {}),
      ...(owner && lastSegment(owner) !== lastSegment(principal)
        ? { shared_by: lastSegment(owner) }
        : {}),
    });
  }
  return out;
};

const slugOf = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "calendar";

const COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
export const checkColor = (color: string) => {
  if (!COLOR.test(color)) throw new Error(`color: "${color}" should be a hex colour like #0082c9.`);
  return color;
};

type CalendarFields = { name?: string; color?: string; description?: string };
const calendarProps = (f: CalendarFields) =>
  (f.name === undefined ? "" : `<d:displayname>${xml(f.name)}</d:displayname>`) +
  (f.color === undefined
    ? ""
    : `<a:calendar-color>${xml(checkColor(f.color))}</a:calendar-color>`) +
  (f.description === undefined
    ? ""
    : `<c:calendar-description>${xml(f.description)}</c:calendar-description>`);

/** Makes a calendar for events, at an address built from its name. Returns its id. */
export const createCalendar = async (conn: Conn, f: CalendarFields & { name: string }) => {
  const { home } = await discover(conn);
  const taken = new Set((await listCalendars(conn)).map((c) => c.id));
  const base = slugOf(f.name);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  // Extended MKCOL (RFC 5689) rather than MKCALENDAR: Workers' fetch refuses to send a method
  // it does not know, and MKCALENDAR is one. Nextcloud's own web client creates calendars this
  // way too.
  expect(
    await dav(conn, "MKCOL", `${home}${encodeURIComponent(id)}/`, {
      body:
        `<?xml version="1.0"?><d:mkcol ${XMLNS}><d:set><d:prop>` +
        `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>${calendarProps(f)}` +
        '<c:supported-calendar-component-set><c:comp name="VEVENT"/>' +
        "</c:supported-calendar-component-set></d:prop></d:set></d:mkcol>",
    }),
    [201],
    `Creating the calendar "${f.name}"`,
  );
  return id;
};

export const updateCalendar = async (conn: Conn, cal: Calendar, f: CalendarFields) => {
  const a = expect(
    await dav(conn, "PROPPATCH", cal.href, {
      body:
        `<?xml version="1.0"?><d:propertyupdate ${XMLNS}><d:set><d:prop>${calendarProps(f)}` +
        "</d:prop></d:set></d:propertyupdate>",
    }),
    [207],
    `Changing the calendar "${cal.name}"`,
  );
  // A 207 can still carry a refusal for one property; the status lines say which.
  const refused = [...a.text.matchAll(/HTTP\/1\.1 (\d{3})/g)].find((m) => !m[1]!.startsWith("2"));
  if (refused)
    throw new Error(
      `Changing the calendar "${cal.name}": Nextcloud refused with HTTP ${refused[1]}.` +
        hint(Number(refused[1])),
    );
};

export const deleteCalendar = async (conn: Conn, cal: Calendar) => {
  expect(await dav(conn, "DELETE", cal.href), [200, 204], `Deleting the calendar "${cal.name}"`);
};

// ─── Events ────────────────────────────────────────────────────────────────────────────────────

/** One calendar object as stored: its address, its version, and its iCalendar text. */
export type Stored = { href: string; etag: string; ics: string };

const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, "");

const query = async (conn: Conn, cal: Calendar, data: string, filter: string, doing: string) =>
  multistatus(
    expect(
      await dav(conn, "REPORT", cal.href, {
        depth: "1",
        body:
          `<?xml version="1.0"?><c:calendar-query ${XMLNS}><d:prop><d:getetag/>${data}</d:prop>` +
          '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">' +
          `${filter}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
      }),
      [207],
      doing,
    ).text,
  ).flatMap(({ href, props }): Stored[] => {
    const ics = child(props, NS.C, "calendar-data")?.text;
    return ics ? [{ href, etag: child(props, NS.D, "getetag")?.text.trim() ?? "", ics }] : [];
  });

/**
 * Events touching a span of time, with repeating ones expanded by the server into one VEVENT per
 * occurrence, each carrying the RECURRENCE-ID that names it. Times come back in UTC.
 */
export const eventsBetween = (conn: Conn, cal: Calendar, from: number, to: number) =>
  query(
    conn,
    cal,
    `<c:calendar-data><c:expand start="${utc(from)}" end="${utc(to)}"/></c:calendar-data>`,
    `<c:time-range start="${utc(from)}" end="${utc(to)}"/>`,
    `Reading events from "${cal.name}"`,
  );

/** The stored object holding this UID, exactly as saved (no expansion), or null. */
export const eventByUid = async (conn: Conn, cal: Calendar, uid: string) =>
  (
    await query(
      conn,
      cal,
      "<c:calendar-data/>",
      `<c:prop-filter name="UID"><c:text-match collation="i;octet">${xml(uid)}</c:text-match></c:prop-filter>`,
      `Looking up an event in "${cal.name}"`,
    )
  )[0] ?? null;

const ICS = "text/calendar; charset=utf-8";

/** Saves a new object; fails rather than overwrite one that already has that address. */
export const putNew = async (conn: Conn, cal: Calendar, uid: string, ics: string) => {
  const href = `${cal.href}${encodeURIComponent(uid)}.ics`;
  expect(
    await dav(conn, "PUT", href, { body: ics, type: ICS, headers: { "If-None-Match": "*" } }),
    [201, 204],
    `Saving the event to "${cal.name}"`,
  );
};

/** Saves over an object, only if it is still the version that was read. */
export const putOver = async (conn: Conn, was: Stored, ics: string) => {
  expect(
    await dav(conn, "PUT", was.href, {
      body: ics,
      type: ICS,
      headers: was.etag ? { "If-Match": was.etag } : {},
    }),
    [200, 201, 204],
    "Saving the event",
  );
};

export const deleteStored = async (conn: Conn, was: Stored) => {
  expect(
    await dav(conn, "DELETE", was.href, { headers: was.etag ? { "If-Match": was.etag } : {} }),
    [200, 204],
    "Deleting the event",
  );
};
