/**
 * Named report ranges, mirroring Meta's `date_preset` vocabulary.
 *
 * Resolved locally, because reports read our own synced daily rows rather than calling Meta — so a
 * preset is date arithmetic and never an API concern. That is also why there are twenty of these
 * where the builder previously offered four trailing-day counts.
 *
 * Relative windows END YESTERDAY. Today is partial, and Meta keeps restating the last ~28 days, so a
 * "last 7 days" that included today would show a figure that changes under the client's feet.
 *
 * All arithmetic is UTC on plain YYYY-MM-DD strings. The stored `date` column is a plain date in the
 * ad account's timezone; introducing the server's local timezone here would shift a client's month
 * boundary by a day depending on where the process runs.
 */
export interface DatePreset {
  key: string;
  label: string;
  group: "relative" | "calendar" | "all";
}

export const DATE_PRESETS: DatePreset[] = [
  { key: "yesterday", label: "Yesterday", group: "relative" },
  { key: "last_3d", label: "Last 3 days", group: "relative" },
  { key: "last_7d", label: "Last 7 days", group: "relative" },
  { key: "last_14d", label: "Last 14 days", group: "relative" },
  { key: "last_28d", label: "Last 28 days", group: "relative" },
  { key: "last_30d", label: "Last 30 days", group: "relative" },
  { key: "last_90d", label: "Last 90 days", group: "relative" },
  { key: "today", label: "Today", group: "calendar" },
  { key: "this_week_mon_today", label: "This week (Mon–today)", group: "calendar" },
  { key: "this_week_sun_today", label: "This week (Sun–today)", group: "calendar" },
  { key: "last_week_mon_sun", label: "Last week (Mon–Sun)", group: "calendar" },
  { key: "last_week_sun_sat", label: "Last week (Sun–Sat)", group: "calendar" },
  { key: "this_month", label: "This month", group: "calendar" },
  { key: "last_month", label: "Last month", group: "calendar" },
  { key: "this_quarter", label: "This quarter", group: "calendar" },
  { key: "last_quarter", label: "Last quarter", group: "calendar" },
  { key: "this_year", label: "This year", group: "calendar" },
  { key: "last_year", label: "Last year", group: "calendar" },
  // No `data_maximum`: it is in Meta's enum but carries no description in any current Meta doc, so
  // its semantics cannot be matched. `maximum` covers the 37-month ceiling, which is what we hold.
  // No `month_to_date` either: it would resolve identically to `this_month`, and two keys for one
  // behaviour is a trap for stored templates.
  { key: "maximum", label: "All time", group: "all" },
];

/** ≈37 months: Meta's insights retention ceiling, and the sync's backfill target. */
const MAXIMUM_DAYS = 1125;

const DAY_MS = 86_400_000;

const utc = (isoDate: string): Date => new Date(`${isoDate}T00:00:00Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const shift = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS);

/** First day of a month. Month may be out of range; Date.UTC normalises across years. */
const monthStart = (year: number, month: number): string => iso(new Date(Date.UTC(year, month, 1)));
/** Last day of a month — day 0 of the next month. Handles 28/29/30/31 without a table. */
const monthEnd = (year: number, month: number): string =>
  iso(new Date(Date.UTC(year, month + 1, 0)));

/**
 * Resolve a preset key against a reference date (injected rather than read from the clock, so the
 * boundaries are testable). Returns null for an unknown key — never a plausible-looking wrong range.
 */
export function resolvePreset(key: string, today: string): { since: string; until: string } | null {
  const t = utc(today);
  if (Number.isNaN(t.getTime())) return null;

  const year = t.getUTCFullYear();
  const month = t.getUTCMonth();
  const quarterFirstMonth = Math.floor(month / 3) * 3;
  const yesterday = iso(shift(t, -1));

  // getUTCDay() is 0 on Sunday, so a Monday-start week must treat Sunday as the seventh day or a
  // Sunday lands in the previous week.
  const dow = t.getUTCDay();
  const sinceMonday = dow === 0 ? 6 : dow - 1;

  /** Trailing window of `n` days ending yesterday. */
  const trailing = (n: number) => ({ since: iso(shift(t, -n)), until: yesterday });

  switch (key) {
    case "today":
      return { since: today, until: today };
    case "yesterday":
      return { since: yesterday, until: yesterday };
    case "last_3d":
      return trailing(3);
    case "last_7d":
      return trailing(7);
    case "last_14d":
      return trailing(14);
    case "last_28d":
      return trailing(28);
    case "last_30d":
      return trailing(30);
    case "last_90d":
      return trailing(90);
    case "this_week_mon_today":
      return { since: iso(shift(t, -sinceMonday)), until: today };
    case "this_week_sun_today":
      return { since: iso(shift(t, -dow)), until: today };
    case "last_week_mon_sun":
      return { since: iso(shift(t, -sinceMonday - 7)), until: iso(shift(t, -sinceMonday - 1)) };
    case "last_week_sun_sat":
      return { since: iso(shift(t, -dow - 7)), until: iso(shift(t, -dow - 1)) };
    case "this_month":
      return { since: monthStart(year, month), until: today };
    case "last_month":
      return { since: monthStart(year, month - 1), until: monthEnd(year, month - 1) };
    case "this_quarter":
      return { since: monthStart(year, quarterFirstMonth), until: today };
    case "last_quarter":
      return {
        since: monthStart(year, quarterFirstMonth - 3),
        until: monthEnd(year, quarterFirstMonth - 1),
      };
    case "this_year":
      return { since: monthStart(year, 0), until: today };
    case "last_year":
      return { since: monthStart(year - 1, 0), until: monthEnd(year - 1, 11) };
    case "maximum":
      return { since: iso(shift(t, -MAXIMUM_DAYS)), until: yesterday };
    default:
      return null;
  }
}
