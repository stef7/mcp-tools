/**
 * mcp-nc — Nextcloud calendars -> MCP, over CalDAV.
 *
 *  POST /https://cloud.example.com        the Nextcloud in the path (see nextcloudInPath)
 *  POST /?nc=cloud.example.com            the same, as a query parameter
 *  …?tz=Australia/Melbourne               what a time without an offset means, and how times
 *                                         are shown
 *
 * The login is not stored here. It arrives on every request in the connector's X-Auth-Token
 * header as `login:app password` (Nextcloud -> Personal settings -> Security -> Create new app
 * password), is sent to that Nextcloud as Basic auth and nowhere else, and appears in no tool
 * result, error or log. Who may reach the worker at all is Cloudflare Access's business, as for
 * every worker here. Like mcp-helios and mcp-printify it is not bound into mcp-toolkit: it acts
 * on one person's account, so it gets its own URL and its own Access policy.
 *
 * Calendars only, and within them events only: no tasks, no contacts, no inviting attendees.
 * Reading runs freely. Every write needs user_confirmed, is refused if the event changed on the
 * server since it was read, and leaves alone whatever in an event it was not asked about.
 */
import cfg from "../wrangler.json";
import { version } from "../package.json";
import { mcpWorker } from "../../../core/mcp";
import { baseOf, zoneParam } from "./dav";
import { ncTools, report } from "./tools";

const Worker = mcpWorker({
  ...cfg,
  version,
  tools: ncTools(),
  /** Opening the URL in a browser says which Nextcloud this is for and what is missing. */
  status: (c) => report(c),
  info(c) {
    let base: string | null = null;
    try {
      base = baseOf(c.params);
    } catch {
      // A bad address is reported by nc_status and the GET page; initialize must still answer.
    }
    const zone = zoneParam(c.params);
    return {
      title: c.params.get("title") ?? "Nextcloud Calendar",
      description: base ? `Calendars on ${base}` : "Nextcloud calendars over CalDAV.",
      ...(base ? { websiteUrl: base } : {}),
      instructions:
        `Calendars on ${base ?? "a Nextcloud"}. nc_list_calendars for the calendars, ` +
        "nc_list_events for what is on (a repeating event appears once per occurrence), " +
        "nc_get_event for one in full. Dates: 2026-11-20 is an all-day date, 2026-11-20T10:00 " +
        "a clock time in the time zone in use, 2026-11-20T10:00+11:00 an exact moment. " +
        (zone
          ? `The time zone in use is ${zone} unless a call names another. `
          : "No time zone is set on this connector, so pass `timezone` with any time that has " +
            "no offset, and ask the user for theirs rather than assuming one. ") +
        "An all-day event's end is its last day. Tools named create_, update_ and delete_ " +
        "change the calendar and need user_confirmed: true, given only once the user has " +
        "agreed to that exact change. Read an event before changing it, send only the fields " +
        "that differ, and never guess a uid. For a repeating event say which is meant: leave " +
        "`occurrence` out for the whole series, or pass the occurrence's value from " +
        "nc_list_events for that one alone. An event with attendees also needs " +
        "notify_attendees: true, because Nextcloud may email them. If something fails, " +
        "nc_status says what is wrong with the connection.",
    };
  },
});

/**
 * The Nextcloud named in the path — `/https://cloud.example.com` or, for one installed in a
 * folder, `/https://example.com/nextcloud` — or null when the path names none. Only a path that
 * starts with a scheme counts, so `/` and stray requests such as `/favicon.ico` do not. Some
 * clients and proxies merge `//` into `/`, and some percent-encode the colon, so `/https:/host`
 * and `/https%3A%2F%2Fhost` count too.
 */
export const nextcloudInPath = (url: URL): string | null => {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null; // a malformed escape is not an address
  }
  if (!/^\/https?:/i.test(path)) return null;
  return path
    .slice(1)
    .replace(/^(https?):\/*/i, (_, scheme: string) => `${scheme.toLowerCase()}://`);
};

/**
 * Moves a Nextcloud named in the path into `?nc=` before anything else reads the request. The
 * path wins over a `?nc=` alongside it: one connector URL, one answer to which Nextcloud.
 */
export default class extends Worker {
  override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const base = nextcloudInPath(url);
    if (!base) return super.fetch(request);
    url.pathname = "/";
    url.searchParams.set("nc", base);
    return super.fetch(new Request(url, request));
  }
}
