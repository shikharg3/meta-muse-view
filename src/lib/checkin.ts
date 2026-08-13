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
