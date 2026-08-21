/**
 * Presentation for the daily check-in: the buyer's Telegram list, the force-reply prompt, the
 * callback encoding, and the Notion comment body.
 *
 * Pure, like `checkin.ts`, but a separate module because it renders for two external systems rather
 * than deciding anything. `PromptState` is imported rather than redeclared — the prompt lifecycle is
 * core vocabulary and the database column mirrors it.
 */
import type { PromptState } from "./checkin";

/** Notion rejects a `rich_text` item over 2000 characters. */
export const NOTION_TEXT_LIMIT = 2000;

export type CallbackAction = "no_changes" | "update";

const ACTION_PREFIX: Record<CallbackAction, string> = { no_changes: "nc", update: "up" };

/** Telegram caps `callback_data` at 64 bytes, so prompts are addressed by integer id. */
export function callbackData(action: CallbackAction, promptId: number): string {
  return `${ACTION_PREFIX[action]}:${promptId}`;
}

export function parseCallback(data: string): { action: CallbackAction; promptId: number } | null {
  const parts = data.split(":");
  if (parts.length !== 2) return null;
  const [prefix, raw] = parts;
  const action = (Object.keys(ACTION_PREFIX) as CallbackAction[]).find(
    (a) => ACTION_PREFIX[a] === prefix,
  );
  if (!action) return null;
  if (!/^\d+$/.test(raw)) return null;
  return { action, promptId: Number(raw) };
}

export interface ListItem {
  promptId: number;
  title: string;
  status: string;
  question: string;
  state: PromptState;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface RenderedList {
  text: string;
  keyboard: InlineButton[][];
}

const STATE_MARKER: Partial<Record<PromptState, string>> = {
  no_changes: "✅",
  answered: "✍️",
  escalated: "⏭️",
};

/**
 * Which of the three daily notifications a list is. Only the header differs — numbering, markers and
 * buttons are one code path, so a reminder can never disagree with the list it is reminding about.
 */
export type ListStage = "first" | "reminder" | "final";

const STAGE_HEADER: Record<ListStage, (dateLabel: string) => string> = {
  first: (d) => `🕔 Daily check-in — ${d}`,
  reminder: (d) => `⏰ Reminder — still open — ${d}`,
  // Says outright that nothing further is coming, because that is the whole point of the third send.
  final: (d) => `🚨 FINAL notice — last reminder for ${d}`,
};

/**
 * The buyer's daily list, re-rendered after every state change so a tap visibly registers.
 *
 * Numbers are stable across re-renders and button labels carry the number rather than the campaign
 * title — titles on this board reach 40+ characters (`fortunegalaxy.io   Palmluck (26 May 2026)`),
 * which no button label can show.
 *
 * `stage` defaults to `first`, so `rerenderList` — which edits a message in place and has no business
 * knowing which send created it — keeps the header it already had.
 */
export function renderList(
  dateLabel: string,
  items: ListItem[],
  stage: ListStage = "first",
): RenderedList {
  const lines = [STAGE_HEADER[stage](dateLabel), ""];
  const keyboard: InlineButton[][] = [];

  items.forEach((item, i) => {
    const n = i + 1;
    const marker = STATE_MARKER[item.state];
    lines.push(`${n}. ${marker ? `${marker} ` : ""}${item.title} — ${item.status}`);
    if (!marker) lines.push(`   ${item.question}`);

    const row: InlineButton[] = [];
    if (item.state === "pending" || item.state === "awaiting_reply") {
      row.push({
        text: `✅ No changes · ${n}`,
        callback_data: callbackData("no_changes", item.promptId),
      });
    }
    if (item.state === "pending") {
      row.push({ text: `✍️ Update · ${n}`, callback_data: callbackData("update", item.promptId) });
    }
    if (row.length) keyboard.push(row);
  });

  return { text: lines.join("\n"), keyboard };
}

/** The `force_reply` message. Its `message_id` is what binds a typed answer to a campaign. */
export function forceReplyText(input: { title: string; status: string; question: string }): string {
  return `✍️ Update for ${input.title} (${input.status})\n${input.question}\n↩️ Reply to this message.`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Thu 13 Aug" from a YYYY-MM-DD date, for the top of the buyer's daily Telegram message.
 *
 * Table lookup on UTC fields rather than a locale format: `en-GB` returns "Thu, 13 Aug" and would
 * need its comma stripped, buying a dependency on ICU never reordering the fields. (`shortDay` in
 * `src/portal/mock.ts` avoids `Date` entirely by splitting the string; this needs the weekday, which
 * only a `Date` can give.)
 *
 * Throws rather than rendering `"undefined NaN undefined"`: `DAYS[NaN]` types as `string` while
 * evaluating to `undefined`, because this project does not enable `noUncheckedIndexedAccess`.
 */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`dayLabel: not a YYYY-MM-DD date: ${date}`);
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${day} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * The Notion comment, split into `rich_text`-sized chunks.
 *
 * The buyer's name is in the body because the comment's AUTHOR is the integration, not the human —
 * without this the board would show a wall of identical robot authorship.
 *
 * Splits, never truncates: losing text a buyer typed is the worst failure this module has. The cut
 * is nudged off a surrogate pair, because `slice` counts UTF-16 code units and buyers answering from
 * Telegram do type emoji — a naive cut ends one chunk on a lone high surrogate and opens the next
 * with its orphan, which Notion stores as an ill-formed `rich_text` item that renders as U+FFFD.
 */
export function commentBody(input: {
  date: string;
  buyerName: string;
  status: string;
  question: string;
  answer: string;
}): string[] {
  const full =
    `🤖 Daily check-in · ${input.date} · ${input.buyerName}\n` +
    `Status: ${input.status}\n` +
    `Q: ${input.question}\n` +
    `A: ${input.answer}`;
  const chunks: string[] = [];
  for (let i = 0; i < full.length; ) {
    let end = Math.min(i + NOTION_TEXT_LIMIT, full.length);
    const last = full.charCodeAt(end - 1);
    if (end < full.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(full.slice(i, end));
    i = end;
  }
  return chunks;
}

/** The 09:00 escalation posted to the shared alert channel. */
export function escalationText(
  date: string,
  groups: { buyerName: string; titles: string[]; unroutable: boolean }[],
): string {
  const total = groups.reduce((n, g) => n + g.titles.length, 0);
  const lines = [`⚠️ Check-in ${date} — ${total} campaign${total === 1 ? "" : "s"} unanswered`];
  for (const g of groups) {
    const who = g.unroutable ? `${g.buyerName} (no Telegram binding)` : g.buyerName;
    lines.push(`${who}: ${g.titles.join(", ")}`);
  }
  return lines.join("\n");
}
