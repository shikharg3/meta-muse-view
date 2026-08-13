/**
 * Mock dataset for the client-portal design preview.
 *
 * Everything here is generated in-process and deterministic: the same seed always produces the same
 * numbers, so SSR and client hydration agree and screenshots are reproducible. The portal MVP reads
 * NOTHING from Postgres — that is deliberate, it makes a data leak structurally impossible while we
 * are only deciding how the UI should look.
 *
 * Two invariants of the real portal are already baked in, because they shape the UI:
 *  - `spend` is the CLIENT-FACING figure (commission markup already applied). Raw spend does not
 *    exist anywhere in this module, so no component can accidentally render it.
 *  - Names are presentation aliases ("Player Acquisition — UK & IE"), never internal ad-account
 *    names, and statuses use client language.
 */

// ---------------------------------------------------------------------------- clock (pinned)

/** Pinned "now". A real clock would make SSR and client markup disagree on every render. */
export const AS_OF_DAY = "2026-08-12";
export const FRESHNESS = {
  syncedAt: "12 Aug 2026, 14:00 UTC",
  completeThrough: "11 Aug 2026",
  attribution: "7-day click, 1-day view",
  cadence: "Updated hourly",
} as const;

const DAY_MS = 86_400_000;
const AS_OF_MS = Date.parse(`${AS_OF_DAY}T00:00:00Z`);

/** ISO day `n` days before the pinned as-of day (0 = as-of day). */
const dayIso = (ago: number): string =>
  new Date(AS_OF_MS - ago * DAY_MS).toISOString().slice(0, 10);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-08-12" -> "12 Aug". */
export function shortDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}
/** "2026-08-12" -> "12 Aug 2026". */
export function longDay(iso: string): string {
  const [y] = iso.split("-");
  return `${shortDay(iso)} ${y}`;
}

// ---------------------------------------------------------------------------- deterministic noise

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** Seeded 0..1 generator (mulberry32) — same seed, same sequence, every runtime. */
function rng(seed: string): () => number {
  let a = fnv1a(seed);
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t >>> 0) / 4294967296;
  };
}
/** One stable pseudo-random value per (seed, key) pair. */
const jitter = (seed: string, spread: number): number => (rng(seed)() - 0.5) * 2 * spread;

// ---------------------------------------------------------------------------- shape

export interface Brand {
  id: string;
  name: string;
  tagline: string;
  /** Contracted budget for the live engagement, in client-facing dollars. */
  budget: number;
  startAgo: number;
  endsInDays: number;
}

export type CampaignStatus = "running" | "paused" | "finished" | "scheduled";

export interface DayRow {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  regs: number;
  deposits: number;
  revenue: number;
}

export interface Campaign {
  id: string;
  name: string;
  brandId: string;
  goal: string;
  status: CampaignStatus;
  days: DayRow[];
  adSets: AdSet[];
}

export interface AdSet {
  id: string;
  name: string;
  audience: string;
  share: number;
}

export interface Totals {
  spend: number;
  impressions: number;
  clicks: number;
  regs: number;
  deposits: number;
  revenue: number;
}

/** The client's own vocabulary for the conversion events, used for every label in the UI. */
export const EVENT = { reg: "Registrations", dep: "First deposits" } as const;

export const CLIENT = {
  id: "northwind-group",
  name: "Northwind Group",
  contact: "Priya Raman",
  since: "March 2026",
} as const;

export const BRANDS: Brand[] = [
  {
    id: "northwind",
    name: "Northwind Casino",
    tagline: "Slots & live tables · UK, IE, CA",
    budget: 460_000,
    startAgo: 152,
    endsInDays: 34,
  },
  {
    id: "reelhouse",
    name: "Reelhouse",
    tagline: "Mobile-first slots · CA, AU",
    budget: 230_000,
    startAgo: 121,
    endsInDays: 19,
  },
  {
    id: "aurora",
    name: "Aurora Bets",
    tagline: "Sportsbook · DE, AT, CH",
    budget: 150_000,
    startAgo: 27,
    endsInDays: 61,
  },
];

interface Spec {
  id: string;
  name: string;
  brandId: string;
  goal: string;
  status: CampaignStatus;
  /** First and last day of delivery, as days before the as-of day. */
  startAgo: number;
  endAgo: number;
  /** Client-facing spend per day before seasonality and noise. */
  base: number;
  cpm: number;
  ctr: number;
  regRate: number;
  depRate: number;
  arpu: number;
  adSets: [string, string, number][];
}

