/**
 * Time series and the stored breakdown tables.
 *
 * Two things live here that nothing else in the registry could answer. The first is a DAILY series:
 * every other tool returns one summed row per entity, so "is spend trending up?" could only be
 * answered by the model diffing two windowed calls. `get_trend` returns the shape `chat.ts` detects
 * as a chartable series (`{ title, unit, points }`), so the answer is drawn as well as described —
 * and it carries a `summary` so the model never has to read all 180 points to characterise the line.
 *
 * The second is the funding side of an ad account (`get_account_detail`). Balance, spend cap and
 * timezone are synced but were unreachable through the assistant, so "how much is left on this
 * account?" had no tool at all.
 */
import {
  fetchAccount,
  fetchAccounts,
  fetchBreakdowns,
  fetchTrend,
  type AccountMeta,
} from "@/server/fns/dashboard";
import { kpiSparks } from "@/lib/sparks";
import { addDays } from "@/lib/range";
import type { BreakdownRow, TrendPoint } from "@/lib/types";
import {
  WINDOW_PROPS,
  isResolveError,
  resolveSubject,
  toolWindow,
  type AgentTool,
  type ResolveError,
} from "./kit";

/** Hard ceiling on charted points. A 37-month daily window is 1125 points of pure token burn. */
const MAX_POINTS = 180;
/** Rows returned for one breakdown dimension. Country/region tails are long and worthless. */
const MAX_BREAKDOWN_ROWS = 40;

const round = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};
const r2 = (n: number): number => round(n, 2);
/** Meta stores money in MINOR units (cents). Every figure leaving this module is major units. */
const money = (minor: number | null | undefined): number | null =>
  minor == null ? null : round(minor / 100, 2);

/**
 * A miss on an `act_` id, reworded.
 *
 * `resolveSubject` tries clients first and returns the CLIENT error when everything fails, so asking
 * for an unsynced ad account by id answered `No client matches "act_123"` followed by twenty client
 * names — an answer about the wrong kind of thing, and twenty tokens of candidates that can never
 * match. A name that is not obviously an id keeps the client candidates: there, they are the point.
 */
const subjectError = (query: string, err: ResolveError): ResolveError =>
  /^act_/i.test(query.trim())
    ? {
        error: `No ad account matches "${query.trim()}". Either the id is wrong or the account is not visible to our Meta token — list_accounts returns every account we can see, with its owning client.`,
      }
    : err;

// ─────────────────────────────────────────────────────────────────────────────
// get_trend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exactly the metrics a `TrendPoint` can support: the six summed fields plus the four ratios
 * `kpiSparks` derives from them. Nothing else may be advertised — a metric the series cannot
 * produce is worse than a missing one, because the model will promise it.
 */
type Metric =
  | "spend"
  | "revenue"
  | "roas"
  | "ctr"
  | "conversions"
  | "impressions"
  | "clicks"
  | "cpc"
  | "cpm"
  | "reach";

interface MetricDef {
  label: string;
  unit: string;
  /** True when point values sum to a meaningful window total (ratios do not). */
  additive: boolean;
  decimals: number;
}

const METRICS: Record<Metric, MetricDef> = {
  spend: { label: "Spend", unit: "USD", additive: true, decimals: 2 },
  revenue: { label: "Revenue", unit: "USD", additive: true, decimals: 2 },
  roas: { label: "ROAS", unit: "x", additive: false, decimals: 2 },
  ctr: { label: "CTR", unit: "%", additive: false, decimals: 3 },
  conversions: { label: "Conversions", unit: "count", additive: true, decimals: 2 },
  impressions: { label: "Impressions", unit: "count", additive: true, decimals: 0 },
  clicks: { label: "Clicks", unit: "count", additive: true, decimals: 0 },
  // `unit` is the chart renderer's format switch (SeriesChart): "USD" is money that SUMS in the
  // header, so per-unit costs get their own units and are summarised as an average instead.
  cpc: { label: "CPC", unit: "cpc", additive: false, decimals: 2 },
  cpm: { label: "CPM", unit: "cpm", additive: false, decimals: 2 },
  reach: { label: "Reach", unit: "count", additive: true, decimals: 0 },
};

