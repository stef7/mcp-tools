/**
 * mcp-apify — what Apify is costing you, and how close you are to your own ceilings.
 *
 *   apify_budget          spend against your monthly cap, projected to the end of the cycle
 *   apify_usage           where the money went, by service, for a cycle
 *   apify_spend_by_actor  where the money went, by Actor — which tool is costing you
 *   apify_account         which plan you are on
 *
 * Read-only, and deliberately nothing else: running Actors belongs to Apify's own MCP server.
 * Needs APIFY_TOKEN; see secrets.d.ts.
 */
import cfg from "../wrangler.json";
import pkg from "../package.json";
import { mcpWorker, tool } from "../../../core/mcp";

const API = "https://api.apify.com/v2";

type Cycle = { startAt?: string; endAt?: string };
type Limits = Record<string, number>;
type LimitsBody = { data?: { monthlyUsageCycle?: Cycle; limits?: Limits; current?: Limits } };
type UsageItem = { quantity?: number; amountAfterVolumeDiscountUsd?: number };
type Run = { actId?: string; status?: string; startedAt?: string; usageTotalUsd?: number };
type RunsBody = { data?: { items?: Run[]; total?: number } };

type UsageBody = {
  data?: {
    usageCycle?: Cycle;
    monthlyServiceUsage?: Record<string, UsageItem>;
    dailyServiceUsages?: { date?: string; totalUsageCreditsUsd?: number }[];
    totalUsageCreditsUsdAfterVolumeDiscount?: number;
  };
};

const noToken =
  "APIFY_TOKEN is not set on this worker. Add it under Settings -> Variables and Secrets; " +
  "get one from Apify Console -> Settings -> API & Integrations.";