const SPECS: Spec[] = [
  {
    id: "nw-acq-uk",
    name: "Player Acquisition — UK & IE",
    brandId: "northwind",
    goal: "New players",
    status: "running",
    startAgo: 152,
    endAgo: 0,
    base: 1480,
    cpm: 7.4,
    ctr: 0.0162,
    regRate: 0.071,
    depRate: 0.34,
    arpu: 138,
    adSets: [
      ["Broad — 25-54", "No interest targeting, UK + IE", 0.46],
      ["Slots interest — UK", "Casino & slots interests", 0.33],
      ["Lookalike 2% — depositors", "Modelled on depositing players", 0.21],
    ],
  },
  {
    id: "nw-retarget",
    name: "Retargeting — Unfinished Sign-ups",
    brandId: "northwind",
    goal: "Complete registration",
    status: "running",
    startAgo: 118,
    endAgo: 0,
    base: 430,
    cpm: 11.2,
    ctr: 0.0298,
    regRate: 0.163,
    depRate: 0.41,
    arpu: 151,
    adSets: [
      ["Started sign-up — 7 days", "Dropped off before deposit", 0.62],
      ["Site visitors — 30 days", "Viewed games, never registered", 0.38],
    ],
  },
  {
    id: "nw-live",
    name: "Live Casino — Evening Push",
    brandId: "northwind",
    goal: "New players",
    status: "running",
    startAgo: 46,
    endAgo: 0,
    base: 790,
    cpm: 8.9,
    ctr: 0.0141,
    regRate: 0.058,
    depRate: 0.37,
    arpu: 166,
    adSets: [
      ["Evenings 19:00-01:00", "Dayparted to live-dealer hours", 0.71],
      ["Table games interest", "Roulette & blackjack interests", 0.29],
    ],
  },
  {
    id: "nw-welcome",
    name: "Welcome Offer — Broad Prospecting",
    brandId: "northwind",
    goal: "New players",
    status: "paused",
    startAgo: 74,
    endAgo: 9,
    base: 620,
    cpm: 6.1,
    ctr: 0.0119,
    regRate: 0.042,
    depRate: 0.22,
    arpu: 97,
    adSets: [["Broad — no targeting", "Widest possible reach", 1]],
  },
  {
    id: "rh-slots",
    name: "Slots Prospecting — Mobile",
    brandId: "reelhouse",
    goal: "New players",
    status: "running",
    startAgo: 121,
    endAgo: 0,
    base: 1190,
    cpm: 5.8,
    ctr: 0.0187,
    regRate: 0.064,
    depRate: 0.29,
    arpu: 112,
    adSets: [
      ["Mobile feed — CA", "Phone placements only", 0.54],
      ["Mobile feed — AU", "Phone placements only", 0.46],
    ],
  },
  {
    id: "rh-spins",
    name: "Free Spins Offer — Lookalikes",
    brandId: "reelhouse",
    goal: "New players",
    status: "running",
    startAgo: 31,
    endAgo: 0,
    base: 560,
    cpm: 6.9,
    ctr: 0.0214,
    regRate: 0.088,
    depRate: 0.31,
    arpu: 104,
    adSets: [
      ["Lookalike 1% — depositors", "Modelled audience", 0.58],
      ["Lookalike 3% — registrants", "Wider modelled audience", 0.42],
    ],
  },
  {
    id: "rh-app",
    name: "App Installs — Android",
    brandId: "reelhouse",
    goal: "App installs",
    status: "finished",
    startAgo: 96,
    endAgo: 23,
    base: 480,
    cpm: 4.7,
    ctr: 0.0231,
    regRate: 0.052,
    depRate: 0.19,
    arpu: 88,
    adSets: [["Android — CA/AU", "Play Store install objective", 1]],
  },
  {
    id: "ab-launch",
    name: "Sportsbook Launch — DACH",
    brandId: "aurora",
    goal: "New players",
    status: "running",
    startAgo: 27,
    endAgo: 0,
    base: 1640,
    cpm: 9.6,
    ctr: 0.0153,
    regRate: 0.061,
    depRate: 0.38,
    arpu: 174,
    adSets: [
      ["Football interest — DE", "Bundesliga & UEFA interests", 0.52],
      ["Broad — AT/CH", "German-speaking, 25-54", 0.28],
      ["Retargeting — odds viewers", "Viewed odds, no bet placed", 0.2],
    ],
  },
  {
    id: "ab-acca",
    name: "Acca Boost — Weekend Fixtures",
    brandId: "aurora",
    goal: "Repeat bets",
    status: "scheduled",
    startAgo: -3,
    endAgo: -31,
    base: 0,
    cpm: 0,
    ctr: 0,
    regRate: 0,
    depRate: 0,
    arpu: 0,
    adSets: [["Weekend fixtures — DE", "Starts with the next matchday", 1]],
  },
];

