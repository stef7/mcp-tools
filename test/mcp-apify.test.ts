/**
 * mcp-apify. Apify's API is not called; what is worth pinning down is the projection arithmetic
 * and the limit/current pairing, both of which can be wrong without looking wrong.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import Worker, {
  byActor,
  formatBudget,
  formatByActor,
  formatUsage,
  pressure,
  project,
} from "../workers/mcp-apify/src/index";

type Spec = { name: string; annotations: Record<string, boolean> };

const apify = () => new Worker(createExecutionContext(), env);
const tools = () => apify().tools({}) as Promise<Spec[]>;
const call = async (name: string) => {
  const r = (await apify().call(name, {}, {})) as { content: { text: string }[] };
  return r.content[0]!.text;
};

const START = "2026-09-04T00:00:00.000Z";
const END = "2026-10-03T23:59:59.999Z";
const CYCLE = { startAt: START, endAt: END };
const HALFWAY = Date.parse("2026-09-19T00:00:00.000Z");

const LIMITS = {
  data: {
    monthlyUsageCycle: CYCLE,
    limits: {
      maxMonthlyUsageUsd: 60,
      maxMonthlyActorComputeUnits: 1000,
      maxMonthlyResidentialProxyGbytes: 0.5,
      maxActorCount: 100,
    },
    current: {
      monthlyUsageUsd: 12.4,
      monthlyActorComputeUnits: 900,
      monthlyResidentialProxyGbytes: 0.05,
      actorCount: 7,
    },
  },
};

describe("the tool list", () => {
  it("carries the worker's prefix and reads only", async () => {
    const specs = await tools();
    expect(specs.map((t) => t.name)).toEqual([
      "apify_budget",
      "apify_usage",
      "apify_spend_by_actor",
      "apify_account",
    ]);
    expect(specs.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it("says what is missing when there is no token", async () => {
    expect(await call("apify_budget")).toContain("APIFY_TOKEN is not set");
  });
});

describe("projecting the cycle", () => {
  it("extrapolates the rate so far to the whole cycle", () => {
    const p = project(CYCLE, 12.4, HALFWAY)!;
    expect(p.through).toBeCloseTo(0.5, 1);
    expect(p.projected).toBeCloseTo(24.8, 0); // half the cycle spent, so twice the spend
    expect(p.daysLeft).toBe(15);
  });

  it("refuses to extrapolate from no elapsed time", () => {
    expect(project(CYCLE, 0, Date.parse(START))!.projected).toBeNull();
  });

  it("never reports negative days once the cycle has passed", () => {
    const p = project(CYCLE, 50, Date.parse("2026-11-01T00:00:00.000Z"))!;
    expect(p.daysLeft).toBe(0);
    expect(p.through).toBe(1);
  });

  it("gives up on a cycle it cannot read rather than inventing one", () => {
    expect(project({}, 10)).toBeNull();
    expect(project({ startAt: END, endAt: START }, 10)).toBeNull();
  });
});

describe("pairing each limit with its current value", () => {
  it("matches maxMonthlyUsageUsd to monthlyUsageUsd, and sorts by pressure", () => {
    const rows = pressure(LIMITS.data.limits, LIMITS.data.current);
    expect(rows[0]!.label).toBe("monthly actor compute units"); // 90%, the tightest
    expect(rows[0]!.ratio).toBeCloseTo(0.9);
    expect(rows.map((r) => r.label)).toContain("monthly usage USD");
  });

  it("drops a limit with no matching current value instead of showing a wrong one", () => {
    expect(pressure({ maxSomethingUnpaired: 10 }, { actorCount: 1 })).toEqual([]);
  });
});

describe("the budget report", () => {
  const out = formatBudget(LIMITS, HALFWAY);

  it("leads with spend against the cap and the projection", () => {
    expect(out).toContain("$12.40 of $60.00 (21%)");
    expect(out).toContain("on track for about $24");
    expect(out).toContain("15 days left");
  });

  it("puts the tightest limit first, where it will be seen", () => {
    const rows = out.split("Closest to their ceiling:")[1]!.trim().split("\n");
    expect(rows[0]).toContain("monthly actor compute units");
    expect(rows[0]).toContain("90%");
  });

  it("says so rather than dividing by zero when no cap is set", () => {
    const uncapped = { data: { ...LIMITS.data, limits: { maxActorCount: 100 } } };
    expect(formatBudget(uncapped, HALFWAY)).toContain("no monthly cap is set");
  });
});

describe("the usage report", () => {
  const usage = {
    data: {
      usageCycle: CYCLE,
      monthlyServiceUsage: {
        ACTOR_COMPUTE_UNITS: { quantity: 60, amountAfterVolumeDiscountUsd: 2.5 },
        DATA_TRANSFER_EXTERNAL_GBYTES: { quantity: 1.5, amountAfterVolumeDiscountUsd: 9.9 },
      },
      dailyServiceUsages: [
        { date: START, totalUsageCreditsUsd: 0 },
        { date: "2026-09-05T00:00:00.000Z", totalUsageCreditsUsd: 4.2 },
      ],
      totalUsageCreditsUsdAfterVolumeDiscount: 12.4,
    },
  };

  it("puts the most expensive service first", () => {
    const lines = formatUsage(usage, false)
      .split("\n")
      .filter((l) => l.startsWith("  "));
    expect(lines[0]).toContain("data transfer external GB");
    expect(lines[1]).toContain("actor compute units");
  });

  it("leaves out the days that cost nothing", () => {
    const out = formatUsage(usage, true);
    expect(out).toContain("5 Sep  $4.20");
    expect(out).not.toContain("4 Sep  $0.00");
  });

  it("says plainly when a cycle had no usage", () => {
    expect(formatUsage({ data: { usageCycle: CYCLE } }, false)).toContain("Nothing used");
  });
});

describe("spend by Actor", () => {
  const runs = [
    { actId: "aaa", status: "SUCCEEDED", usageTotalUsd: 1.5, startedAt: "2026-09-10T00:00:00Z" },
    { actId: "aaa", status: "FAILED", usageTotalUsd: 0.5, startedAt: "2026-09-11T00:00:00Z" },
    { actId: "bbb", status: "SUCCEEDED", usageTotalUsd: 4, startedAt: "2026-09-12T00:00:00Z" },
    { actId: "ccc", status: "SUCCEEDED", startedAt: "2026-09-13T00:00:00Z" },
  ];

  it("groups by Actor, dearest first", () => {
    expect(byActor(runs).map((r) => r.actId)).toEqual(["bbb", "aaa", "ccc"]);
    expect(byActor(runs)[1]!.usd).toBe(2);
  });

  it("counts what was spent on runs that failed separately", () => {
    const aaa = byActor(runs).find((r) => r.actId === "aaa")!;
    expect(aaa.wasted).toBe(1);
    expect(aaa.wastedUsd).toBe(0.5);
  });

  it("distinguishes 'not reported' from 'free'", () => {
    const ccc = byActor(runs).find((r) => r.actId === "ccc")!;
    expect(ccc.unpriced).toBe(true);
    expect(formatByActor([ccc], {}, "2026-09-01")).toContain("not reported");
  });

  it("names the Actors it could resolve, and falls back to the ID", () => {
    const out = formatByActor(byActor(runs), { bbb: "dz_omar/youtube-transcript" }, "2026-09-01");
    expect(out).toContain("dz_omar/youtube-transcript");
    expect(out).toContain("aaa"); // unresolved, so the raw ID stands in
    expect(out).toContain("$0.50 of it");
  });

  it("says so when the window is empty rather than printing an empty table", () => {
    expect(formatByActor([], {}, "2026-09-01")).toBe("No runs since 2026-09-01.");
  });
});