const get = async (env: Env, path: string) => {
  if (!env.APIFY_TOKEN) throw new Error(noToken);
  const res = await fetch(`${API}${path}`, {
    // The header form rather than ?token=, so the token stays out of logs and referrers.
    headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, Accept: "application/json" },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Apify ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as unknown;
};

const money = (n: number) => `$${n.toFixed(2)}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Spelled out rather than left to toLocaleDateString, whose month abbreviations move with ICU. */
const day = (s?: string) => {
  const at = s ? new Date(s) : null;
  if (!at || isNaN(at.getTime())) return "?";
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
};

/**
 * How far through the cycle you are, and what today's rate implies for the end of it. Straight
 * line, which flatters a steady month and lies about a burst — so it is labelled an estimate.
 */
export const project = (cycle: Cycle, spent: number, now = Date.now()) => {
  const start = Date.parse(cycle.startAt ?? "");
  const end = Date.parse(cycle.endAt ?? "");
  if (isNaN(start) || isNaN(end) || end <= start) return null;
  const total = end - start;
  const elapsed = Math.min(Math.max(now - start, 0), total);
  const daysLeft = Math.max(Math.ceil((end - now) / 86400000), 0);
  // Before any time has passed there is no rate to extrapolate from.
  const projected = elapsed > 0 ? (spent / elapsed) * total : null;
  return { daysLeft, through: elapsed / total, projected };
};

/** Every limit paired with its current value, worst first, so the tight one is at the top. */
export const pressure = (limits: Limits, current: Limits) => {
  const rows = Object.entries(limits).flatMap(([key, max]) => {
    // limits are `maxMonthlyUsageUsd`; the matching current is `monthlyUsageUsd`.
    const name = key.replace(/^max/, "");
    const currentKey = name.charAt(0).toLowerCase() + name.slice(1);
    const used = current[currentKey];
    if (used === undefined || !max) return [];
    return [{ label: label(name), used, max, ratio: used / max }];
  });
  return rows.sort((a, b) => b.ratio - a.ratio);
};

/**
 * `MonthlyActorComputeUnits` -> `monthly actor compute units`, `MonthlyUsageUsd` -> `monthly
 * usage USD`. The acronyms are restored after the lowercasing, not before, or they are undone.
 */
const label = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\bgbytes\b/g, "GB")
    .replace(/\busd\b/g, "USD");

const bar = (ratio: number) => {
  const filled = Math.min(Math.round(ratio * 20), 20);
  return "█".repeat(filled) + "·".repeat(20 - filled);
};

export const formatBudget = (b: LimitsBody, now = Date.now()) => {
  const cycle = b.data?.monthlyUsageCycle ?? {};
  const limits = b.data?.limits ?? {};
  const current = b.data?.current ?? {};
  const spent = current["monthlyUsageUsd"] ?? 0;
  const cap = limits["maxMonthlyUsageUsd"] ?? 0;
  const p = project(cycle, spent, now);

  const head = [`Apify cycle ${day(cycle.startAt)} to ${day(cycle.endAt)}`];
  if (p)
    head.push(`${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left, ${pct(p.through)} through`);
  const spend = cap
    ? `${money(spent)} of ${money(cap)} (${pct(spent / cap)})` +
      (p?.projected ? ` — on track for about ${money(p.projected)}` : "")
    : `${money(spent)} spent; no monthly cap is set`;

  const rows = pressure(limits, current).map(
    (r) =>
      `  ${bar(r.ratio)} ${pct(r.ratio).padStart(4)}  ${r.label} (${trim(r.used)}/${trim(r.max)})`,
  );
  return [head.join(" · "), "", spend, "", "Closest to their ceiling:", ...rows.slice(0, 8)].join(
    "\n",
  );
};

const pct = (r: number) => `${Math.round(r * 100)}%`;
const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export const formatUsage = (b: UsageBody, daily: boolean) => {
  const cycle = b.data?.usageCycle ?? {};
  const services = Object.entries(b.data?.monthlyServiceUsage ?? {})
    .map(([name, u]) => ({
      name: label(name.replace(/_/g, " ").toLowerCase()),
      cost: u.amountAfterVolumeDiscountUsd ?? 0,
      quantity: u.quantity ?? 0,
    }))
    .sort((a, b2) => b2.cost - a.cost);
  const total = b.data?.totalUsageCreditsUsdAfterVolumeDiscount ?? 0;

  const lines = [
    `Apify usage, ${day(cycle.startAt)} to ${day(cycle.endAt)} — ${money(total)} total`,
    "",
    ...(services.length
      ? services.map((s) => `  ${money(s.cost).padStart(8)}  ${s.name} (${trim(s.quantity)})`)
      : ["  Nothing used in this cycle."]),
  ];
  if (daily) {
    const days = (b.data?.dailyServiceUsages ?? []).filter(
      (d) => (d.totalUsageCreditsUsd ?? 0) > 0,
    );
    lines.push(
      "",
      "By day:",
      ...days.map((d) => `  ${day(d.date)}  ${money(d.totalUsageCreditsUsd ?? 0)}`),
    );
  }
  return lines.join("\n");
};

/** A run that failed or timed out still costs what it burned before it stopped. */
const WASTED = new Set(["FAILED", "TIMED-OUT", "ABORTED"]);

export type ActorSpend = {
  actId: string;
  usd: number;
  runs: number;
  wasted: number;
  wastedUsd: number;
  /** True when no run carried a cost, which means "not reported", not "free". */
  unpriced: boolean;
};

/** Group runs by Actor, newest-first input, and say which spend was on runs that failed. */
export const byActor = (runs: Run[]): ActorSpend[] => {
  const acc = new Map<string, ActorSpend>();
  for (const r of runs) {
    const actId = r.actId ?? "(unknown)";
    const row = acc.get(actId) ?? {
      actId,
      usd: 0,
      runs: 0,
      wasted: 0,
      wastedUsd: 0,
      unpriced: true,
    };
    const usd = r.usageTotalUsd;
    if (typeof usd === "number") {
      row.usd += usd;
      row.unpriced = false;
    }
    row.runs += 1;
    if (WASTED.has(r.status ?? "")) {
      row.wasted += 1;
      row.wastedUsd += usd ?? 0;
    }
    acc.set(actId, row);
  }
  return [...acc.values()].sort((a, b) => b.usd - a.usd || b.runs - a.runs);
};

export const formatByActor = (rows: ActorSpend[], names: Record<string, string>, since: string) => {
  if (!rows.length) return `No runs since ${since}.`;
  const total = rows.reduce((n, r) => n + r.usd, 0);
  const wasted = rows.reduce((n, r) => n + r.wastedUsd, 0);
  const body = rows.map((r) => {
    const name = names[r.actId] ?? r.actId;
    const cost = r.unpriced ? "  not reported" : money(r.usd).padStart(13);
    const failed = r.wasted ? `  ${r.wasted} failed, ${money(r.wastedUsd)} of it` : "";
    return `  ${cost}  ${name}  (${r.runs} run${r.runs === 1 ? "" : "s"})${failed}`;
  });
  const foot =
    wasted > 0 ? ["", `${money(wasted)} of that went on runs that failed or were aborted.`] : [];
  return [
    `Spend by Actor since ${since} — ${money(total)} across ${rows.length} Actors`,
    "",
    ...body,
    ...foot,
  ].join("\n");
};

export default mcpWorker({
  ...cfg,
  version: pkg.version,
  info: () => ({
    title: "Apify account",
    description: "What Apify is costing you this cycle, and how close you are to your limits.",
    websiteUrl: "https://console.apify.com/billing",
    instructions:
      "Start with apify_budget: it answers 'am I about to hit the cap'. apify_usage says where " +
      "the money went. Neither runs an Actor — Apify's own MCP server does that.",
  }),
  tools: {
    budget: tool({
      description:
        "Spend against your monthly cap, plus every other account limit ranked by how close it " +
        "is to its ceiling. Projects the cycle total from the rate so far, which is a straight " +
        "line and so flatters a steady month. Check this before starting anything expensive.",
      async run(_args, { env }) {
        return formatBudget((await get(env, "/users/me/limits")) as LimitsBody);
      },
    }),

    usage: tool({
      description:
        "Where the money went in a usage cycle, by service — compute units, data transfer, " +
        "proxy, storage — biggest first. Optionally a day-by-day breakdown.",
      input: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description:
              "Any date inside the cycle you want, YYYY-MM-DD. Omit for the current cycle.",
          },
          daily: {
            type: "boolean",
            default: false,
            description: "Also list each day that cost anything.",
          },
        },
      },
      async run({ date, daily = false }, { env }) {
        const q = date ? `?date=${encodeURIComponent(date)}` : "";
        return formatUsage((await get(env, `/users/me/usage/monthly${q}`)) as UsageBody, daily);
      },
    }),

    spend_by_actor: tool({
      description:
        "Which Actor is costing you, over a window of runs — the breakdown the billing page " +
        "does not give you. Sums each run's own cost by Actor, biggest first, and separates " +
        "out what was spent on runs that failed, timed out or were aborted, which is pure " +
        "waste. Use it to decide what is worth rebuilding.",
      input: {
        type: "object",
        properties: {
          since: {
            type: "string",
            description:
              "Only count runs started on or after this date, YYYY-MM-DD. Defaults to 30 days " +
              "ago. Older runs may have been deleted under your data retention setting.",
          },
          max_runs: {
            type: "integer",
            default: 1000,
            description: "How many recent runs to scan, up to 5000. Each 1000 is one request.",
          },
        },
      },
      async run({ since, max_runs = 1000 }, { env }) {
        const from = since ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const cutoff = Date.parse(`${from}T00:00:00.000Z`);
        if (isNaN(cutoff)) return `\`since\` should look like 2026-09-01, not "${from}".`;

        const runs: Run[] = [];
        // Newest first, so the first run older than the cutoff ends the scan.
        for (let offset = 0; offset < Math.min(max_runs, 5000); offset += 1000) {
          const page = (await get(
            env,
            `/actor-runs?desc=1&limit=1000&offset=${offset}`,
          )) as RunsBody;
          const items = page.data?.items ?? [];
          const wanted = items.filter((r) => Date.parse(r.startedAt ?? "") >= cutoff);
          runs.push(...wanted);
          if (wanted.length < items.length || items.length < 1000) break;
        }

        const rows = byActor(runs);
        // Naming costs one request per distinct Actor, so only the ones anyone will read.
        const names: Record<string, string> = {};
        for (const r of rows.slice(0, 15)) {
          const act = (await get(env, `/acts/${r.actId}`).catch(() => null)) as {
            data?: { username?: string; name?: string };
          } | null;
          const d = act?.data;
          if (d?.name) names[r.actId] = d.username ? `${d.username}/${d.name}` : d.name;
        }
        return formatByActor(rows, names, from);
      },
    }),

    account: tool({
      description:
        "Which Apify plan the token belongs to, and the account it is attached to. Useful when " +
        "a limit is lower than you expected and you want to know what you are actually paying for.",
      async run(_args, { env }) {
        const me = (await get(env, "/users/me")) as {
          data?: { username?: string; email?: string; plan?: Record<string, unknown> };
        };
        const d = me.data ?? {};
        const plan = d.plan ?? {};
        return [
          `username: ${d.username ?? "?"}`,
          `email: ${d.email ?? "?"}`,
          `plan: ${plan["id"] ?? plan["name"] ?? "?"}`,
          "",
          JSON.stringify(plan, null, 2).slice(0, 2000),
        ].join("\n");
      },
    }),
  },
});