/**
 * A real, visible incident: Northwind's accounts sat in review for three days, spend collapsed and
 * cost per registration spiked. Every client dashboard needs a story like this, because "why did my
 * CPA jump last week" is the question the portal exists to answer.
 */
const INCIDENT = { brandId: "northwind", from: 8, to: 6, spendFactor: 0.31, cpaFactor: 1.44 };

/** Weekend uplift — casino traffic peaks Friday to Sunday. */
const WEEKDAY_FACTOR = [0.93, 0.9, 0.95, 0.98, 1.06, 1.18, 1.12];

function buildCampaign(spec: Spec): Campaign {
  const days: DayRow[] = [];
  for (let ago = spec.startAgo; ago >= Math.max(spec.endAgo, 0); ago--) {
    if (spec.base === 0) break; // scheduled — no delivery yet
    const date = dayIso(ago);
    const age = spec.startAgo - ago;
    const ramp = Math.min(1, 0.45 + age / 12); // learning phase
    const trend = 1 + age * 0.0016;
    const season = WEEKDAY_FACTOR[new Date(`${date}T00:00:00Z`).getUTCDay()];
    const noise = 0.87 + rng(`${spec.id}|${date}`)() * 0.26;
    const hit =
      spec.brandId === INCIDENT.brandId && ago <= INCIDENT.from && ago >= INCIDENT.to
        ? INCIDENT
        : null;

    const spend = spec.base * ramp * trend * season * noise * (hit ? hit.spendFactor : 1);
    const cpm = spec.cpm * (1 + jitter(`cpm|${spec.id}|${date}`, 0.09));
    const ctr = spec.ctr * (1 + jitter(`ctr|${spec.id}|${date}`, 0.12));
    const regRate =
      (spec.regRate * (1 + jitter(`reg|${spec.id}|${date}`, 0.14))) / (hit ? hit.cpaFactor : 1);

    const impressions = Math.round((spend / cpm) * 1000);
    const clicks = Math.round(impressions * ctr);
    const regs = Math.round(clicks * regRate);
    const deposits = Math.round(regs * spec.depRate * (1 + jitter(`dep|${spec.id}|${date}`, 0.16)));
    const revenue = deposits * spec.arpu * (1 + jitter(`rev|${spec.id}|${date}`, 0.2));

    days.push({
      date,
      spend: Math.round(spend * 100) / 100,
      impressions,
      clicks,
      regs,
      deposits,
      revenue: Math.round(revenue),
    });
  }
  return {
    id: spec.id,
    name: spec.name,
    brandId: spec.brandId,
    goal: spec.goal,
    status: spec.status,
    days,
    adSets: spec.adSets.map(([name, audience, share], i) => ({
      id: `${spec.id}-as${i}`,
      name,
      audience,
      share,
    })),
  };
}

export const CAMPAIGNS: Campaign[] = SPECS.map(buildCampaign);

// ---------------------------------------------------------------------------- selectors

export type RangeKey = "7d" | "28d" | "90d";
export const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: "7d", label: "7 days", days: 7 },
  { key: "28d", label: "28 days", days: 28 },
  { key: "90d", label: "90 days", days: 90 },
];
export const rangeDays = (r: RangeKey): number => RANGES.find((x) => x.key === r)!.days;

export interface Window {
  since: string;
  until: string;
  days: number;
}
export function windowFor(range: RangeKey): Window {
  const days = rangeDays(range);
  return { since: dayIso(days - 1), until: AS_OF_DAY, days };
}
/** The equal-length window immediately before `range`, for period-over-period deltas. */
function priorWindow(range: RangeKey): Window {
  const days = rangeDays(range);
  return { since: dayIso(days * 2 - 1), until: dayIso(days), days };
}

/** `null` brand = every brand the client owns (the merged view). */
export type BrandFilter = string | null;

const inBrand = (c: Campaign, brand: BrandFilter): boolean => brand === null || c.brandId === brand;

export const ZERO: Totals = {
  spend: 0,
  impressions: 0,
  clicks: 0,
  regs: 0,
  deposits: 0,
  revenue: 0,
};

