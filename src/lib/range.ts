export const RANGE_DAYS = [7, 14, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];
export const DEFAULT_RANGE: RangeDays = 30;

export const RANGE_LABELS: Record<RangeDays, string> = {
  7: "Last 7 days",
  14: "Last 14 days",
  30: "Last 30 days",
  90: "Last 90 days",
};

/** Coerce an unknown ?range= search value to an allowed preset (default 30). */
export function toRange(value: unknown): RangeDays {
  const n = Number(value);
  return (RANGE_DAYS as readonly number[]).includes(n) ? (n as RangeDays) : DEFAULT_RANGE;
}

/** validateSearch helper for range-aware routes. */
export function rangeSearch(search: Record<string, unknown>): { range?: RangeDays } {
  const n = Number(search.range);
  return (RANGE_DAYS as readonly number[]).includes(n) ? { range: n as RangeDays } : {};
}