const METRIC_NAMES = Object.keys(METRICS) as Metric[];

const METRIC_ALIASES: Record<string, Metric> = {
  cost: "spend",
  amount_spent: "spend",
  spent: "spend",
  budget: "spend",
  purchase_value: "revenue",
  conversion_value: "revenue",
  value: "revenue",
  return_on_ad_spend: "roas",
  click_through_rate: "ctr",
  cost_per_click: "cpc",
  cost_per_mille: "cpm",
  purchases: "conversions",
  conversion: "conversions",
  impression: "impressions",
  click: "clicks",
  link_clicks: "clicks",
  people_reached: "reach",
};

const isMetric = (v: string): v is Metric => v in METRICS;

function parseMetric(v: unknown): Metric | { error: string } {
  if (v == null || v === "") return "spend";
  const k = String(v)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (isMetric(k)) return k;
  const alias = METRIC_ALIASES[k];
  if (alias) return alias;
  if (k === "results" || k === "result")
    return {
      error:
        "The daily series carries raw conversions, not objective-aware `results`. Use metric='conversions' here, or get_overview / get_client_stats / get_ad_sets for objective results.",
    };
  return { error: `Unknown metric "${String(v)}". Valid: ${METRIC_NAMES.join(", ")}.` };
}

/** Per-point values for a metric. Ratios come from `kpiSparks`, so a chart and the KPI sparklines
 *  on the dashboard can never disagree about how CTR or ROAS is derived. */
const valuesFor = (series: TrendPoint[], metric: Metric): number[] =>
  metric === "clicks" ? series.map((p) => p.clicks) : kpiSparks(series)[metric];

/** Fold points onto a coarser key (a shared date, a week start, a month). Summing raw fields and
 *  deriving ratios afterwards is what keeps a weekly CTR spend-weighted instead of a mean of means. */
