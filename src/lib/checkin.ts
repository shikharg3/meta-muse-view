/**
 * Pure decision core of the daily media-buyer check-in: which campaigns are asked about, who is
 * asked, and what they are asked.
 *
 * No database, no network, no clock — the caller supplies rows, buyers and a time. Berlin wall-clock
 * helpers live in `berlin-time.ts`; Telegram/Notion rendering lives in `checkin-render.ts`. The only
 * import here is type-only, so this module has no runtime dependencies at all.
 */
import type { MachineStatus } from "./delivery-status";

/** The prompt fires at this Europe/Berlin hour. */
export const CHECKIN_HOUR = 17;
/** Unanswered prompts are escalated at this Europe/Berlin hour the NEXT day. */
export const ESCALATION_HOUR = 9;

/**
 * One question per status: the five machine-owned delivery states from `delivery-status.ts`, plus
 * the human-owned `On Boarding` on the operator's instruction.
 *
 * `as const satisfies Record<MachineStatus | "On Boarding", string>` earns three things a
 * `Record<string, string>` annotation cannot: the compiler rejects a missing machine status, the
 * catalogue cannot be mutated by a consumer (this is imported into a long-lived sync worker), and
 * `CheckinStatus` below becomes a usable union instead of bare `string`.
 *
 * A status absent from this map is NOT prompted (see `questionFor`) — a default question would ask a
 * finished engagement for a daily update.
 */
export const CHECKIN_QUESTIONS = {
  Live: "Any changes today — budget, creatives, targeting?",
  Paused: "Why is it paused, and when does it resume?",
  "Ad Account Disabled": "What's the recovery plan — is a replacement account lined up?",
  "Ad Account Blocked": "Funding/top-up status — when does delivery resume?",
  "All ads rejected": "What's the fix — new creatives or an appeal?",
  "On Boarding": "What's still outstanding before launch?",
} as const satisfies Record<MachineStatus | "On Boarding", string>;

/** The statuses the check-in asks about. */
export type CheckinStatus = keyof typeof CHECKIN_QUESTIONS;

/** The lifecycle of one prompt; mirrored by `checkin_prompts.state` in the database. */
export type PromptState =
  | "pending"
  | "awaiting_reply"
  | "answered"
  | "no_changes"
  | "escalated"
  | "unroutable";

/** Narrows an untrusted board status to one the check-in asks about. */
export function isCheckinStatus(status: string | null | undefined): status is CheckinStatus {
  return status != null && Object.hasOwn(CHECKIN_QUESTIONS, status);
}

/** The question for a status, or null when the status is out of scope for the check-in. */
export function questionFor(status: string | null | undefined): string | null {
  return isCheckinStatus(status) ? CHECKIN_QUESTIONS[status] : null;
}
