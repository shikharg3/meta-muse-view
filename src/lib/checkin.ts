/**
 * Pure core of the daily media-buyer check-in.
 *
 * Everything here is a pure function: the caller supplies rows, buyers and a clock, and gets back
 * plans and strings. No database, no network, no `Date.now()`. That is what makes the whole decision
 * surface — who is asked, what they are asked, how the message and the Notion comment read — testable
 * without infrastructure.
 */

/** The prompt fires at this Europe/Berlin hour. */
export const CHECKIN_HOUR = 17;
/** Unanswered prompts are escalated at this Europe/Berlin hour the NEXT day. */
export const ESCALATION_HOUR = 9;

/**
 * One question per status. Five are the machine-owned delivery states from `delivery-status.ts`; the
 * sixth, `On Boarding`, is human-owned and included on the operator's instruction.
 *
 * A status absent from this map is NOT prompted (see `questionFor`). That is deliberate: a default
 * question would ask a finished engagement for a daily update.
 */
export const CHECKIN_QUESTIONS: Record<string, string> = {
  Live: "Any changes today — budget, creatives, targeting?",
  Paused: "Why is it paused, and when does it resume?",
  "Ad Account Disabled": "What's the recovery plan — is a replacement account lined up?",
  "Ad Account Blocked": "Funding/top-up status — when does delivery resume?",
  "All ads rejected": "What's the fix — new creatives or an appeal?",
  "On Boarding": "What's still outstanding before launch?",
};

export const CHECKIN_STATUSES: readonly string[] = Object.keys(CHECKIN_QUESTIONS);

/** The question for a status, or null when the status is out of scope for the check-in. */
export function questionFor(status: string | null | undefined): string | null {
  if (!status) return null;
  // Own-property check, not `?? null`: `Record<string, string>` index access walks the prototype
  // chain, so "toString" or "constructor" would hand back an inherited function and break the
  // declared `string | null` return type.
  return Object.hasOwn(CHECKIN_QUESTIONS, status) ? CHECKIN_QUESTIONS[status] : null;
}

export interface LocalNow {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Local hour, 0-23. */
  hour: number;
  minute: number;
}

const BERLIN_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * The Berlin wall-clock date and time for an instant. "17:00 CET" means 17:00 local, so this follows
 * DST: 15:00 UTC in summer, 16:00 UTC in winter.
 *
 * `hour` is taken modulo 24 because some ICU builds render local midnight as "24" under
 * `hour12: false`, which would leave an `hour >= CHECKIN_HOUR` gate true all night.
 */
export function berlinNow(at: Date): LocalNow {
  const parts: Record<string, string> = {};
  for (const p of BERLIN_PARTS.formatToParts(at)) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** The calendar day before `date` (YYYY-MM-DD in, YYYY-MM-DD out). */
export function previousDate(date: string): string {
  const t = Date.parse(`${date}T12:00:00Z`) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** "Thu 13 Aug" — fixed to UTC noon so the label never shifts with the runner's timezone. */
export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "2-digit",
    month: "short",
  })
    .format(new Date(`${date}T12:00:00Z`))
    .replace(",", "");
}
