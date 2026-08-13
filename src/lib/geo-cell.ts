/**
 * Formats the Notion board's `🤖 Geo Delivered 14d` cell from Meta's country and region breakdowns.
 *
 * Pure by design: the caller passes already-fetched rows, so this module imports nothing from
 * `sync/`, `db/` or `server/`. Which window they were measured over is the caller's business - this
 * only turns spend into shares.
 *
 * The cell answers "where did the money actually land". That is a DIFFERENT question from the human
 * `Geo's` column beside it, which records what was agreed (prose, ranked preferences, budget splits).
 * Never merge the two, and never write `Geo's`.
 */

/** Meta's bucket for spend it could not place. Real money, so it counts toward the totals and shows
 *  like any other entry — but it names no place, so it can never be the country that triggers the
 *  region drill, and a region line consisting only of it is suppressed. */
export const UNKNOWN_GEO = "unknown";

/** Under 1% is inside Meta's own geo attribution slop, and showing it only crowds the cell. */
const MIN_SHARE = 0.01;

/** Eight is a judgement call: enough to show a real spread, few enough to stay one glanceable line. */
const MAX_ENTRIES = 8;

/**
 * One breakdown bucket's spend over the measured window.
 *
 * Rows must already be summed per `value`. `insights_breakdown_daily` is keyed per day, so an
 * unaggregated window query returns one row per value per date, and each would render as its own
 * entry. `destinationCell` states its de-duplication precondition the same way.
 */
export interface GeoSpend {
  type: "country" | "region";
  value: string;
  spend: number;
}

/**
 * The entries a line will actually name: those clearing `MIN_SHARE`, capped at `MAX_ENTRIES`, or the
 * single leader when nothing clears it. Separate from `shareLine` because the region-line guard has
 * to test what will be NAMED, and the raw rows do not answer that.
 */
function keptEntries(entries: GeoSpend[], total: number): GeoSpend[] {
  // Ties must not depend on the caller's row order. An unchanged cell is never rewritten, so a
  // reshuffled tie would fire a write and reset the row's `Last edited time` for no change in fact.
  const ranked = [...entries].sort((a, b) => b.spend - a.spend || a.value.localeCompare(b.value));
  const material = ranked.filter((e) => e.spend / total >= MIN_SHARE);
  // A line of nothing but "+K more" is a cell with no content. Spend spread thinly across 100+
  // buckets puts every share under MIN_SHARE, so the leader is named regardless.
  return (material.length > 0 ? material : ranked.slice(0, 1)).slice(0, MAX_ENTRIES);
}

/**
 * One line of shares, ordered by spend: `US 93% · GE 2% · ZA 2% · IT 1% · +18 more`. Entries under
 * `MIN_SHARE`, and any beyond `MAX_ENTRIES`, are counted rather than shown - the count is what tells
 * the reader a long tail exists. When nothing clears `MIN_SHARE` the leader is shown anyway, so the
 * line always carries a share and is never a bare `+K more`.
 */
function shareLine(entries: GeoSpend[], total: number): string {
  const kept = keptEntries(entries, total);
  const parts = kept.map((e) => `${e.value} ${Math.round((e.spend / total) * 100)}%`);
  const dropped = entries.length - kept.length;
  if (dropped > 0) parts.push(`+${dropped} more`);
  return parts.join(" · ");
}

/**
 * The cell text. Line 1 is the country split. Line 2 is the region split, present only when exactly
 * one identified country delivered AND the region line will name something other than `unknown`:
 * the region breakdown is not scoped by country, so mixing two countries' regions under a
 * single-country heading would be a quiet lie. Note "will name" — the test is on what survives
 * `MIN_SHARE` into the rendered line, not on the raw rows.
 *
 * Returns "" when nothing delivered. The caller decides whether that means "clear the cell" or "the
 * breakdown data has not caught up" - this function cannot tell those apart, and guessing wrong
 * blanks a delivering row.
 *
 * Length is bounded by construction (two lines, at most 8 entries plus a count each), so there is no
 * truncation branch.
 */
export function geoCell(rows: GeoSpend[]): string {
  const countries = rows.filter((r) => r.type === "country" && r.spend > 0);
  const total = countries.reduce((n, r) => n + r.spend, 0);
  if (total <= 0) return "";

  const lines = [shareLine(countries, total)];
  const identified = countries.filter((r) => r.value !== UNKNOWN_GEO);
  if (identified.length === 1) {
    const regions = rows.filter((r) => r.type === "region" && r.spend > 0);
    const regionTotal = regions.reduce((n, r) => n + r.spend, 0);
    // `unknown` stays in the denominator so the placed shares do not silently absorb the unplaced
    // spend, but a line naming nothing else just repeats line 1. Measured against production: 123
    // campaigns carry a positive `unknown` region bucket over 60 days. The test is on what survives
    // into the rendered line, not on the raw rows - a named region under MIN_SHARE is filtered out.
    if (keptEntries(regions, regionTotal).some((r) => r.value !== UNKNOWN_GEO)) {
      lines.push(shareLine(regions, regionTotal));
    }
  }
  return lines.join("\n");
}
