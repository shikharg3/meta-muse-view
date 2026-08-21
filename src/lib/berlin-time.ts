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
  /** Local minute, 0-59. */
  minute: number;
}

/** A wall-clock mark a gate opens at. */
export interface LocalMark {
  hour: number;
  minute: number;
}

/**
 * Whether the local wall clock has reached `mark` today. Minute-of-day, so a half-past mark works.
 *
 * A named function rather than three inlined comparisons: the check-in's three gates must stay in
 * lockstep, and an hour-only regression at any one of them is silent — the notification simply fires
 * at the wrong time, or all day.
 */
export function atOrAfter(local: LocalNow, mark: LocalMark): boolean {
  return local.hour * 60 + local.minute >= mark.hour * 60 + mark.minute;
}

/**
 * Formatter options. The formatter itself is constructed per call inside `berlinNow`, NOT hoisted:
 * an import-time formatter cannot observe a `process.env.TZ` change, which makes the hostile-timezone
 * test inert (mutation-proven: the dropped-`timeZone` mutant survived 7 of 7). This runs about twice
 * a minute, so the construction cost is irrelevant, and `format.ts` already builds `Intl` per call.
 *
 * `hourCycle: "h23"` asks ICU for the 0-23 cycle explicitly. Do NOT swap it for `hour12: false`:
 * ECMA-402 lets `hour12` override `hourCycle`, and an `h24` cycle renders Berlin midnight as hour
 * "24" (measured) with the date already rolled forward, which would leave an `atOrAfter` gate true
 * all night.
 */
const BERLIN_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/**
 * Berlin wall-clock date, hour and minute for an instant. "13:30 CET" means 13:30 local, so this
 * follows DST: 11:30 UTC in summer, 12:30 UTC in winter.
 *
 * Throws on a missing part rather than returning a silent `NaN`. This project does not enable
 * `noUncheckedIndexedAccess`, so a dropped field would otherwise yield `hour: NaN`, and every
 * `atOrAfter` comparison against NaN is false forever — a check-in that never fires and never
 * complains. `hour === undefined` rather than `!hour`, because midnight is the string "00".
 */
export function berlinNow(at: Date): LocalNow {
  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  let hour: string | undefined;
  let minute: string | undefined;
  for (const p of new Intl.DateTimeFormat("en-CA", BERLIN_OPTIONS).formatToParts(at)) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
    else if (p.type === "hour") hour = p.value;
    else if (p.type === "minute") minute = p.value;
  }
  if (!year || !month || !day || hour === undefined || minute === undefined) {
    throw new Error("berlinNow: Intl returned no Berlin date parts");
  }
  return { date: `${year}-${month}-${day}`, hour: Number(hour), minute: Number(minute) };
}
