/**
 * The Events Calendar. Its events, venues and organisers are custom post types, so wp/v2 can read
 * them but cannot set a start date, a venue or a cost — those live in meta. TEC ships its own REST
 * namespace that does, and these tools use it. Added automatically when a site exposes
 * `tribe/events/v1`, and the plain wp/v2 write tools step aside for those three types.
 *
 * Verified against The Events Calendar 6.17.3.1 (Single_Event.php CREATE_args / EDIT_args).
 */
import type { JSONSchema, Tools } from "../../../core/mcp";
import { api, apiError, stripHtml, type Creds, type Schema } from "./wp";

export const NAMESPACE = "tribe/events/v1";
/** Post types TEC owns. wp/v2 writes for these would silently drop the event meta. */
export const TEC_TYPES = ["tribe_events", "tribe_venue", "tribe_organizer"];

const S = (description: string): JSONSchema => ({ type: "string", description });
const B = (description: string): JSONSchema => ({ type: "boolean", description });
const LIST = (description: string): JSONSchema => ({
  type: "array",
  items: { type: "string" },
  description,
});

const EVENT: Record<string, JSONSchema> = {
  title: S("Event name."),
  start_date: S('Local start, "YYYY-MM-DD HH:MM:SS". Required when creating.'),
  end_date: S('Local end, "YYYY-MM-DD HH:MM:SS". Required when creating.'),
  timezone: S('Olson timezone, e.g. "Australia/Sydney". Defaults to the site setting.'),
  all_day: B("All-day event; start and end times are then ignored."),
  description: S("Body content. Block markup is allowed and is what the site editor expects."),
  excerpt: S("Short summary shown in listings."),
  slug: S("URL slug."),
  status: S("publish, draft, pending, private or future."),
  cost: S('Ticket price as displayed, e.g. "Free" or "$20".'),
  website: S('Event website URL. Pass "" to clear it — WordPress auto-embeds what is stored here.'),
  image: S("Featured image: an attachment ID or a URL to sideload."),
  venue: S("Venue ID, or a venue name to attach by name."),
  organizer: S("Organizer ID, or an organizer name to attach by name."),
  categories: LIST("Event categories, by name, slug or ID."),
  tags: LIST("Tags, by name, slug or ID."),
  show_map: B("Show the venue map on the event page."),
  show_map_link: B("Show a link to the venue map."),
  hide_from_listings: B("Keep the event out of calendar views."),
  sticky: B("Pin to the top of listings."),
  featured: B("Mark as a featured event."),
};

const VENUE: Record<string, JSONSchema> = {
  venue: S("Venue name. Required when creating."),
  address: S("Street address. Needed for complete structured data on event pages."),
  city: S("Suburb or city."),
  state_province: S('State, e.g. "NSW".'),
  zip: S("Postcode."),
  country: S('Country, e.g. "Australia".'),
  phone: S("Phone number."),
  website: S("Venue website URL."),
  show_map: B("Show the map for this venue."),
  show_map_link: B("Show the map link for this venue."),
};

const ORGANIZER: Record<string, JSONSchema> = {
  organizer: S("Organiser name. Required when creating."),
  email: S("Contact email."),
  phone: S("Contact phone."),
  website: S("Organiser website URL."),
  description: S("About the organiser."),
};

/** The three TEC resources, each identical apart from its fields and its required ones. */
const RESOURCES = {
  tribe_event: {
    path: "events",
    label: "event",
    fields: EVENT,
    required: ["title", "start_date", "end_date"],
  },
  tribe_venue: { path: "venues", label: "venue", fields: VENUE, required: ["venue"] },
  tribe_organizer: {
    path: "organizers",
    label: "organiser",
    fields: ORGANIZER,
    required: ["organizer"],
  },
} as const;

type Resource = (typeof RESOURCES)[keyof typeof RESOURCES];
type Args = Record<string, unknown>;

const root = (s: Schema) => `${s.base}/wp-json/${NAMESPACE}`;

const send = async (url: string, creds: Creds, method: string, body?: Args) => {
  const { res, body: out, text } = await api(url, creds, { method, ...(body && { body }) });
  if (!res.ok) throw new Error(apiError(url, res, out, text));
  return (out ?? {}) as Args;
};

/** TEC echoes the whole record back; show the parts a human checks, then the raw JSON. */
const describe = (r: Args, what: string) => {
  const title = stripHtml(String((r["title"] as string) ?? r["venue"] ?? r["organizer"] ?? ""));
  return (
    `${what}: ${title || "(untitled)"}\n` +
    `ID: ${r["id"]} | status: ${r["status"] ?? "?"}\n` +
    (r["start_date"] ? `When: ${r["start_date"]} — ${r["end_date"]}\n` : "") +
    (r["url"] ? `URL: ${r["url"]}\n` : "") +
    `\n${JSON.stringify(r, null, 2).slice(0, 4000)}`
  );
};

