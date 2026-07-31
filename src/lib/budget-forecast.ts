import { addDays } from "@/lib/range";

/** Beyond this the projection is meaningless (a few cents/day against a large budget). */
export const MAX_PROJECTION_DAYS = 730; // ~2 years

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
