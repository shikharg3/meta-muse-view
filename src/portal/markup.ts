import { inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { addDays } from "@/lib/range";

/**
 * Commission markup — the agency's margin, applied server-side and never shipped.
 *
 * ## Where the markup is applied, and why it matters
 *
 * It is folded into `spend` on each DAILY, CAMPAIGN-LEVEL row, before anything is aggregated or
 * derived. Every cost metric the portal shows (CPC, CPM, cost per deposit, ROAS, pacing) is then
 * computed from the marked-up figure and is automatically consistent.
 *
 * The alternative — aggregate raw, then multiply a list of "cost keys" at the end — is what the
 * design mock did, and it is a bug generator: the list has to be kept in step with every metric
 * anyone adds, and the one that gets forgotten silently reports the agency's true cost to the
 * client. Here there is no list to forget, because raw spend never survives past `markupRows()`.
 *
 * ## Why campaign-level, daily
 *
 * A rate belongs to a campaign and changes on a date, so the product `spend × rate` is only
 * well-defined at that grain. Account-level insight rows cannot be split across the campaigns that
 * produced them, so the portal reads `level = 'campaign'` rows exclusively — which is also the only
 * grain at which campaign ownership (shared and recycled ad accounts) is decidable. One constraint
 * satisfies both requirements.
 *
 * ## Which rate a day gets
 *
 * Every level is a DATED schedule, and an entry applies from its `fromDate` (inclusive) until the
 * next entry of the same level. A campaign-day is priced by the first level with an entry in force
 * ON THAT DAY: the campaign's own history, else its Brand's schedule, else its Client's, else
 * `PORTAL_DEFAULT_COMMISSION`. Nothing is extended backwards — a rate added "from today" at any
 * level leaves every earlier day at whatever it was billed before, which is what lets an operator
 * change a commission mid-campaign without rewriting the figures a client has already seen.
 */

/** Uplift for a day no campaign, Brand or Client entry covers. */
export const PORTAL_DEFAULT_COMMISSION = 10;

/** One rate, effective from `fromDate` until the next period begins. */
export interface CommissionPeriod {
  fromDate: string; // YYYY-MM-DD
  rate: number; // percent uplift; 12 => ×1.12
}

/**
 * One entry of a Client's or Brand's dated default (`commission_defaults`). `rate: null` sets no
 * rate: from `fromDate` those days go back to the next level down.
 */
export interface DefaultCommissionPeriod {
  fromDate: string; // YYYY-MM-DD
  rate: number | null;
}

/** Rate history per campaign id, each list sorted oldest-first. */
export type CommissionTable = Map<string, CommissionPeriod[]>;

/** Dated defaults by target id, each list sorted oldest-first. */
export interface DefaultCommissionTable {
  /** By `brands.id` — a Client's default. */
  brand: Map<string, DefaultCommissionPeriod[]>;
  /** By global group id (`<owner>:<key>`) — a Brand's rate. */
  group: Map<string, DefaultCommissionPeriod[]>;
}

/**
 * What a campaign-day falls back to when the campaign has no entry of its own in force that day:
 * its Brand's rate, else its Client's, else the agency default — each as it stood on `date`.
 */
export type DefaultRateLookup = (campaignId: string, date: string) => number;

const byFromDate = (a: { fromDate: string }, b: { fromDate: string }) =>
  a.fromDate.localeCompare(b.fromDate);

/**
 * Load the rate history for the given campaigns.
 *
 * Returns a bare map — campaigns with no history are simply absent, and the caller supplies the
 * default lookup. Empty input short-circuits so callers need no special case.
 */
export async function loadCommissions(campaignIds: string[]): Promise<CommissionTable> {
  const table: CommissionTable = new Map();
  if (campaignIds.length === 0) return table;

  const rows = await db
    .select({
      campaignId: schema.campaignCommissions.campaignId,
      fromDate: schema.campaignCommissions.fromDate,
      rate: schema.campaignCommissions.rate,
    })
    .from(schema.campaignCommissions)
    .where(inArray(schema.campaignCommissions.campaignId, campaignIds));

  for (const r of rows) {
    const list = table.get(r.campaignId);
    const period = { fromDate: String(r.fromDate), rate: r.rate };
    if (list) list.push(period);
    else table.set(r.campaignId, [period]);
  }
  for (const list of table.values()) list.sort(byFromDate);
  return table;
}

/**
 * Load Client and Brand schedules in one query: those of the given targets, or every one when
 * `only` is absent (the staff list, which shows them all — the table holds tens of rows).
 *
 * The query matches ids only and the kind is checked here: a `brands.id` (a UUID) and a group id
 * (`<owner>:<key>`) cannot collide, and one `IN` list keeps it a single round trip on the portal's
 * hottest path.
 */
export async function loadDefaultCommissions(only?: {
  brandIds: readonly string[];
  groupIds: readonly string[];
}): Promise<DefaultCommissionTable> {
  const table: DefaultCommissionTable = { brand: new Map(), group: new Map() };
  const ids = only ? [...only.brandIds, ...only.groupIds] : null;
  if (ids !== null && ids.length === 0) return table;
  const wantBrand = only ? new Set(only.brandIds) : null;
  const wantGroup = only ? new Set(only.groupIds) : null;

  const t = schema.commissionDefaults;
  const rows = await db
    .select({ kind: t.targetKind, targetId: t.targetId, fromDate: t.fromDate, rate: t.rate })
    .from(t)
    .where(ids === null ? undefined : inArray(t.targetId, ids));

  for (const r of rows) {
    let map: Map<string, DefaultCommissionPeriod[]>;
    if (r.kind === "brand" && (wantBrand === null || wantBrand.has(r.targetId))) map = table.brand;
    else if (r.kind === "group" && (wantGroup === null || wantGroup.has(r.targetId)))
      map = table.group;
    else continue;
    const period = { fromDate: String(r.fromDate), rate: r.rate };
    const list = map.get(r.targetId);
    if (list) list.push(period);
    else map.set(r.targetId, [period]);
  }
  for (const list of table.brand.values()) list.sort(byFromDate);
  for (const list of table.group.values()) list.sort(byFromDate);
  return table;
}

/**
 * The entry in force on `date`: the last one that has begun. Undefined before the first entry —
 * the level has nothing to say about those days, and the caller asks the next level down.
 */
export function periodOn<P extends { fromDate: string }>(
  periods: readonly P[] | undefined,
  date: string,
): P | undefined {
  if (!periods) return undefined;
  let found: P | undefined;
  for (const p of periods) {
    if (p.fromDate > date) break;
    found = p;
  }
  return found;
}

/**
 * A campaign's own rate on `date`, else `fallback`.
 *
 * `fallback` covers every day before the first period too: a rate added today with
 * `from_date = today` says what today onwards costs, and says nothing about yesterday.
 */
export function rateOn(
  periods: readonly CommissionPeriod[] | undefined,
  date: string,
  fallback: number,
): number {
  return periodOn(periods, date)?.rate ?? fallback;
}

/** A Client's or Brand's rate on `date`; null when it sets none that day (no entry yet, or an inherit entry). */
export function defaultRateOn(
  periods: readonly DefaultCommissionPeriod[] | undefined,
  date: string,
): number | null {
  return periodOn(periods, date)?.rate ?? null;
}

/** The level a day's rate came from. */
export type CommissionSource = "campaign" | "group" | "brand" | "default";

/** The schedules one campaign (or one Brand, or one Client) resolves through, most specific first. */
export interface CommissionLevels {
  campaign?: readonly CommissionPeriod[];
  group?: readonly DefaultCommissionPeriod[];
  brand?: readonly DefaultCommissionPeriod[];
}

/**
 * The rate billed on `date` and where it came from — the same order `markupRows` applies through
 * `defaultCommissionLookup`, spelled out with the source so the staff screens can say "inherited".
 */
export function commissionOn(
  levels: CommissionLevels,
  date: string,
  fallback: number,
): { rate: number; source: CommissionSource } {
  const own = periodOn(levels.campaign, date);
  if (own) return { rate: own.rate, source: "campaign" };
  const group = defaultRateOn(levels.group, date);
  if (group !== null) return { rate: group, source: "group" };
  const brand = defaultRateOn(levels.brand, date);
  if (brand !== null) return { rate: brand, source: "brand" };
  return { rate: fallback, source: "default" };
}

/** One stretch of days billed at one rate from one level. */
export interface EffectiveCommission {
  /** First day, inclusive; null = every day before the first entry at any level. */
  fromDate: string | null;
  /** Last day, inclusive; null = ongoing. */
  toDate: string | null;
  rate: number;
  source: CommissionSource;
}

/**
 * What is actually billed, day by day, once every level is folded in — oldest first, gapless, with
 * neighbouring stretches merged when both the rate and its source are the same.
 *
 * A day's rate can only change where some level's entry begins, so resolving each of those dates
 * (and "before all of them") is exhaustive. This is the staff screens' only view of the margin: it
 * exists so the admin console never re-implements the resolution and quietly disagrees with the
 * portal's figures.
 */
export function effectiveTimeline(
  levels: CommissionLevels,
  fallback: number,
): EffectiveCommission[] {
  const starts = new Set<string>();
  for (const list of [levels.campaign, levels.group, levels.brand]) {
    for (const p of list ?? []) starts.add(p.fromDate);
  }
  const out: EffectiveCommission[] = [
    { fromDate: null, toDate: null, rate: fallback, source: "default" },
  ];
  for (const date of [...starts].sort()) {
    const at = commissionOn(levels, date, fallback);
    const last = out[out.length - 1];
    if (last.rate === at.rate && last.source === at.source) continue;
    last.toDate = addDays(date, -1);
    out.push({ fromDate: date, toDate: null, ...at });
  }
  return out;
}

/** A daily row as the portal reads it: campaign-level, one date, raw spend. */
export interface RawDayRow {
  campaignId: string;
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
  conversionValues: number;
}

/** The same row with the markup folded in. Structurally identical, but `spend` is client-facing. */
export type MarkedDayRow = RawDayRow;

/**
 * Fold each row's commission into its spend.
 *
 * `defaultFor` answers for a row whose campaign has no entry of its own in force on the row's
 * date; it is a lookup rather than a single number because one request spans several Clients and
 * Brands, each with its own dated schedule. It is only consulted when needed — most rows of a
 * campaign with history never reach it.
 *
 * Mutating in place would be marginally cheaper, but these rows come straight from a query and are
 * also used to attribute campaigns to brands; returning new objects keeps "has the markup been
 * applied?" answerable by type rather than by tracing call order.
 */
export function markupRows(
  rows: RawDayRow[],
  commissions: CommissionTable,
  defaultFor: DefaultRateLookup,
): MarkedDayRow[] {
  return rows.map((r) => {
    const own = periodOn(commissions.get(r.campaignId), r.date);
    const rate = own ? own.rate : defaultFor(r.campaignId, r.date);
    return { ...r, spend: r.spend * (1 + rate / 100) };
  });
}

/**
 * Marked-up spend for a set of rows — the only spend figure the portal may serialise.
 *
 * Exists so a caller that needs just the total cannot accidentally reach for the raw column: the
 * aggregate is computed from rows that have already been through `markupRows`.
 */
export const totalSpend = (rows: MarkedDayRow[]): number =>
  rows.reduce((sum, r) => sum + r.spend, 0);
