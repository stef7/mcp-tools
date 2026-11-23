/**
 * mcp-happyhousesitters — house sits listed on happyhousesitters.com.au, read without a login.
 *
 *   happyhousesitters_around_date   sits starting near a date (or under way on it), closest first
 *   happyhousesitters_search        one page, or every page, of the site's own search
 *   happyhousesitters_get_sit       the full ad: about, pets, house tasks, facilities, photos
 *   happyhousesitters_suburbs       suburb or postcode -> the postcode_id the search takes
 *   happyhousesitters_filters       the zones, animals and facilities the filters accept
 *
 * No credentials. Applying to a sit needs a paid membership on the site itself.
 */
import cfg from "../wrangler.json";
import { version } from "../package.json";
import { mcpWorker, tool } from "../../../core/mcp";
import {
  ANIMALS,
  BUCKETS,
  FACILITIES,
  SORTS,
  STATES,
  ZONES,
  fetchAd,
  fetchAll,
  fetchPage,
  msDate,
  normalise,
  rankAround,
  suburbs,
  today,
  type Query,
} from "./hhs";

const BUCKET_KEYS = Object.keys(BUCKETS) as (keyof typeof BUCKETS)[];

/** The site's own filters, shared by both search tools. */
const FILTERS = {
  state: {
    type: "string",
    enum: ["", ...STATES],
    description: "One state or territory. Empty or omitted: all of Australia.",
  },
  zone: {
    type: ["string", "integer"],
    description:
      "An area within a state, by id or part of its name, e.g. 'Melb. Inner', 'Geelong', 42. " +
      "happyhousesitters_filters lists them.",
  },
  postcode_id: {
    type: "integer",
    description:
      "Nearest to this suburb: the postcode_id from happyhousesitters_suburbs. Pair with " +
      "sort 'closest' to get distances.",
  },
  animals: {
    type: "array",
    items: { type: "string" },
    description: `Animal types, any of: ${Object.keys(ANIMALS).join(", ")}.`,
  },
  facilities: {
    type: "array",
    items: { type: "string" },
    description: "Property or neighbourhood facilities, e.g. wifi, train, beach.",
  },
  sit_length: {
    type: "array",
    items: { type: "string", enum: BUCKET_KEYS },
    description: "Sit length buckets in days. Cannot be combined with start_date/end_date.",
  },
  no_garden_lawn_care: { type: "boolean", description: "Only sits with no garden or lawn care." },
} as const;

