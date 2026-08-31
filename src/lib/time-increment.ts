/**
 * Meta's `time_increment`, reproduced against our synced daily rows.
 *
 * The values are Meta's own vocabulary — `all_days`, a day count, `monthly` — and so are the bucket
 * boundaries, which were measured against the Graph API rather than assumed:
 *
 *   - A day count anchors at `since`; the final bucket is clipped by `until`. It is NOT a calendar
 *     week: `since=2026-08-02` yields 08-02..08-08, 08-09..08-15, …, while `since=2026-08-05` on the
 *     same `until` yields 08-05..08-11, 08-12..08-18, …
 *   - `monthly` is calendar months, clipped at BOTH ends of the range: 2026-08-01..08-26 and
 *     2026-08-10..08-26 each return one bucket spanning exactly the requested days.
 *   - `all_days` is the whole range in a single bucket.
 *
 * Bucketing locally is exact for additive metrics, because the stored rows are Meta's own daily rows
 * (verified field-by-field). It is never exact for de-duplicated metrics — see `isAdditive` in
 * report-catalog.ts, which is why those are withheld rather than summed.
 *
 * UTC arithmetic on plain YYYY-MM-DD strings, for the reason given in date-presets.ts: the stored
 * `date` is a plain date in the ad account's timezone, and admitting the server's local timezone
 * would move a client's month boundary depending on where the process runs.
 */
export type TimeIncrement = "all_days" | "1" | "7" | "28" | "monthly";

export interface TimeIncrementOption {
  key: TimeIncrement;
  label: string;
  /** What one row means, for the picker. */
  hint: string;
}

export const TIME_INCREMENTS: TimeIncrementOption[] = [
  { key: "all_days", label: "Whole range", hint: "one row per breakdown value" },
  { key: "1", label: "Daily", hint: "one row per day" },
  { key: "7", label: "Weekly", hint: "7-day buckets from the range start" },
  { key: "28", label: "4-weekly", hint: "28-day buckets from the range start" },
  { key: "monthly", label: "Monthly", hint: "calendar months, clipped to the range" },
];

/** Meta's own default: omitting `time_increment` aggregates the whole `time_range` into one row. */
export const DEFAULT_TIME_INCREMENT: TimeIncrement = "all_days";

export function isTimeIncrement(v: unknown): v is TimeIncrement {
  return typeof v === "string" && TIME_INCREMENTS.some((t) => t.key === v);
}

/**
 * Accepts Meta's spelling, the legacy `splitByDay` boolean, and free text from the chat tool.
 * Unknown input falls back to the default rather than inventing a granularity.
 */
export function resolveTimeIncrement(v: unknown, legacySplitByDay?: unknown): TimeIncrement {
  if (isTimeIncrement(v)) return v;
  if (typeof v === "boolean") return v ? "1" : "all_days";
  if (typeof v === "number" && isTimeIncrement(String(v))) return String(v) as TimeIncrement;
  const s = String(v ?? "")
    .toLowerCase()
    .trim();
  if (s === "day" || s === "daily" || s === "by day") return "1";
  if (s === "week" || s === "weekly") return "7";
  if (s === "month" || s === "monthly") return "monthly";
  if (s === "total" || s === "none" || s === "all" || s === "all days") return "all_days";
  if (legacySplitByDay !== undefined) return legacySplitByDay ? "1" : "all_days";
  return DEFAULT_TIME_INCREMENT;
}

/** An inclusive bucket of days, in the same YYYY-MM-DD form as the stored rows. */
export interface DayBucket {
  start: string;
  end: string;
}

const DAY_MS = 86_400_000;
const at = (isoDate: string): number => Date.parse(`${isoDate}T00:00:00Z`);
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The bucket `date` falls into, for a report over [since, until]. Clipping is applied at both ends
 * so a bucket never claims days the report did not ask for — that clipping is what makes a bucket a
 * function of the whole window, and therefore what makes de-duplicated metrics unrecoverable.
 */
export function bucketFor(
  date: string,
  since: string,
  until: string,
  increment: TimeIncrement,
): DayBucket {
  if (increment === "all_days") return { start: since, end: until };

  if (increment === "monthly") {
    const year = Number(date.slice(0, 4));
    // 1-based month, so `Date.UTC(year, month, 0)` is day zero of the NEXT month — the last day of
    // this one, without a 28/29/30/31 table.
    const month = Number(date.slice(5, 7));
    const first = `${date.slice(0, 7)}-01`;
    const last = ymd(Date.UTC(year, month, 0));
    return { start: first < since ? since : first, end: last > until ? until : last };
  }

  const width = Number(increment);
  const index = Math.floor((at(date) - at(since)) / DAY_MS / width);
  const start = ymd(at(since) + index * width * DAY_MS);
  const end = ymd(at(start) + (width - 1) * DAY_MS);
  return { start, end: end > until ? until : end };
}

/** One bucket as a row label: a bare date when it is a single day, a range when it is wider. */
export function bucketLabel(b: DayBucket): string {
  return b.start === b.end ? b.start : `${b.start} → ${b.end}`;
}
