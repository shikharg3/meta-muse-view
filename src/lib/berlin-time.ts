/**
 * Berlin wall-clock helpers.
 *
 * Deliberately NOT in `checkin.ts`: nothing here knows what a check-in is, and the next consumer
 * will look for these beside the other date helpers rather than inside a feature module.
 */

export interface LocalNow {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Local hour, 0-23. */
  hour: number;
}

/**
 * `hourCycle: "h23"` asks ICU for the 0-23 cycle explicitly.
 *
 * Do NOT swap it for `hour12: false`: ECMA-402 lets `hour12` override `hourCycle`, and an `h24`
 * cycle renders Berlin midnight as hour "24" (measured) with the date already rolled forward, which
 * would leave an `hour >= CHECKIN_HOUR` gate true all night.
 */
const BERLIN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Berlin wall-clock date and hour for an instant. "17:00 CET" means 17:00 local, so this follows
 * DST: 15:00 UTC in summer, 16:00 UTC in winter.
 *
 * Throws on a missing part rather than returning a silent `NaN` hour. This project does not enable
 * `noUncheckedIndexedAccess`, so a dropped field would otherwise yield `hour: NaN`, and
 * `NaN >= CHECKIN_HOUR` is false forever — a check-in that never fires and never complains.
 */
export function berlinNow(at: Date): LocalNow {
  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  let hour: string | undefined;
  for (const p of BERLIN.formatToParts(at)) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
    else if (p.type === "hour") hour = p.value;
  }
  if (!year || !month || !day || hour === undefined) {
    throw new Error("berlinNow: Intl returned no Berlin date parts");
  }
  return { date: `${year}-${month}-${day}`, hour: Number(hour) };
}

/**
 * "Thu 13 Aug" from a YYYY-MM-DD date, for the top of the buyer's daily Telegram message.
 *
 * Table lookup on UTC fields rather than a locale format: `en-GB` returns "Thu, 13 Aug" and would
 * need its comma stripped, which buys a dependency on ICU never reordering the fields. Same approach
 * as `shortDay` in `src/portal/mock.ts`.
 */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${day} ${MONTHS[d.getUTCMonth()]}`;
}
