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

/** Inclusive date window the server fns query insights over. */
export interface DateWindow {
  /** inclusive lower bound, YYYY-MM-DD */
  since: string;
  /** inclusive upper bound, YYYY-MM-DD */
  until: string;
  /** inclusive lower bound of the preceding equal-length window (period-over-period deltas) */
  prevSince: string;
  /** inclusive length in days (labels / CSV filenames) */
  days: number;
}

/** A range request from the UI: a trailing preset day-count, or an explicit custom from/to. */
export interface RangeSpec {
  days: number;
  from?: string;
  to?: string;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `v` is a real calendar date in strict YYYY-MM-DD form. */
export function isYmd(v: unknown): v is string {
  if (typeof v !== "string" || !YMD_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** Add `n` days to a YYYY-MM-DD date (UTC), returning YYYY-MM-DD. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysInclusive(since: string, until: string): number {
  const a = Date.parse(`${since}T00:00:00Z`);
  const b = Date.parse(`${until}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

/** Trailing preset window: [today-(days-1), today] inclusive. */
export function windowFromDays(days: number, today = new Date()): DateWindow {
  const n = days > 0 ? days : DEFAULT_RANGE;
  const until = today.toISOString().slice(0, 10);
  return {
    since: addDays(until, -(n - 1)),
    until,
    prevSince: addDays(until, -(2 * n - 1)),
    days: n,
  };
}

/** Explicit custom window; the previous window is the same length immediately before `from`. */
export function windowFromDates(from: string, to: string): DateWindow {
  const [since, until] = from <= to ? [from, to] : [to, from];
  const days = daysInclusive(since, until);
  return { since, until, prevSince: addDays(since, -days), days };
}

/** Resolve a UI range request to a concrete date window (caller supplies server-side `today`). */
export function resolveWindow(spec: RangeSpec, today = new Date()): DateWindow {
  if (spec.from && spec.to && isYmd(spec.from) && isYmd(spec.to))
    return windowFromDates(spec.from, spec.to);
  return windowFromDays(spec.days, today);
}

/** Human label for the active range (custom range → "from → to", else the preset label). */
export function rangeLabel(spec: { range?: unknown; from?: string; to?: string }): string {
  if (spec.from && spec.to && isYmd(spec.from) && isYmd(spec.to))
    return `${spec.from} → ${spec.to}`;
  return RANGE_LABELS[toRange(spec.range)];
}

/** validateSearch helper for range-aware routes (preset ?range= plus optional custom ?from=&to=). */
export function rangeSearch(search: Record<string, unknown>): {
  range?: RangeDays;
  from?: string;
  to?: string;
} {
  const out: { range?: RangeDays; from?: string; to?: string } = {};
  const n = Number(search.range);
  if ((RANGE_DAYS as readonly number[]).includes(n)) out.range = n as RangeDays;
  if (isYmd(search.from) && isYmd(search.to)) {
    out.from = search.from;
    out.to = search.to;
  }
  return out;
}

/** validateSearch helper that keeps the range (+ custom from/to) and the global ?accounts= scope. */
export function scopedSearch(search: Record<string, unknown>): {
  range?: RangeDays;
  from?: string;
  to?: string;
  accounts?: string;
} {
  return {
    ...rangeSearch(search),
    ...(typeof search.accounts === "string" && search.accounts
      ? { accounts: search.accounts }
      : {}),
  };
}

/** Build the server-fn range input from a route's search params. */
export function rangeSpec(search: { range?: unknown; from?: string; to?: string }): RangeSpec {
  return { days: toRange(search.range), from: search.from, to: search.to };
}

/** Parse the global ?accounts= scope (comma-joined act ids); empty Set = no filter. */
export function accountScope(accounts: unknown): Set<string> {
  return new Set(typeof accounts === "string" ? accounts.split(",").filter(Boolean) : []);
}
