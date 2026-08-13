import { type PromptState } from "@/lib/checkin";
import { forceReplyText, parseCallback } from "@/lib/checkin-render";
import type { TelegramUpdate } from "./client";

/**
 * A prompt row as the dispatcher needs it. Dispatch-only: it is a projection of `checkin_prompts`
 * for routing decisions, not a mirror of the table — the comment/escalation columns are absent
 * because no decision here reads them.
 */
export interface PromptRow {
  id: number;
  promptDate: string;
  chatId: string | null;
  campaignTitle: string;
  status: string;
  question: string;
  listMessageId: string | null;
  state: PromptState;
}

/**
 * Everything the dispatcher needs from the outside world. Injected so the decision logic is testable
 * with fakes — no database and no Telegram in the tests.
 */
export interface UpdateDeps {
  /**
   * Mirrors `TelegramClient.sendMessage`'s result, `error` included: a force-reply that never
   * arrived leaves the prompt open to escalate at 09:00, and the reason has to reach
   * `checkin_prompts.note` or a revoked token looks identical to a quiet day.
   */
  sendMessage(
    chatId: string,
    text: string,
    forceReply?: boolean,
  ): Promise<{ ok: boolean; messageId?: number; error?: string }>;
  answerCallback(id: string, text?: string): Promise<void>;
  recordChat(chatId: string, username?: string, firstName?: string): Promise<void>;
  isBoundChat(chatId: string): Promise<boolean>;
  loadPrompt(id: number): Promise<PromptRow | null>;
  /**
   * Look up by the id of the `force_reply` message the buyer replied to. Matches on the message id
   * ALONE and does NOT filter by state, which is what lets a late answer to an `escalated` prompt
   * land. The dispatcher deliberately does not re-gate it either — see rule (1).
   */
  loadPromptByReply(chatId: string, replyMessageId: number): Promise<PromptRow | null>;
  /**
   * Every prompt for the chat still in an open state (`pending` or `awaiting_reply`). The dispatcher
   * narrows this to `awaiting_reply` itself, so this dep must not pre-filter to that.
   */
  openPromptsForChat(chatId: string): Promise<PromptRow[]>;
  markNoChanges(id: number): Promise<void>;
  markAwaitingReply(id: number, replyMessageId: number): Promise<void>;
  /**
   * Record why a prompt could not be armed, into `checkin_prompts.note`. The prompt stays open and
   * escalates at 09:00 regardless; this is the only place the reason survives.
   */
  noteFailure(id: number, note: string): Promise<void>;
  saveAnswer(id: number, text: string): Promise<void>;
  rerenderList(chatId: string, listMessageId: string): Promise<void>;
}

/** States a prompt can still be answered from. Anything else has already been closed out. */
const OPEN: PromptState[] = ["pending", "awaiting_reply"];

/** A prompt only carries a list message id once its daily list actually went out. */
async function rerender(deps: UpdateDeps, chatId: string, prompt: PromptRow): Promise<void> {
  if (prompt.listMessageId) await deps.rerenderList(chatId, prompt.listMessageId);
}

/**
 * The slash command a message carries, or null if it is prose.
 *
 * Telegram sends `/start`, `/start@botname`, `/start payload` and `/start@botname payload`, so the
 * command is the first whitespace-delimited token with any `@botname` suffix removed. Matching this
 * exactly rather than with `startsWith("/start")` is what keeps `/startle` from being treated as a
 * greeting — and gives the answer path one predicate for "this is a command, not an update".
 */
function commandOf(text: string): string | null {
  if (!text.startsWith("/")) return null;
  return text.split(/\s+/)[0].split("@")[0];
}

/**
 * Route one Telegram update.
 *
 * The ordering rule that matters: an answer is attributed by `reply_to_message` first, and only then
 * by "exactly one prompt is awaiting a reply". If neither is unambiguous the bot ASKS. A guess here
 * would land one client's update on another client's Notion card, and nothing downstream could ever
 * detect it — so there is deliberately no "most recent prompt" fallback.
 *
 * The deps are database calls and may throw. The poll loop catches per update and advances its
 * offset regardless, so a throwing dep DROPS that update permanently — Telegram never redelivers
 * it. That is deliberate: retrying a poison update forever would wedge the loop, and the 09:00
 * escalation is the backstop that surfaces a check-in this lost.
 */