function add(a: Totals, r: DayRow): Totals {
  a.spend += r.spend;
  a.impressions += r.impressions;
  a.clicks += r.clicks;
  a.regs += r.regs;
  a.deposits += r.deposits;
  a.revenue += r.revenue;
  return a;
}

function totalsIn(win: Window, brand: BrandFilter, campaignId?: string): Totals {
  const t = { ...ZERO };
  for (const c of CAMPAIGNS) {
    if (!inBrand(c, brand)) continue;
    if (campaignId && c.id !== campaignId) continue;
    for (const d of c.days) if (d.date >= win.since && d.date <= win.until) add(t, d);
  }
  return t;
}

export const totalsFor = (range: RangeKey, brand: BrandFilter): Totals =>
  totalsIn(windowFor(range), brand);
export const priorTotalsFor = (range: RangeKey, brand: BrandFilter): Totals =>
  totalsIn(priorWindow(range), brand);

export interface Derived extends Totals {
  ctr: number;
  cpm: number;
  cpc: number;
  costPerReg: number;
  costPerDep: number;
  regRate: number;
  roas: number;
}
const ratio = (a: number, b: number): number => (b > 0 ? a / b : 0);
export function derive(t: Totals): Derived {
  return {
    ...t,
    ctr: ratio(t.clicks, t.impressions) * 100,
    cpm: ratio(t.spend, t.impressions) * 1000,
    cpc: ratio(t.spend, t.clicks),
    costPerReg: ratio(t.spend, t.regs),
    costPerDep: ratio(t.spend, t.deposits),
    regRate: ratio(t.regs, t.clicks) * 100,
    roas: ratio(t.revenue, t.spend),
  };
}

