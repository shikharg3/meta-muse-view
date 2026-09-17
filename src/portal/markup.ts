import { inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";

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
 */

/** Fallback uplift for a campaign with no rate history and a brand with no default. */
export const PORTAL_DEFAULT_COMMISSION = 10;

/** One rate, effective from `fromDate` until the next period begins. */
export interface CommissionPeriod {
  fromDate: string; // YYYY-MM-DD
  rate: number; // percent uplift; 12 => ×1.12
}

/** Rate history per campaign id, each list sorted oldest-first. */
export type CommissionTable = Map<string, CommissionPeriod[]>;

/**
 * Load the rate history for the given campaigns.
 *
 * Returns a bare map — campaigns with no history are simply absent, and the caller supplies the
 * brand default. Empty input short-circuits so callers need no special case.
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
  for (const list of table.values()) list.sort((a, b) => a.fromDate.localeCompare(b.fromDate));
  return table;
}

/**
 * The rate in force on `date`.
 *
 * The earliest period applies to everything before it as well: a rate added today with
 * `from_date = today` must not leave yesterday with no rate at all, and back-dating the first
 * period to the campaign's start is what the operator means by "since the start".
 */
export function rateOn(
  periods: CommissionPeriod[] | undefined,
  date: string,
  fallback: number,
): number {
  if (!periods || periods.length === 0) return fallback;
  let rate = periods[0].rate;
  for (const p of periods) {
    if (p.fromDate > date) break;
    rate = p.rate;
  }
  return rate;
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
 * `defaultFor` supplies the brand-level fallback for a campaign with no history of its own; it is a
 * lookup rather than a single number because one request spans several brands, each with its own
 * default rate.
 *
 * Mutating in place would be marginally cheaper, but these rows come straight from a query and are
 * also used to attribute campaigns to brands; returning new objects keeps "has the markup been
 * applied?" answerable by type rather than by tracing call order.
 */
export function markupRows(
  rows: RawDayRow[],
  commissions: CommissionTable,
  defaultFor: (campaignId: string) => number,
): MarkedDayRow[] {
  return rows.map((r) => {
    const rate = rateOn(commissions.get(r.campaignId), r.date, defaultFor(r.campaignId));
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