export async function handleUpdate(update: TelegramUpdate, deps: UpdateDeps): Promise<void> {
  if (update.callback_query) {
    const cb = update.callback_query;
    // Every exit from this branch answers the callback query. Until it is answered Telegram spins a
    // loading indicator on the button for ~30s, so the buyer cannot tell a drop from a slow write.
    const parsed = cb.data ? parseCallback(cb.data) : null;
    if (!parsed) {
      await deps.answerCallback(cb.id, "Unrecognised action");
      return;
    }
    const prompt = await deps.loadPrompt(parsed.promptId);
    if (!prompt || !OPEN.includes(prompt.state)) {
      await deps.answerCallback(cb.id, "That check-in is closed");
      return;
    }
    // Buttons live in the chat the list was sent to; the tapper is the fallback for a prompt whose
    // chat was never recorded.
    const chatId = prompt.chatId ?? String(cb.from.id);

    if (parsed.action === "no_changes") {
      // The operator's chosen filter: this button is the only way to say "nothing happened", and it
      // writes NOTHING to Notion. Any typed reply is an update. The ack follows the write so it can
      // never claim "Logged" for a write that failed.
      await deps.markNoChanges(prompt.id);
      await deps.answerCallback(cb.id, "Logged — no changes");
    } else {
      const sent = await deps.sendMessage(
        chatId,
        forceReplyText({
          title: prompt.campaignTitle,
          status: prompt.status,
          question: prompt.question,
        }),
        true,
      );
      // Only a delivered force-reply message may mark the prompt as awaiting: otherwise the buyer's
      // next unrelated message would be attributed to this campaign by the single-awaiting rule.
      if (sent.ok && sent.messageId != null) {
        await deps.markAwaitingReply(prompt.id, sent.messageId);
        await deps.answerCallback(cb.id);
      } else {
        // The prompt stays open and escalates at 09:00. Record WHY: a revoked token, or a buyer who
        // blocked the bot, otherwise looks exactly like a quiet day with nothing to report.
        await deps.noteFailure(
          prompt.id,
          sent.ok
            ? "force reply sent but Telegram returned no message_id"
            : `force reply failed: ${sent.error ?? "unknown error"}`,
        );
        // Truthful either way: nothing was armed, so the reply box the buyer may see leads nowhere.
        await deps.answerCallback(cb.id, "Could not open the reply box");
      }
    }
    // Last, because re-rendering is another round trip and the button should stop spinning first.
    await rerender(deps, chatId, prompt);
    return;
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  // Deliberately message-only: `recordChat` exists so an admin can find an unbound chat to bind, and
  // a callback can only come from a chat that was already bound and listed. The `lastSeenAt`
  // asymmetry that follows is intentional, not an oversight.
  await deps.recordChat(chatId, msg.chat.username, msg.chat.first_name);

  const text = (msg.text ?? "").trim();
  if (!(await deps.isBoundChat(chatId))) {
    // Unbound chats get NO campaign data — only their own id, so an admin can bind them in Settings.
    // Nothing below this branch reads a prompt, which is what makes the leak impossible.
    if (commandOf(text) === "/start") {
      await deps.sendMessage(
        chatId,
        `👋 MetaConsole check-in bot.\nYour chat id is ${chatId} — send it to your admin to be bound as a media buyer.`,
      );
    }
    return;
  }

  // Stickers, photos and whitespace carry no answer, and an empty Notion comment is worse than none.
  // No slash command is ever an answer either: Telegram offers a START button whenever a chat is
  // cleared, and `/start` reaching rule (2) would write the literal text "/start" onto a client's
  // Notion card. Silence is deliberate — the daily list is the buyer's entry point, not a command.
  if (!text || commandOf(text)) return;

  const answer = async (prompt: PromptRow) => {
    await deps.saveAnswer(prompt.id, text);
    await rerender(deps, chatId, prompt);
  };

  // (1) The reply id is conclusive: it names the exact force-reply message the bot sent. Deliberately
  // NOT gated by OPEN, unlike the callback path above: the 09:00 escalation is a nag, not a close, so
  // a buyer answering yesterday's prompt at 09:05 must still land. Revising an already-flushed answer
  // is Task 11's problem — `saveAnswer` clears `notionCommentId` when the text actually changes.
  const replyTo = msg.reply_to_message?.message_id;
  const target = replyTo != null ? await deps.loadPromptByReply(chatId, replyTo) : null;
  if (target) return answer(target);

  // (2) A prompt is only a candidate once the buyer tapped Update on it; a `pending` prompt has no
  // reply box in the chat, so a bare message cannot be an answer to it.
  const open = (await deps.openPromptsForChat(chatId)).filter((p) => p.state === "awaiting_reply");
  if (open.length === 1) return answer(open[0]);

  // (3) More than one candidate: ask, and write nothing. Plain text, not a force reply — the next
  // typed message would be exactly as ambiguous. It must point at the reply box and NOT at a button:
  // every candidate here is `awaiting_reply`, and `renderList` emits ✍️ Update only for `pending`,
  // so "tap Update" would send the buyer hunting for a button that is not on their screen.
  if (open.length > 1) {
    await deps.sendMessage(
      chatId,
      `Which campaign is that for? Reply directly to the ✍️ Update message for that campaign.\nOpen: ${open
        .map((p) => p.campaignTitle)
        .join(", ")}`,
    );
    return;
  }
  await deps.sendMessage(
    chatId,
    "Nothing open right now — today's check-in is either done or hasn't been sent yet.",
  );
}