/** Only the fields actually supplied are sent, so an update never disturbs the rest. */
const pick = (args: Args, res: Resource) =>
  Object.fromEntries(
    Object.keys(res.fields)
      .filter((k) => args[k] !== undefined)
      .map((k) => [k, args[k]]),
  );

const missing = (args: Args, res: Resource) =>
  res.required.filter((k) => args[k] === undefined || args[k] === "");

/** Write tools appear only for sites you have a login for; the listing tool is always there. */
export const tecTools = (s: Schema, creds: Creds | null): Tools => {
  const tools: Tools = {};

  // wp/v2 and TEC's own listing both hide past events; this is the way to enumerate everything.
  tools["list_tribe_events_all"] = {
    description:
      "List events including past ones, which the search tools hide. Ordered by start date. " +
      "Use this to find the ID of an event that has already happened.",
    input: {
      type: "object",
      properties: {
        start_date: S('Earliest start date. Defaults to "2000-01-01", i.e. everything.'),
        end_date: S("Latest start date. Defaults to no limit."),
        search: S("Match against event titles and content."),
        status: S("publish, draft, pending, private. Needs a login for anything but publish."),
        page: { type: "integer", description: "Page number (default 1)." },
        per_page: { type: "integer", description: "Events per page (1-50, default 50)." },
      },
    },
    run: async (args: Args) => {
      const p = new URLSearchParams({
        start_date: String(args["start_date"] ?? "2000-01-01"),
        per_page: String(Math.min(Number(args["per_page"] ?? 50), 50)),
        page: String(args["page"] ?? 1),
      });
      for (const k of ["end_date", "search", "status"]) {
        if (args[k] !== undefined) p.set(k, String(args[k]));
      }
      const url = `${root(s)}/events?${p}`;
      const { res, body, text } = await api(url, creds, {});
      if (!res.ok) throw new Error(apiError(url, res, body, text));
      const data = (body ?? {}) as { total?: number; total_pages?: number; events?: Args[] };
      const events = data.events ?? [];
      if (!events.length) return "No events found in that range.";
      const lines = events.map(
        (e) =>
          `• ${stripHtml(String(e["title"] ?? ""))}\n` +
          `  ID: ${e["id"]} | ${e["start_date"]} | ${e["status"]}` +
          (e["venue"] && typeof e["venue"] === "object"
            ? ` | ${(e["venue"] as Args)["venue"]}`
            : "") +
          (e["website"] ? `\n  website: ${e["website"]}` : "") +
          `\n  ${e["url"]}`,
      );
      return `${data.total ?? events.length} event(s), page ${args["page"] ?? 1} of ${
        data.total_pages ?? 1
      }:\n\n${lines.join("\n")}\n`;
    },
  };

  if (!creds) return tools;
  const auth = creds; // narrowed once, so the closures below do not each have to re-check

  for (const [name, res] of Object.entries(RESOURCES) as [string, Resource][]) {
    const id = { id: { type: "integer", description: `The ${res.label} ID.` } };
    const schema = (withId: boolean, required: readonly string[]): JSONSchema => ({
      type: "object",
      properties: withId ? { ...id, ...res.fields } : res.fields,
      required: [...required],
    });

    tools[`create_${name}`] = {
      description: `Create a ${res.label} in The Events Calendar on ${new URL(s.base).hostname}.`,
      confirm: true,
      annotations: { destructiveHint: false },
      input: schema(false, res.required),
      run: async (args: Args) => {
        const gaps = missing(args, res);
        if (gaps.length) return `Missing required field(s): ${gaps.join(", ")}.`;
        const made = await send(`${root(s)}/${res.path}`, auth, "POST", pick(args, res));
        return describe(made, `Created ${res.label}`);
      },
    };

    tools[`update_${name}`] = {
      description:
        `Update one ${res.label} in The Events Calendar. Send only the fields you are changing; ` +
        "everything else is left alone.",
      confirm: true,
      input: schema(true, ["id"]),
      run: async (args: Args & { id?: number }) => {
        if (!args.id) return "Missing required field: id.";
        const fields = pick(args, res);
        if (!Object.keys(fields).length) return "Nothing to update: no fields were supplied.";
        const saved = await send(`${root(s)}/${res.path}/${args.id}`, auth, "POST", fields);
        return describe(saved, `Updated ${res.label}`);
      },
    };

    tools[`delete_${name}`] = {
      description: `Move one ${res.label} to the trash. Recoverable from wp-admin.`,
      confirm: true,
      annotations: { destructiveHint: true },
      input: { type: "object", required: ["id"], properties: id },
      run: async ({ id }: { id: number }) => {
        await send(`${root(s)}/${res.path}/${id}`, auth, "DELETE");
        return `Moved ${res.label} ${id} to the trash.`;
      },
    };
  }

  return tools;
};