/** Daily series for the trend chart, summed across the selected brands. */
export function seriesFor(range: RangeKey, brand: BrandFilter): DayRow[] {
  const win = windowFor(range);
  const byDate = new Map<string, DayRow>();
  for (const c of CAMPAIGNS) {
    if (!inBrand(c, brand)) continue;
    for (const d of c.days) {
      if (d.date < win.since || d.date > win.until) continue;
      const row = byDate.get(d.date) ?? { ...ZERO, date: d.date };
      byDate.set(d.date, add(row as Totals, d) as DayRow);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Split a campaign's window totals across its ad sets. Spend and delivery follow each ad set's share
 * of delivery; results carry a stable efficiency skew, normalised back to the campaign total — so the
 * audiences add up but do not all report the same cost per result.
 */
function adSetRows(c: Campaign, t: Totals): (AdSet & Derived)[] {
  const eff = c.adSets.map((s) => ({ s, e: 1 + jitter(`adset|${s.id}`, 0.34) }));
  const effSum = eff.reduce((acc, x) => acc + x.s.share * x.e, 0);
  return eff.map(({ s, e }) => {
    const resultShare = (s.share * e) / (effSum || 1);
    return {
      ...s,
      ...derive({
        spend: t.spend * s.share,
        impressions: Math.round(t.impressions * s.share),
        clicks: Math.round(t.clicks * s.share),
        regs: Math.round(t.regs * resultShare),
        deposits: Math.round(t.deposits * resultShare),
        revenue: Math.round(t.revenue * resultShare),
      }),
    };
  });
}

export interface CampaignRow extends Derived {
  id: string;
  name: string;
  brandId: string;
  brandName: string;
  goal: string;
  status: CampaignStatus;
  /** Daily client-facing spend across the window, for the row sparkline. */
  trend: number[];
  adSets: (AdSet & Derived)[];
}

export function campaignRows(range: RangeKey, brand: BrandFilter): CampaignRow[] {
  const win = windowFor(range);
  const rows: CampaignRow[] = [];
  for (const c of CAMPAIGNS) {
    if (!inBrand(c, brand)) continue;
    const inWin = c.days.filter((d) => d.date >= win.since && d.date <= win.until);
    const t = inWin.reduce((acc, d) => add(acc, d), { ...ZERO });
    const brandName = BRANDS.find((b) => b.id === c.brandId)!.name;
    rows.push({
      ...derive(t),
      id: c.id,
      name: c.name,
      brandId: c.brandId,
      brandName,
      goal: c.goal,
      status: c.status,
      trend: inWin.map((d) => d.spend),
      adSets: adSetRows(c, t),
    });
  }
  return rows.sort((a, b) => b.spend - a.spend);
}

// ---------------------------------------------------------------------------- breakdowns

export type Dimension = "platform" | "placement" | "device" | "country";
export const DIMENSIONS: { key: Dimension; label: string }[] = [
  { key: "platform", label: "Platform" },
  { key: "placement", label: "Placement" },
  { key: "device", label: "Device" },
  { key: "country", label: "Country" },
];

const DIM_VALUES: Record<Dimension, [string, number][]> = {
  platform: [
    ["Instagram", 0.44],
    ["Facebook", 0.41],
    ["Audience Network", 0.1],
    ["Messenger", 0.05],
  ],
  placement: [
    ["Feed", 0.36],
    ["Reels", 0.29],
    ["Stories", 0.18],
    ["Explore", 0.09],
    ["Search results", 0.08],
  ],
  device: [
    ["Mobile app", 0.58],
    ["Mobile web", 0.24],
    ["Desktop", 0.13],
    ["Tablet", 0.05],
  ],
  country: [
    ["United Kingdom", 0.31],
    ["Germany", 0.22],
    ["Canada", 0.18],
    ["Australia", 0.14],
    ["Ireland", 0.09],
    ["Austria", 0.06],
  ],
};

export interface Segment {
  label: string;
  /** Share of spend in the window. */
  share: number;
  totals: Totals;
}

/**
 * Split the window totals across a dimension. Spend and delivery follow the segment weight; results
 * additionally carry a stable efficiency skew, then get normalised back to the true total, so the
 * segments always add up to the headline figure while their cost-per-result differs.
 */
export function dimensionTotals(range: RangeKey, brand: BrandFilter, dim: Dimension): Segment[] {
  const t = totalsFor(range, brand);
  const seed = `${dim}|${brand ?? "all"}|${range}`;
  const weights = DIM_VALUES[dim].map(([label, w]) => ({
    label,
    w: Math.max(0.01, w * (1 + jitter(`w|${seed}|${label}`, 0.22))),
  }));
  const wSum = weights.reduce((s, x) => s + x.w, 0);

  const raw = weights.map(({ label, w }) => ({
    label,
    share: w / wSum,
    eff: 1 + jitter(`e|${seed}|${label}`, 0.3),
  }));
  const effSum = raw.reduce((s, x) => s + x.share * x.eff, 0);

  return raw
    .map(({ label, share, eff }) => {
      const resultShare = (share * eff) / (effSum || 1);
      return {
        label,
        share,
        totals: {
          spend: t.spend * share,
          impressions: Math.round(t.impressions * share),
          clicks: Math.round(t.clicks * share),
          regs: Math.round(t.regs * resultShare),
          deposits: Math.round(t.deposits * resultShare),
          revenue: Math.round(t.revenue * resultShare),
        },
      };
    })
    .sort((a, b) => b.totals.spend - a.totals.spend);
}

export interface BreakdownRow {
  label: string;
  spend: number;
  regs: number;
  costPerReg: number;
  share: number;
}

export function breakdownFor(range: RangeKey, brand: BrandFilter, dim: Dimension): BreakdownRow[] {
  return dimensionTotals(range, brand, dim).map((s) => ({
    label: s.label,
    spend: s.totals.spend,
    regs: s.totals.regs,
    costPerReg: ratio(s.totals.spend, s.totals.regs),
    share: s.share,
  }));
}

// ---------------------------------------------------------------------------- pacing

export interface Pacing {
  brandName: string;
  budget: number;
  spent: number;
  remaining: number;
  pctSpent: number;
  /** Budget-weighted share of the flight already elapsed — the "even pace" marker. */
  elapsedPct: number;
  daysLeft: number;
  avgPerDay: number;
  projected: number;
  /** Where the burn ends up against the contracted budget. */
  verdict: "on track" | "ahead of plan" | "behind plan";
  endsOn: string;
}

/**
 * Contracted budget vs burn. Each brand is paced against its OWN flight and the results are added,
 * because the brands started on different dates — pacing the merged total against one date range
 * would read wildly off for whichever brand launched last.
 */
export function pacingFor(brand: BrandFilter): Pacing {
  const brands = brand === null ? BRANDS : BRANDS.filter((b) => b.id === brand);
  const per = brands.map((b) => {
    const elapsed = b.startAgo + 1;
    const spent = CAMPAIGNS.filter((c) => c.brandId === b.id).reduce(
      (s, c) => s + c.days.reduce((x, d) => x + d.spend, 0),
      0,
    );
    const perDay = spent / elapsed;
    return {
      budget: b.budget,
      spent,
      perDay,
      projected: spent + perDay * b.endsInDays,
      elapsedShare: elapsed / (elapsed + b.endsInDays),
    };
  });

  const budget = per.reduce((s, p) => s + p.budget, 0);
  const spent = per.reduce((s, p) => s + p.spent, 0);
  const projected = per.reduce((s, p) => s + p.projected, 0);
  const daysLeft = Math.min(...brands.map((b) => b.endsInDays));
  const drift = projected / budget;
  return {
    brandName: brand === null ? "All brands" : brands[0].name,
    budget,
    spent,
    remaining: Math.max(0, budget - spent),
    pctSpent: (spent / budget) * 100,
    elapsedPct: (per.reduce((s, p) => s + p.budget * p.elapsedShare, 0) / budget) * 100,
    daysLeft,
    avgPerDay: per.reduce((s, p) => s + p.perDay, 0),
    projected,
    verdict: drift > 1.05 ? "ahead of plan" : drift < 0.95 ? "behind plan" : "on track",
    endsOn: dayIso(-daysLeft),
  };
}

// ---------------------------------------------------------------------------- creatives

export type CreativeReview = "approved" | "pending" | "changes";
export interface Creative {
  id: string;
  name: string;
  brandId: string;
  brandName: string;
  format: "Video 15s" | "Video 30s" | "Static" | "Carousel";
  hook: string;
  hue: number;
  spend: number;
  impressions: number;
  clicks: number;
  regs: number;
  ctr: number;
  costPerReg: number;
  firstSeen: string;
  review: CreativeReview;
  /** Frequency-driven fatigue read, the signal clients actually ask about. */
  fatigue: "fresh" | "steady" | "fatiguing";
}

const CREATIVE_SEEDS: [string, string, string, Creative["format"], number][] = [
  ["nw-c1", "northwind", "Live dealer table, dealer looks up", "Video 15s", 268],
  ["nw-c2", "northwind", "£50 welcome — spinning reels", "Video 30s", 34],
  ["nw-c3", "northwind", "Winner reaction, split screen", "Video 15s", 196],
  ["nw-c4", "northwind", "Static — jackpot counter", "Static", 52],
  ["nw-c5", "northwind", "Carousel — five game tiles", "Carousel", 312],
  ["rh-c1", "reelhouse", "Thumb-stopping reel drop", "Video 15s", 158],
  ["rh-c2", "reelhouse", "200 free spins, phone in hand", "Video 15s", 12],
  ["rh-c3", "reelhouse", "Static — game grid, dark mode", "Static", 232],
  ["rh-c4", "reelhouse", "Carousel — top 5 slots this week", "Carousel", 88],
  ["ab-c1", "aurora", "Stadium walk-in, odds overlay", "Video 30s", 205],
  ["ab-c2", "aurora", "Acca builder screen recording", "Video 15s", 128],
  ["ab-c3", "aurora", "Static — matchday odds board", "Static", 8],
];

export function creativesFor(brand: BrandFilter): Creative[] {
  return CREATIVE_SEEDS.filter(([, b]) => brand === null || b === brand).map(
    ([id, brandId, hook, format, hue]) => {
      const r = rng(`creative|${id}`);
      const spend = 1800 + r() * 14_000;
      const cpm = 5.5 + r() * 6;
      const impressions = Math.round((spend / cpm) * 1000);
      const ctr = 0.009 + r() * 0.026;
      const clicks = Math.round(impressions * ctr);
      const regs = Math.max(1, Math.round(clicks * (0.035 + r() * 0.09)));
      const age = Math.round(4 + r() * 80);
      const fatigueRoll = r();
      const review: CreativeReview = id.endsWith("c2")
        ? "pending"
        : id.endsWith("c4")
          ? "changes"
          : "approved";
      return {
        id,
        name: hook.split(" — ")[0],
        brandId,
        brandName: BRANDS.find((b) => b.id === brandId)!.name,
        format,
        hook,
        hue,
        spend,
        impressions,
        clicks,
        regs,
        ctr: ctr * 100,
        costPerReg: spend / regs,
        firstSeen: dayIso(age),
        review,
        fatigue: age < 14 ? "fresh" : fatigueRoll > 0.62 ? "fatiguing" : "steady",
      };
    },
  );
}

// ---------------------------------------------------------------------------- client language

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  running: "Running",
  paused: "Paused",
  finished: "Finished",
  scheduled: "Scheduled",
};