function fold(points: TrendPoint[], key: (date: string) => string): TrendPoint[] {
  const out = new Map<string, TrendPoint>();
  for (const p of points) {
    const k = key(p.date);
    const cur = out.get(k);
    if (!cur) {
      out.set(k, { ...p, date: k });
      continue;
    }
    cur.spend += p.spend;
    cur.conversions += p.conversions;
    cur.revenue += p.revenue;
    cur.impressions += p.impressions;
    cur.clicks += p.clicks;
    cur.reach += p.reach;
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const dayIndex = (from: string, date: string): number =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const getTrend: AgentTool = {
  label: "trend",
  definition: {
    name: "get_trend",
    description:
      "DAILY time series for one client or ad account — the only tool that returns a per-day line rather than one summed row. The result is rendered as a line chart in the chat automatically, so use it for any 'trend', 'over time', 'day by day', 'is X going up or down', 'when did X drop' or 'chart/graph' question. Returns `{ title, unit, points: [{date, value}], summary, windowTotals }`. `metric` selects the line: spend, revenue, conversions, impressions, clicks, reach (summed per day) or roas, ctr, cpc, cpm (derived from that day's sums exactly as the dashboard sparklines are). `summary` carries points, min/max (each with its date), avg, first, last, `change` (absolute + percent, first point vs last) and `total` (additive metrics) or `windowOverall` (the spend-weighted figure for the whole window, for ratio metrics) — DESCRIBE THE TREND FROM `summary`, do not recite points. Days with no synced rows are simply absent (no zero-fill), so a gap means no data, not zero spend. A client resolves to the SUM of all its ad accounts. Windows longer than 180 days are bucketed into 7-day (then calendar-month) points and `granularity` says so — quote the bucket, never call a bucket a day. `reach` is the sum of daily reach, so it is NOT a de-duplicated unique count. For a table instead of a line, use get_client_stats / list_active_campaigns / get_ad_sets; for a downloadable per-day file, use generate_report with time_increment=1.",
    input_schema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description:
            "Client name/id, Notion brand, or ad-account name/id. Fuzzy-matched. A client sums every one of its ad accounts.",
        },
        metric: {
          type: "string",
          enum: METRIC_NAMES,
          description: "Which line to plot. Default 'spend'.",
        },
        ...WINDOW_PROPS,
      },
      required: ["subject"],
    },
  },
  async run(input) {
    const metric = parseMetric(input.metric);
    if (typeof metric !== "string") return metric;
    const query = String(input.subject ?? "");
    const subject = await resolveSubject(query);
    if (isResolveError(subject)) return subjectError(query, subject);

    const w = toolWindow(input);
    const def = METRICS[metric];
    const window = { since: w.since, until: w.until, days: w.days };

    if (subject.accountIds.length === 0)
      return {
        subject: subject.name,
        window,
        note: `${subject.name} has no ad accounts mapped, so there is no series to plot.`,
      };

    // One grouped daily query per account. `fetchAccount` also returns this series, but it drags
    // every campaign, ad set, ad and creative along with it — 31s for a 7-account client, all of it
    // discarded here.
    const perAccount = await Promise.all(subject.accountIds.map((id) => fetchTrend(w, id)));
    // Sum the per-account series onto shared dates first; bucket only if the result is too long.
    const daily = fold(perAccount.flat(), (date) => date);
    if (daily.length === 0)
      return {
        subject: subject.name,
        window,
        note: `No daily insight rows for any of ${subject.name}'s ${subject.accountIds.length} ad account(s) between ${w.since} and ${w.until}. Insight history reaches back to each account's creation date (≈37 months), so this means the accounts are unsynced, newer than the window, or never spent in it.`,
      };

    const weeks = Math.floor((dayIndex(daily[0].date, daily[daily.length - 1].date) + 7) / 7) + 1;
    const granularity: "daily" | "weekly" | "monthly" =
      daily.length <= MAX_POINTS ? "daily" : weeks <= MAX_POINTS ? "weekly" : "monthly";
    const base = daily[0].date;
    const series =
      granularity === "daily"
        ? daily
        : granularity === "weekly"
          ? fold(daily, (date) => addDays(base, Math.floor(dayIndex(base, date) / 7) * 7))
          : fold(daily, (date) => `${date.slice(0, 7)}-01`);

    const values = valuesFor(series, metric);
    const points = series.map((p, i) => ({ date: p.date, value: round(values[i], def.decimals) }));
    const at = (i: number) => ({ date: points[i].date, value: points[i].value });
    const first = points[0].value;
    const last = points[points.length - 1].value;
    let lo = 0;
    let hi = 0;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      if (points[i].value < points[lo].value) lo = i;
      if (points[i].value > points[hi].value) hi = i;
      sum += points[i].value;
    }
    // Ratio metrics have no meaningful point-sum; their honest window figure is derived from the
    // window's totals (spend-weighted), which is one more fold through the same code path.
    const [whole] = fold(series, () => base);
    const overall = round(valuesFor([whole], metric)[0], def.decimals);

    return {
      title: `${def.label} — ${subject.name} (${w.since} → ${w.until})`,
      unit: def.unit,
      points,
      granularity,
      subject: subject.name,
      metric,
      accountsMapped: subject.accountIds.length,
      accountsWithData: perAccount.filter((s) => s.length > 0).length,
      window,
      summary: {
        points: points.length,
        ...(def.additive ? { total: round(sum, def.decimals) } : { windowOverall: overall }),
        avg: round(sum / points.length, def.decimals),
        min: at(lo),
        max: at(hi),
        first: at(0),
        last: at(points.length - 1),
        change: {
          absolute: round(last - first, def.decimals),
          percent: first !== 0 ? r2(((last - first) / Math.abs(first)) * 100) : null,
        },
      },
      windowTotals: {
        spend: r2(whole.spend),
        impressions: Math.round(whole.impressions),
        clicks: Math.round(whole.clicks),
        conversions: r2(whole.conversions),
        revenue: r2(whole.revenue),
      },
      ...(granularity === "daily"
        ? {}
        : {
            note: `${w.days} days is too long to plot daily, so points are ${
              granularity === "weekly" ? "7-day buckets" : "calendar months"
            } labelled by the bucket's first date. Each value covers the whole bucket, not that one day.`,
          }),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// get_breakdown
// ─────────────────────────────────────────────────────────────────────────────

const DIMENSIONS = [
  "age",
  "gender",
  "publisher_platform",
  "device_platform",
  "country",
  "region",
  "placement",
  "hourly",
] as const;
type Dimension = (typeof DIMENSIONS)[number];

const DIMENSION_LABELS: Record<Dimension, string> = {
  age: "Age bracket",
  gender: "Gender",
  publisher_platform: "Publisher platform (Facebook / Instagram / Audience Network / Messenger)",
  device_platform: "Device platform (mobile / desktop app / web)",
  country: "Country",
  region: "Region (state / province, NOT scoped by country)",
  placement: "Placement (platform · position · device)",
  hourly: "Hour of day, in the AD ACCOUNT's timezone",
};

const DIMENSION_ALIASES: Record<string, Dimension> = {
  ages: "age",
  age_range: "age",
  genders: "gender",
  sex: "gender",
  platform: "publisher_platform",
  platforms: "publisher_platform",
  publisher: "publisher_platform",
  device: "device_platform",
  devices: "device_platform",
  impression_device: "device_platform",
  countries: "country",
  geo: "country",
  geography: "country",
  regions: "region",
  state: "region",
  states: "region",
  province: "region",
  placements: "placement",
  position: "placement",
  hour: "hourly",
  hours: "hourly",
  hour_of_day: "hourly",
  time_of_day: "hourly",
};

const isDimension = (v: string): v is Dimension => DIMENSIONS.some((d) => d === v);

function parseDimension(v: unknown): Dimension | null | { error: string } {
  if (v == null || v === "") return null;
  const k = String(v)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (isDimension(k)) return k;
  const alias = DIMENSION_ALIASES[k];
  if (alias) return alias;
  if (k === "age_gender" || k === "gender_age")
    return {
      error:
        "Age and gender are stored as separate tables here, not as a combined age×gender grid. Call get_breakdown twice (dimension='age', then 'gender'), or use generate_report with breakdown='age_gender' for the crossed table.",
    };
  return {
    error: `Unknown dimension "${String(v)}". Valid: ${DIMENSIONS.join(", ")}. Omit it entirely for a top-5 overview of all eight.`,
  };
}

/**
 * Collapse repeated dimension VALUES to the highest-spend row.
 *
 * `fetchBreakdowns` fills region / placement / hourly from a second, campaign-level pull, because
 * Meta only serves those three at campaign grain. When an account ALSO carries an account-level
 * rollup for one of them, the same value arrives twice — measured on 5bet.com: "Ontario $1,857.95"
 * (rollup) beside "Ontario $1,857.88" (sum of its campaigns), which doubled the dimension's total.
 * The two rows are indistinguishable to the model, so the complete one wins and the partial copy is
 * dropped; rows arrive sorted by spend, so that is simply the first occurrence.
 */
function dedupeByLabel(rows: BreakdownRow[]): BreakdownRow[] {
  const seen = new Set<string>();
  const out: BreakdownRow[] = [];
  for (const r of rows) {
    if (seen.has(r.label)) continue;
    seen.add(r.label);
    out.push(r);
  }
  return out;
}

const shapeRows = (all: BreakdownRow[]) => {
  const rows = dedupeByLabel(all);
  const totalSpend = rows.reduce((n, r) => n + r.spend, 0);
  const shown = rows.slice(0, MAX_BREAKDOWN_ROWS);
  return {
    totalSpend: r2(totalSpend),
    rows: shown.map((r) => ({
      label: r.label,
      spend: r2(r.spend),
      sharePct: totalSpend > 0 ? r2((r.spend / totalSpend) * 100) : 0,
      conversions: r2(r.conversions),
      roas: r2(r.roas),
      ...(r.conversions > 0 ? { cpa: r2(r.spend / r.conversions) } : {}),
    })),
    ...(rows.length > MAX_BREAKDOWN_ROWS
      ? {
          truncated: `showing the top ${MAX_BREAKDOWN_ROWS} of ${rows.length} values by spend; the remaining ${rows.length - MAX_BREAKDOWN_ROWS} account for $${r2(
            totalSpend - shown.reduce((n, r) => n + r.spend, 0),
          )}`,
        }
      : {}),
  };
};

export const getBreakdown: AgentTool = {
  label: "breakdown",
  definition: {
    name: "get_breakdown",
    description:
      "Meta's STORED demographic / platform / geo / time breakdown tables for a client or ad account: one row per dimension value with spend, sharePct (share of that dimension's spend), conversions, roas and cpa, sorted by spend. Dimensions: age, gender, publisher_platform (Facebook vs Instagram vs Audience Network), device_platform (mobile vs desktop), country, region (state/province), placement (platform · position · device), hourly (hour of day in the ACCOUNT's timezone). Omit `dimension` to get a top-5 overview of all eight at once — do that first when the user asks 'who are we reaching' or 'where is the money going' without naming an axis. IMPORTANT LIMITS: (1) these tables only carry spend, conversions and revenue — impressions, clicks, CTR and CPC are NOT available per dimension; get them from get_client_stats, get_ad_sets or generate_report instead. (2) Meta only serves breakdowns for the last ≈13 months, versus ≈37 months for core insights, so an older window can be legitimately empty here while get_client_stats still has numbers — say that rather than 'no data'. (3) `region` is NOT scoped by country, so regions from different countries are mixed together. For PER-AD-SET questions — and advertisers usually name one ad set per targeted state — get_ad_sets with group_by_name=true is more reliable than the region breakdown and also returns impressions, CTR, CPC and the full conversion breakdown; prefer it whenever the ad sets are named after what they target. Use generate_report for a downloadable/CSV version.",
    input_schema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description:
            "Client name/id, Notion brand, or ad-account name/id. Fuzzy-matched. A client covers all of its ad accounts.",
        },
        dimension: {
          type: "string",
          enum: DIMENSIONS,
          description:
            "Which stored table to return. Omit for a top-5 overview of every dimension.",
        },
        ...WINDOW_PROPS,
      },
      required: ["subject"],
    },
  },
  async run(input) {
    const dimension = parseDimension(input.dimension);
    if (dimension !== null && typeof dimension !== "string") return dimension;
    const query = String(input.subject ?? "");
    const subject = await resolveSubject(query);
    if (isResolveError(subject)) return subjectError(query, subject);

    const w = toolWindow(input);
    const window = { since: w.since, until: w.until, days: w.days };
    if (subject.accountIds.length === 0)
      return {
        subject: subject.name,
        window,
        note: `${subject.name} has no ad accounts mapped, so there is nothing to break down.`,
      };

    const dims = await fetchBreakdowns(w, { accountIds: subject.accountIds });
    const retention =
      "Meta serves breakdowns for ≈13 months only (core insights reach ≈37 months), so an older window can be empty here even when totals exist.";

    if (dimension === null) {
      const overview = DIMENSIONS.map((d) => {
        const rows = dedupeByLabel(dims[d]);
        const totalSpend = rows.reduce((n, r) => n + r.spend, 0);
        return {
          dimension: d,
          values: rows.length,
          spend: r2(totalSpend),
          top: rows.slice(0, 5).map((r) => ({
            label: r.label,
            spend: r2(r.spend),
            sharePct: totalSpend > 0 ? r2((r.spend / totalSpend) * 100) : 0,
          })),
        };
      });
      const empty = overview.filter((o) => o.values === 0).map((o) => o.dimension);
      return {
        subject: subject.name,
        accounts: subject.accountIds.length,
        window,
        overview,
        note: `Top 5 values per dimension. Call again with dimension='<name>' for the full table (up to ${MAX_BREAKDOWN_ROWS} rows). These tables carry spend/conversions/revenue only — no impressions, clicks, CTR or CPC.${
          empty.length ? ` Not synced for this window: ${empty.join(", ")}. ${retention}` : ""
        }`,
      };
    }

    const rows = dims[dimension];
    if (rows.length === 0)
      return {
        subject: subject.name,
        dimension,
        window,
        note: `No ${dimension} breakdown rows for ${subject.name} between ${w.since} and ${w.until}. ${retention} region, placement and hourly are only served at campaign level and are aggregated up, so they can also be missing while age/gender/platform are present.`,
      };

    return {
      subject: subject.name,
      accounts: subject.accountIds.length,
      dimension,
      dimensionLabel: DIMENSION_LABELS[dimension],
      window,
      ...shapeRows(rows),
      metricsAvailable:
        "spend, conversions, roas, cpa — impressions/clicks/CTR/CPC are not stored per dimension",
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// get_account_detail
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Funding block for one account, in major units.
 *
 * `amountSpent` on `AccountMeta` is our RECORDED LIFETIME spend, not Meta's `amount_spent` (that
 * column is scoped to the current spend-cap cycle and resets on top-up). It therefore must not be
 * subtracted from `spendCap` — doing so drove accounts thousands of dollars negative — so this block
 * publishes the two separately, names the lifetime figure for what it is, and never computes
 * headroom.
 */
function funding(meta: AccountMeta, currency: string) {
  const cap = money(meta.spendCap);
  // Meta reports a 1-cent spend cap on accounts it has blocked (the case `canDeliver` in
  // sync/jobs/notion-budget.ts guards against with a `> 0` test that would otherwise pass). Left
  // unlabelled it reads as "capped at $0.01", which no one would recognise as a block.
  const blocked = meta.spendCap === 1;
  return {
    currency,
    balance: money(meta.balance),
    spendCap: cap,
    uncapped: !cap,
    lifetimeSpend: money(meta.amountSpent),
    ...(blocked
      ? {
          cannotDeliver:
            "Meta reports a 1-cent spend cap, which is how it marks a BLOCKED account — nothing can spend from it until that is lifted.",
        }
      : {}),
    spendCapNote:
      "spendCap is Meta's ceiling for the CURRENT prepaid cap cycle; lifetimeSpend is our own recorded total across the account's life. They are NOT subtractable — Meta resets its cycle counter on every top-up, so cap − lifetimeSpend is meaningless. Quote `balance` as the money Meta currently reports on the account.",
  };
}

export const getAccountDetail: AgentTool = {
  label: "account detail",
  definition: {
    name: "get_account_detail",
    description:
      "Everything we hold about ONE ad account: `funding` (balance, spendCap, whether it is uncapped, and lifetimeSpend — all in the account's currency, converted from Meta's cents), `meta` (timezoneName, businessName/Business Manager, createdTime), Meta `status` with disableReason/disabledSince, `lastChecked` (last sync), current-window `kpis` (spend, impressions, clicks, ctr, cpc, cpm, conversions, revenue, roas, reach, objective results) with `deltasPct` (percent change vs the preceding equal-length window), and the account's top campaigns by spend. THIS is the tool for 'how much balance/budget is left on this account', 'what timezone is it in', 'which Business Manager owns it', 'when was it created', 'why is it disabled', 'why isn't it spending'. Read `funding.spendCapNote` before doing any arithmetic on the funding numbers: spendCap is a CURRENT-CYCLE ceiling and lifetimeSpend is a lifetime total, so subtracting one from the other is wrong — `balance` is the figure to quote for money on the account. When `funding.cannotDeliver` is present, Meta has BLOCKED the account (it marks that with a 1-cent cap) and nothing can spend from it — lead with that. Takes ONE account: pass an act_ id or an account name. A client name that maps to several accounts comes back as an error listing them, so ask the user which one (or use get_client_stats for the client-wide per-account rollup).",
    input_schema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description:
            "Ad-account name or act_ id. Fuzzy-matched. A client/brand name is accepted only when it maps to exactly one ad account.",
        },
        ...WINDOW_PROPS,
      },
      required: ["account"],
    },
  },
  async run(input) {
    const query = String(input.account ?? "");
    const subject = await resolveSubject(query);
    if (isResolveError(subject)) return subjectError(query, subject);

    const w = toolWindow(input);
    if (subject.accountIds.length === 0)
      return { error: `"${query}" resolved to ${subject.name}, which has no ad accounts mapped.` };
    if (subject.accountIds.length > 1) {
      const all = await fetchAccounts(w);
      const names = subject.accountIds.map((id) => {
        const a = all.find((x) => x.id === id);
        return a ? `${a.name} (${id})` : id;
      });
      return {
        error: `"${query}" resolved to ${subject.name}, which has ${subject.accountIds.length} ad accounts. Ask the user which one, or use get_client_stats for all of them at once.`,
        candidates: names.slice(0, 20),
      };
    }

    const id = subject.accountIds[0];
    const detail = await fetchAccount(id, w);
    if (!detail)
      return {
        error: `Ad account ${id} (${subject.name}) is mapped but not visible to our Meta token, so nothing is synced for it.`,
      };

    const { account, deltas, campaigns, meta } = detail;
    return {
      account: {
        id: account.id,
        name: account.name,
        currency: account.currency,
        status: account.status,
        disableReason: account.disableReason,
        disabledSince: account.disabledSince,
        lastChecked: account.lastChecked,
      },
      window: { since: w.since, until: w.until, days: w.days },
      funding: meta
        ? funding(meta, account.currency)
        : { note: "No synced account row, so balance and spend cap are unknown." },
      meta: meta
        ? {
            timezoneName: meta.timezoneName,
            businessName: meta.businessName,
            createdTime: meta.createdTime,
          }
        : null,
      kpis: {
        spend: r2(account.spend),
        impressions: account.impressions,
        clicks: account.clicks,
        ctr: r2(account.ctr),
        cpc: r2(account.cpc),
        cpm: r2(account.cpm),
        conversions: r2(account.conversions),
        revenue: r2(account.revenue),
        roas: r2(account.roas),
        reach: account.reach,
        results: r2(account.results),
        resultLabel: account.resultLabel,
      },
      deltasPct: Object.fromEntries(
        Object.entries(deltas)
          .filter((e): e is [string, number] => typeof e[1] === "number")
          .map(([k, v]) => [k, r2(v)]),
      ),
      campaigns: {
        count: campaigns.length,
        top: campaigns
          .slice()
          .sort((a, b) => b.spend - a.spend)
          .slice(0, 10)
          .map((c) => ({
            name: c.name,
            status: c.status,
            objective: c.objective,
            spend: r2(c.spend),
            ctr: r2(c.ctr),
            cpc: r2(c.cpc),
            results: r2(c.results),
            resultLabel: c.resultLabel,
          })),
      },
    };
  },
};

/** Time series and stored breakdown tables (age/gender/platform/device/geo/placement/hour). */
export const trendTools: AgentTool[] = [getTrend, getBreakdown, getAccountDetail];
