import { addDays } from "@/lib/range";

/** Beyond this the projection is meaningless (a few cents/day against a large budget). */
export const MAX_PROJECTION_DAYS = 730; // ~2 years

/** Trailing window the burn rate is averaged over (complete days only). Shared so the dashboard's
 *  forecast and the one written back to Notion can never disagree. */
export const PACE_DAYS = 14;

/** Fewer complete days than this and an average is noise, not a pace. */
export const MIN_PACE_DAYS = 3;

/**
 * The window a burn rate should be measured over: the trailing `PACE_DAYS`, but never reaching back
 * before the engagement started. Ad accounts are recycled between engagements, so an unclamped window
 * would average in the PREVIOUS client's spend and project a brand-new engagement as already burning.
 * Returns null when there are not yet `MIN_PACE_DAYS` complete days to average.
 */
export function paceWindow(input: {
  startDate: string | null;
  until: string;
}): { from: string; days: number } | null {
  const { startDate, until } = input;
  const trailing = addDays(until, -(PACE_DAYS - 1));
  const from = startDate && startDate > trailing ? startDate : trailing;
  const days = Math.round((Date.parse(until) - Date.parse(from)) / 86_400_000) + 1;
  return days >= MIN_PACE_DAYS ? { from, days } : null;
}

export interface BudgetForecast {
  /** Forecast burn-out date (YYYY-MM-DD); null when no forecast is possible. */
  projectedEndDate: string | null;
  /** The $/day the forecast was built from (echoed back for display). */
  dailyPace: number;
  /** Whole days of runway left at `dailyPace`; null when the budget isn't tracked or pace is 0.
   *  Still populated (uncapped) when the projection itself was rejected for being too far out. */
  daysRemaining: number | null;
  /** Short human reason there is no `projectedEndDate`; null when a date was produced. */
  reason: string | null;
}

/**
 * Project when an engagement budget runs out from its recent burn rate. Pure: `today` and
 * `dailyPace` are supplied by the caller, all date math is UTC.
 */
export function forecastBudgetEnd(input: {
  total: number | null;
  spent: number;
  dailyPace: number;
  today: string;
}): BudgetForecast {
  const { total, spent, dailyPace, today } = input;
  if (total == null)
    return { projectedEndDate: null, dailyPace, daysRemaining: null, reason: "no budget set" };

  const remaining = total - spent;
  if (remaining <= 0)
    return { projectedEndDate: today, dailyPace, daysRemaining: 0, reason: "budget exhausted" };

  if (dailyPace <= 0)
    return { projectedEndDate: null, dailyPace, daysRemaining: null, reason: "no recent spend" };

  const daysRemaining = Math.ceil(remaining / dailyPace);
  if (daysRemaining > MAX_PROJECTION_DAYS)
    return { projectedEndDate: null, dailyPace, daysRemaining, reason: "pace too low to project" };

  return {
    projectedEndDate: addDays(today, daysRemaining),
    dailyPace,
    daysRemaining,
    reason: null,
  };
}
