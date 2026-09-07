/**
 * Pure decision core of the daily media-buyer check-in: which campaigns are asked about, who is
 * asked, and what they are asked.
 *
 * No database, no network, no clock — the caller supplies rows, buyers and a time. Berlin wall-clock
 * helpers live in `berlin-time.ts`; Telegram/Notion rendering lives in `checkin-render.ts`. The only
 * import here is type-only, so this module has no runtime dependencies at all.
 */
import type { LocalMark } from "./berlin-time";
import type { MachineStatus } from "./delivery-status";

/**
 * The three notification marks, Europe/Berlin wall clock. "CET" means what the buyer's clock says, so
 * these follow DST rather than pinning a UTC offset — see `berlin-time.ts`.
 *
 * 1. `FIRST_PROMPT_AT` — the day's prompt, every in-scope campaign.
 * 2. `REMINDER_AT` — same day, only what is still unanswered.
 * 3. `FINAL_NOTICE_AT` — the NEXT prompt day, marked final. That mark is the BUYER's DM alone; the
 *    alert-channel post for the same day follows `ESCALATION_DELAY_MS` later.
 *
 * Mon–Fri only (`isPromptDay`), which is what makes Friday's final notice land on Monday morning
 * instead of at the weekend.
 */
export const FIRST_PROMPT_AT: LocalMark = { hour: 13, minute: 30 };
export const REMINDER_AT: LocalMark = { hour: 17, minute: 30 };
export const FINAL_NOTICE_AT: LocalMark = { hour: 8, minute: 0 };

/**
 * How long the alert-channel escalation waits after the buyer's final-notice DM — one hour, so 09:00
 * for the 08:00 mark.
 *
 * It used to be zero: a single pass DM'd "FINAL notice" and named the buyer to the channel in the
 * same breath, so the last reminder was decoration — there was no interval in which acting on it
 * changed anything. The hour IS that interval. The prompts stay open and their buttons stay live
 * through it, and only what is still unanswered when it expires reaches the channel.
 *
 * Measured from `checkin_runs.final_noticed_at`, never from the mark: after an outage the DM can go
 * out at 11:20, and a second wall-clock mark would then post to the channel in the very same loop
 * iteration — reinstating the bug this delay exists to fix.
 */
export const ESCALATION_DELAY_MS = 60 * 60_000;

/**
 * Whether the check-in prompts at all on a given Europe/Berlin calendar date.
 *
 * Monday–Friday only, on the operator's instruction: media buyers are not asked for updates at the
 * weekend. Read on the LOCAL date string, not on a `Date`, so the answer cannot drift with the
 * process timezone — `getUTCDay` on a midnight-UTC parse of `YYYY-MM-DD` is exactly the weekday that
 * date names, whatever the host is set to.
 *
 * Note this gates SENDING, never receiving: a buyer who answers Friday's prompt on Saturday is still
 * accepted, and the comment still reaches Notion, because the poll loop and the comment flush run
 * every day.
 */
export function isPromptDay(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

/**
 * One question per status: the five machine-owned delivery states from `delivery-status.ts`, plus
 * the human-owned `On Boarding` on the operator's instruction.
 *
 * `as const satisfies Record<MachineStatus | "On Boarding", string>` earns three things a
 * `Record<string, string>` annotation cannot: the compiler rejects a missing machine status, the
 * compiler rejects mutating it (`as const` is compile-time only; nothing is frozen at runtime), and
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

/** One board row as the planner needs it: its own status and its Notion `Owners` person ids. */
export interface CheckinBoardRow {
  pageId: string;
  title: string;
  status: string | null;
  ownerIds: string[];
}

/** A media buyer. Membership in this list is what makes someone a media buyer — it is DB data. */
export interface CheckinBuyer {
  personId: string;
  displayName: string;
  /** Null until an admin binds their Telegram chat. */
  chatId: string | null;
  active: boolean;
}

export interface PlannedPrompt {
  notionPageId: string;
  campaignTitle: string;
  /** Narrowed by `isCheckinStatus`, so a prompt can only ever carry an in-scope status. */
  status: CheckinStatus;
  buyerPersonId: string;
  chatId: string | null;
  question: string;
}

/**
 * One prompt per (row, media-buyer owner) for rows whose status is in scope.
 *
 * Prompts are de-duplicated per (page, buyer), NOT per page: the same board page can appear in more
 * than one client snapshot, and a duplicate would write two comments for one answer. Keying on the
 * page alone would instead collapse a multi-owner row into a single prompt and silently drop a
 * buyer's question. This mirrors the `checkin_prompts` unique index
 * `(prompt_date, notion_page_id, buyer_person_id)`, minus the date.
 *
 * An unbound buyer is still planned (with `chatId: null`) so the escalation can name the missing
 * binding instead of the row disappearing silently.
 */
export function planPrompts(rows: CheckinBoardRow[], buyers: CheckinBuyer[]): PlannedPrompt[] {
  const byPerson = new Map(buyers.filter((b) => b.active).map((b) => [b.personId, b]));
  const seen = new Set<string>();
  const out: PlannedPrompt[] = [];

  // Collation pinned to "en": bare `localeCompare` follows the ambient LANG/ICU build, so the
  // droplet and a dev machine could order the same board differently.
  const ordered = [...rows].sort((a, b) => a.title.localeCompare(b.title, "en"));
  for (const row of ordered) {
    // Narrow rather than lookup-then-null-check: this is what lets `PlannedPrompt.status` be the
    // `CheckinStatus` union instead of bare `string`, all the way through to the database write.
    if (!isCheckinStatus(row.status)) continue;
    const question = CHECKIN_QUESTIONS[row.status];
    for (const ownerId of row.ownerIds) {
      const buyer = byPerson.get(ownerId);
      if (!buyer) continue;
      const key = `${row.pageId}:${ownerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        notionPageId: row.pageId,
        campaignTitle: row.title,
        status: row.status,
        buyerPersonId: buyer.personId,
        chatId: buyer.chatId,
        question,
      });
    }
  }
  return out;
}