/** The filters among a tool's args, plus `extra` keys, leaving out anything not given. */
const query = (a: Record<string, unknown>, extra: (keyof Query)[] = []): Query => {
  const q: Record<string, unknown> = {};
  for (const k of [...Object.keys(FILTERS), ...extra]) if (a[k] !== undefined) q[k] = a[k];
  return q as Query;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export default mcpWorker({
  ...cfg,
  version,
  info: () => ({
    title: "Happy House Sitters",
    description: "House and pet sits listed on happyhousesitters.com.au.",
    websiteUrl: "https://www.happyhousesitters.com.au/sits/search",
    instructions:
      "To line up a sit with a move-out date, use around_date. Dates are YYYY-MM-DD in " +
      "eastern Australian time. Open a promising sit with get_sit for the house tasks and pets.",
  }),
  tools: {
    around_date: tool({
      description:
        "Find house sits that start close to a target date, e.g. a move-out date, closest first. " +
        "Reads the site's listings sorted by start date and ranks them here, because the site's " +
        "own date filter drops any sit that runs past the end of the range. Each result carries " +
        "start_offset_days (start minus target; negative means it began earlier), covers_target " +
        "(already under way on the target date, so you could move in that day) and " +
        "days_from_target (nights it gives you from the target date on). Sits whose applications " +
        "have closed are left out unless include_closed.",
      input: {
        type: "object",
        required: ["target_date"],
        properties: {
          target_date: { type: "string", description: "YYYY-MM-DD, e.g. 2027-01-15." },
          before_days: {
            type: "integer",
            default: 10,
            description: "Also take sits starting up to this many days before the target.",
          },
          after_days: {
            type: "integer",
            default: 14,
            description: "And up to this many days after it.",
          },
          include_covering: {
            type: "boolean",
            default: true,
            description: "Also take sits that started earlier but are still running on the date.",
          },
          min_days_from_target: {
            type: "integer",
            default: 0,
            description: "Drop sits giving fewer nights than this from the target date on.",
          },
          include_closed: {
            type: "boolean",
            default: false,
            description: "Keep sits whose application close date has passed.",
          },
          limit: { type: "integer", default: 30, description: "Most results to return." },
          max_pages: {
            type: "integer",
            default: 40,
            description: "Most result pages (15 sits each) to read.",
          },
          ...FILTERS,
        },
      },
      async run(a) {
        if (!ISO.test(a.target_date)) throw new Error("target_date must be YYYY-MM-DD.");
        const before = a.before_days ?? 10;
        const after = a.after_days ?? 14;
        const q = { ...query(a), sort: "starting_soonest" as const };
        const last = new Date(Date.parse(a.target_date + "T00:00:00Z") + after * 86_400_000)
          .toISOString()
          .slice(0, 10);
        // Sorted by start, so once a page ends past the window nothing later can be in it.
        const got = await fetchAll(q, a.max_pages ?? 40, (items) => {
          const end = msDate(items.at(-1)?.dtSittingStart);
          return !!end && end > last;
        });
        const ranked = rankAround(
          got.items.map((s) => normalise(s, 300)),
          {
            target: a.target_date,
            before_days: before,
            after_days: after,
            include_covering: a.include_covering ?? true,
            min_days_from_target: a.min_days_from_target ?? 0,
            include_closed: a.include_closed ?? false,
            today: today(),
          },
        );
        const limit = a.limit ?? 30;
        return {
          target_date: a.target_date,
          window: `starts ${before} day(s) before to ${after} after${a.include_covering === false ? "" : ", or under way on the date"}`,
          listings_matching_filters: got.total,
          pages_read: `${got.read} of ${got.pages}`,
          found: ranked.length,
          ...(ranked.length > limit ? { showing: limit } : {}),
          sits: ranked.slice(0, limit),
        };
      },
    }),

    search: tool({
      description:
        "Search listed house sits with the site's own filters. Returns one page (15 sits) or, " +
        "with all_pages, every page up to max_pages. start_date/end_date are the site's 'Sits " +
        "between' filter, which only matches sits lying wholly inside the range; for sits near " +
        "a date use happyhousesitters_around_date instead.",
      input: {
        type: "object",
        properties: {
          ...FILTERS,
          starting_in: {
            type: "array",
            items: { type: "string", enum: BUCKET_KEYS },
            description: "Starting within these many days from today. Not with start/end dates.",
          },
          start_date: { type: "string", description: "YYYY-MM-DD: sits starting on or after." },
          end_date: { type: "string", description: "YYYY-MM-DD: sits ending on or before." },
          sort: {
            type: "string",
            enum: Object.keys(SORTS) as (keyof typeof SORTS)[],
            default: "starting_soonest",
          },
          page: { type: "integer", default: 1 },
          all_pages: { type: "boolean", default: false },
          max_pages: { type: "integer", default: 20 },
        },
      },
      async run(a) {
        const q = query(a, ["starting_in", "start_date", "end_date", "sort"]);
        for (const d of [a.start_date, a.end_date])
          if (d && !ISO.test(d)) throw new Error(`Dates must be YYYY-MM-DD, not "${d}".`);
        if (a.all_pages) {
          const got = await fetchAll(q, a.max_pages ?? 20);
          return {
            total: got.total,
            pages_read: `${got.read} of ${got.pages}`,
            sits: got.items.map((s) => normalise(s)),
          };
        }
        const p = await fetchPage(q, a.page ?? 1);
        return {
          total: p.TotalCount,
          page: `${p.Page} of ${p.PageCount}`,
          sits: p.Items.map((s) => normalise(s)),
        };
      },
    }),

    get_sit: tool({
      description:
        "Read one house sit's full ad: about the home, pets and farm animals, house tasks, " +
        "property and neighbourhood facilities, garden care, the owner's first name, photos.",
      input: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: ["integer", "string"],
            description: "The sit's id (e.g. 153743) or its URL (…/sits/ad-153743).",
          },
        },
      },
      async run({ id }) {
        const n = Number(/(\d+)\D*$/.exec(String(id))?.[1]);
        if (!n) throw new Error(`No sit id in "${id}".`);
        return (
          (await fetchAd(n)) ?? { error: `Sit ${n} was not found; it may have been taken down.` }
        );
      },
    }),

    suburbs: tool({
      description:
        "Look up a suburb or postcode and get the postcode_id that search and around_date take " +
        "for 'nearest to'.",
      input: {
        type: "object",
        required: ["term"],
        properties: { term: { type: "string", description: "e.g. 'Brunswick' or '3056'." } },
      },
      run: ({ term }) => suburbs(term),
    }),

    filters: tool({
      description:
        "List the values the search filters accept: zones by state, animals, facilities.",
      run: () => ({
        states: STATES,
        zones: ZONES.map(([id, state, name]) => ({ id, state, name })),
        animals: Object.keys(ANIMALS),
        facilities: Object.keys(FACILITIES),
        length_and_starting_in_buckets: BUCKET_KEYS,
        sorts: Object.keys(SORTS),
      }),
    }),
  },
});
