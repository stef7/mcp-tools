/**
 * mcp-happyhousesitters, against copies of what the site really sent (trimmed). The site is
 * never called: `fetch` is stubbed per test.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import Worker from "../workers/mcp-happyhousesitters/src/index";
import {
  daysBetween,
  msDate,
  normalise,
  parseAd,
  rankAround,
  searchParams,
  zoneId,
  type RawSit,
} from "../workers/mcp-happyhousesitters/src/hhs";

type Spec = { name: string; annotations: Record<string, boolean> };
const worker = () => new Worker(createExecutionContext(), env);

const sit = (id: number, start: string, end: string, close = "/Date(1798635600000)/"): RawSit => ({
  Sittingid: id,
  Title: `SUBURB ${id}, VIC`,
  Region: "Melb. Inner suburbs",
  Rating: 4,
  ReducedContact: false,
  PropertyType: "House",
  Length: 1,
  Pets: "Dog(s)",
  dtSittingStart: start,
  dtSittingEnd: end,
  Dates: "",
  Description: "A home.\r\nNear the beach.",
  dtApplicationClose: close,
  PostedAge: "in the last 10 days",
  Latitude: -37.9,
  Longitude: 145,
  IsNew: true,
});

// Real values from /sits/results: 5 Dec 2026 – 15 Jan 2027 (Hampton), 8 Dec – 21 Jan (South
// Dudley), 26–29 Nov 2026 (Footscray), 28 Nov – 31 Jan 2027 (Scoresby).
const HAMPTON = sit(153743, "/Date(1796389200000)/", "/Date(1799931600000)/");
const DUDLEY = sit(153216, "/Date(1796648400000)/", "/Date(1800450000000)/");
const FOOTSCRAY = sit(153569, "/Date(1795611600000)/", "/Date(1795870800000)/");
const SCORESBY = sit(153757, "/Date(1795784400000)/", "/Date(1801314000000)/");
// 18–29 Jan 2027 (Highett), built from the dates the ad shows.
const HIGHETT = sit(153754, "/Date(1800190800000)/", "/Date(1801141200000)/");

describe("the tool list", () => {
  it("carries the worker's prefix and only reads", async () => {
    const specs = (await worker().tools({})) as Spec[];
    expect(specs.map((t) => t.name)).toEqual([
      "happyhousesitters_around_date",
      "happyhousesitters_search",
      "happyhousesitters_get_sit",
      "happyhousesitters_suburbs",
      "happyhousesitters_filters",
    ]);
    expect(specs.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });
});

describe("dates", () => {
  it("reads the site's epoch milliseconds as the eastern Australian date", () => {
    expect(msDate("/Date(1796389200000)/")).toBe("2026-12-05");
    expect(msDate("/Date(1799931600000)/")).toBe("2027-01-15");
    expect(msDate(null)).toBeNull();
  });

  it("counts whole days across a month end", () => {
    expect(daysBetween("2026-12-30", "2027-01-15")).toBe(16);
  });
});

describe("the query string", () => {
  it("matches what the site's own page sends", () => {
    const p = searchParams({ state: "vic" }, 6);
    expect(p.toString()).toBe(
      "page=6&isList=true&state=VIC&zoneId=0&postcodeId=0&sitLength=0&startingIn=0" +
        "&startingDate=&endDate=&noGardenLawnCare=false&animalTypeIds=&facilityIds=&orderBy=3",
    );
  });

  it("turns names into the site's ids and fills in a zone's state", () => {
    const p = searchParams(
      { zone: "Melb. Inner", animals: ["Cat(s)", "dogs"], facilities: ["WiFi", "train"] },
      1,
    );
    expect(p.get("zoneId")).toBe("42");
    expect(p.get("state")).toBe("VIC");
    expect(p.get("animalTypeIds")).toBe("2,1");
    expect(p.get("facilityIds")).toBe("1,12");
  });

  it("refuses a zone name that fits several, naming them", () => {
    expect(() => zoneId("Rural")).toThrow(/ambiguous/);
    expect(zoneId("Rural", "VIC")).toBe(51);
  });

  it("refuses an unknown animal instead of searching for everything", () => {
    expect(() => searchParams({ animals: ["llama"] }, 1)).toThrow(/Unknown animal/);
  });
});

describe("ranking around a move-out date", () => {
  const opts = {
    target: "2027-01-15",
    before_days: 10,
    after_days: 14,
    include_covering: true,
    min_days_from_target: 0,
    include_closed: false,
    today: "2026-11-23",
  };
  const all = [HAMPTON, DUDLEY, FOOTSCRAY, SCORESBY, HIGHETT].map((s) => normalise(s));

  it("puts the nearest start first and keeps sits already running on the date", () => {
    const out = rankAround(all, opts);
    expect(out.map((s) => s.id)).toEqual([153754, 153216, 153743, 153757]);
    const highett = out[0]!;
    expect(highett).toMatchObject({ start_offset_days: 3, covers_target: false });
    expect(highett.days_from_target).toBe(11);
    const scoresby = out.find((s) => s.id === 153757)!;
    expect(scoresby).toMatchObject({ covers_target: true, days_from_target: 16 });
  });

  it("drops sits that only started near the date when covering ones are not wanted", () => {
    const out = rankAround(all, { ...opts, include_covering: false });
    expect(out.map((s) => s.id)).toEqual([153754]);
  });

  it("drops sits giving too few nights from the date on", () => {
    const out = rankAround(all, { ...opts, min_days_from_target: 7 });
    expect(out.map((s) => s.id)).toEqual([153754, 153757]);
  });

  it("leaves out sits whose applications have closed", () => {
    const closed = normalise(
      sit(1, HIGHETT.dtSittingStart!, HIGHETT.dtSittingEnd!, "/Date(1795000000000)/"),
    );
    expect(rankAround([closed], opts)).toEqual([]);
    expect(rankAround([closed], { ...opts, include_closed: true })).toHaveLength(1);
  });
});

describe("the around_date tool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads pages sorted by start and stops once past the window", async () => {
    const pages: Record<string, RawSit[]> = {
      "1": [FOOTSCRAY, SCORESBY, HAMPTON],
      "2": [DUDLEY, HIGHETT, sit(9, "/Date(1803000000000)/", "/Date(1803500000000)/")],
      "3": [sit(10, "/Date(1804000000000)/", "/Date(1804500000000)/")],
    };
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      asked.push(url.searchParams.get("page")!);
      expect(url.searchParams.get("orderBy")).toBe("3");
      const items = pages[url.searchParams.get("page")!]!;
      return Response.json({ Items: items, TotalCount: 7, PageCount: 3, PageSize: 3, Page: 1 });
    });
    const res = (await worker().call("happyhousesitters_around_date", {
      target_date: "2027-01-15",
      state: "VIC",
      include_closed: true,
    })) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text);
    expect(out.sits.map((s: { id: number }) => s.id)).toEqual([153754, 153216, 153743, 153757]);
    // Pages 2 and 3 go out together in one batch; the cut-off is checked between batches.
    expect(asked[0]).toBe("1");
    expect(out.found).toBe(4);
  });
});

describe("the ad page", () => {
  const AD = `
<div data-id="153743" class="container sit-details">
  <h3>HAMPTON, VIC 3188</h3>
  <p class="h-details">
    <span class="base medium">Region</span> - Melb. Inner suburbs<br />
    <span class="base medium">Owner</span> - Emily  D.<br />
    <span class="base medium">Response Rating</span>
      <img src="/images/icons/star.svg"><img src="/images/icons/star.svg">
      <img src="/images/icons/star-outline.svg"><img src="/images/icons/star-outline.svg">
      <img src="/images/icons/star-outline.svg"><br />
    <span class="base medium">Property Type:</span> House<br />
    <span class="base medium">Dates:</span> 5 Dec 2026 - 15 Jan 2027<br />
    <span class="base medium">Application close:</span> 4 Dec 2026<br />
    <span class="base medium">Length:</span> 41 days
      <br /><span class="base medium">Pets to care for:</span> Dog(s)            </p>
  <div class="row thumbnails active" data-images="1,2,3,4"></div>
  <div class="row thumbnails" data-images="5,6,7"></div>
  <div class="row thumbnails" data-images="1,2,3,4,5,6,7"></div>
  <p class="large medium">About</p>
  <p>
      Our home is spacious &amp; light filled.
  </p>
  <p class="large medium">
      Pets &amp; farm animals
  </p>
  <p>

  </p>
  <p class="large medium">House Tasks</p>
  <p>Bins out on Wednesdays.</p>
  <p class="base l-grey"><strong>Property Facilities:</strong></p>
  <p class="base d-grey">WiFi, Cooling</p>
  <p class="base l-grey"><strong>Neighbourhood Facilities:</strong></p>
  <p class="base d-grey">Train, Beach</p>
  <p class="base l-grey"><strong>Garden/Lawn Care:</strong></p>
  <p class="base d-grey">No</p>
  <img src="https://maps.googleapis.com/maps/api/staticmap?center=-37.933803,145.003202&zoom=13">
</div>
<div class="suggestions"><h3>Suggested for you</h3><img src="/images/icons/star.svg"></div>`;

  it("pulls out every field the page shows", () => {
    const ad = parseAd(AD, 153743)!;
    expect(ad).toMatchObject({
      title: "HAMPTON, VIC 3188",
      region: "Melb. Inner suburbs",
      owner: "Emily D.",
      response_rating: 2,
      property_type: "House",
      dates: "5 Dec 2026 - 15 Jan 2027",
      applications_close: "4 Dec 2026",
      length: "41 days",
      pets: "Dog(s)",
      about: "Our home is spacious & light filled.",
      pets_and_farm_animals: "",
      house_tasks: "Bins out on Wednesdays.",
      property_facilities: "WiFi, Cooling",
      neighbourhood_facilities: "Train, Beach",
      garden_lawn_care: "No",
      lat: -37.933803,
      lng: 145.003202,
    });
    expect(ad.photos).toHaveLength(7);
    expect(ad.photos[0]).toMatch(/IMG_153743_1\.jpg$/);
  });

  it("says nothing was found for a page with no ad on it", () => {
    expect(parseAd("<html><body>Not found</body></html>", 1)).toBeNull();
  });
});
