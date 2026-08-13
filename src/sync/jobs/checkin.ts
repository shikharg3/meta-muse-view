/**
 * Database and Telegram IO for the daily media-buyer check-in. Every decision this file acts on was
 * made in the pure core (`@/lib/checkin`, `@/lib/checkin-render`, `@/lib/berlin-time`) and is unit
 * tested there; what lives here is ordering, idempotency and retry.
 *
 * SINGLE INSTANCE BY ASSUMPTION. Every function here assumes exactly one worker process runs it.
 * There are no advisory locks and no `for update skip locked` anywhere in this codebase — the mutual
 * exclusion is "there is one `meta-sync` service". A second concurrent worker breaks, in order of how
 * much it costs: duplicate comments on client cards, two escalations to the shared channel, two daily
 * lists per buyer.
 *
 * What is written to survive it anyway, because these cost nothing: the `checkin_runs` insert claim
 * (17:00), the conditional `escalated_at` claim (09:00) and the compare-and-swap in
 * `flushPendingComments`. What is NOT: `sendDailyLists`, which reads and then writes
 * `list_message_id` with no claim between the two.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import { getNotionCredentials } from "@/lib/credentials";
import { boardRows } from "@/notion/parse";
import { NotionApiError, NotionClient } from "@/notion/client";
import { TelegramClient } from "@/telegram/client";
import { berlinNow } from "@/lib/berlin-time";
import {
  commentBody,
  dayLabel,
  escalationText,
  renderList,
  type ListItem,
} from "@/lib/checkin-render";
import {
  planPrompts,
  type CheckinBoardRow,
  type CheckinBuyer,
  type PromptState,
} from "@/lib/checkin";
import { addDays } from "@/lib/range";
import { handleUpdate, type PromptRow, type UpdateDeps } from "@/telegram/updates";
import { sendAlertChannelMessage } from "@/sync/alerts";
import { recordServiceHealth } from "@/sync/state";

/** A stored prompt row. Not `PromptRow`: that name belongs to the update handler's own view of one. */
type PromptRecord = typeof schema.checkinPrompts.$inferSelect;

/**
 * A 429 is honoured, but never for longer than this. The check-in loop is sequential, so sleeping
 * here also stops taps and replies being polled — and the retry is durable (`listMessageId` stays
 * null), so waiting out a long flood-wait buys nothing the next iteration does not.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/** How long `getUpdates` holds the connection open waiting for a tap or a reply. */
const POLL_TIMEOUT_SEC = 30;

/** A comment that has failed this many times stops being retried and is reported instead. */
const MAX_COMMENT_ATTEMPTS = 5;

/**
 * Comments written per flush pass. The cap exists so the pass cannot starve `pollTelegramOnce`,
 * which the worker loop runs AFTER it: a backlog of 300 answers would otherwise hold the loop for
 * hundreds of Notion round trips and stall every buyer's taps behind it. Telegram retains updates
 * for 24h, so nothing is lost by deferring — but responses stop landing, which buyers read as the
 * bot being broken.
 */
const FLUSH_LIMIT = 25;

/**
 * Stored in `notion_comment_id` when Notion accepted a comment but did not hand back an id. It is
 * NOT a Notion id and nothing may address it — its only job is to stop the retry, because the
 * comment is already on the client's card.
 */
const COMMENT_ID_UNKNOWN = "unknown";

/**
 * The states that still count as unanswered when the 09:00 escalation runs. `unroutable` belongs here
 * because an unbound buyer's campaign is unanswered for the worst reason; `answered` does not, even
 * when its comment has not reached Notion yet.
 */
const UNANSWERED_AT_ESCALATION: PromptState[] = ["pending", "awaiting_reply", "unroutable"];

/** Null when the bot token is unset — the whole feature is then inert, which Settings surfaces. */
export function telegram(): TelegramClient | null {
  const token = env().TELEGRAM_BOT_TOKEN;
  return token ? new TelegramClient(token) : null;
}

/** Media buyers as the planner needs them; `planPrompts` is what drops the inactive ones. */
async function loadBuyers(): Promise<CheckinBuyer[]> {
  const rows = await db.select().from(schema.mediaBuyers);
  return rows.map((r) => ({
    personId: r.notionPersonId,
    displayName: r.displayName,
    chatId: r.telegramChatId,
    active: r.active,
  }));
}

/**
 * Every live client's stored board rows, flattened. Deliberately NOT a Notion query: the 17:00 job
 * reads the snapshot the hourly sync already wrote, so a Notion outage at 17:00 still prompts and
 * the prompts never wait on Notion's latency. The same board page can appear under more than one
 * client snapshot; `planPrompts` is what de-duplicates it per (page, buyer).
 */
async function loadBoardRows(): Promise<CheckinBoardRow[]> {
  const rows = await db
    .select({ raw: schema.clients.raw })
    .from(schema.clients)
    .where(isNull(schema.clients.removedAt));
  return rows.flatMap((r) => boardRows(r.raw));
}

/**
 * Plan and send today's prompts. Returns null when the day was already planned or Telegram is
 * unconfigured.
 *
 * The `checkin_runs` claim comes FIRST and is the whole idempotency story: a worker restart inside
 * the same minute cannot double-prompt, and a day with zero in-scope rows is recorded as planned
 * rather than re-planned on every 30s poll ("no prompts exist" is otherwise indistinguishable from
 * "not planned"). The unconfigured check comes before the claim on purpose — claiming a day the bot
 * cannot send on would burn it, and since `env()` caches its parse, setting the token takes a worker
 * restart, i.e. a fresh iteration that must still find the day claimable.
 *
 * Claim and prompts share ONE transaction, committed before anything is sent. Without it the claim
 * autocommits on its own statement and a death in the window before the inserts (deploy restart,
 * OOM, tunnel drop) leaves the day claimed with zero prompts and `planned_at` null: every later
 * iteration returns null here, so no prompts, no lists, nothing to escalate and no `health=false`
 * either, recoverable only by a human deleting the `checkin_runs` row. Measured against Postgres:
 * rolled back, the day is re-claimable and the prompt unique index makes the replan write no
 * duplicates; a concurrent claimer blocks on the uncommitted row and still comes back with zero
 * rows, so the transaction preserves the cross-process guarantee rather than weakening it.
 *
 * Known gap (unfixed, needs a column): a send is retried without limit for the rest of the day.
 * There is no `send_attempts` analogue of `comment_attempts`, so a permanently unsendable chat (the
 * buyer blocked the bot) is re-attempted every 30s until midnight, only ever recording the same
 * `note`.
 *
 * Known gap (inherent, at-least-once): if Telegram delivers but the outcome never reaches the
 * database — a lost response, or the `listMessageId` UPDATE failing — the buyer is re-sent seconds
 * later, because Task 12's loop calls `sendDailyLists` again right after this function already did.
 * The duplicate is intended; what is not addressed is that the FIRST message's id is unknown to the
 * database, so `rerenderList` only ever updates the second. The orphan keeps a live keyboard and its
 * taps still route correctly by prompt id, but it never shows a checkmark.
 */
export async function runDailyCheckin(
  now: Date,
): Promise<{ created: number; sent: number; failed: number } | null> {
  const tg = telegram();
  if (!tg) return null;
  const local = berlinNow(now);

  try {
    // The claim and the prompts commit together or not at all. Null means the day was already
    // claimed, which is distinct from a claimed day that legitimately planned zero prompts.
    const plan = await db.transaction(async (tx) => {
      const claimed = await tx
        .insert(schema.checkinRuns)
        .values({ runDate: local.date })
        .onConflictDoNothing({ target: schema.checkinRuns.runDate })
        .returning({ runDate: schema.checkinRuns.runDate });
      if (claimed.length === 0) return null; // another iteration (or process) already planned today

      // Read through the pool rather than `tx`: a transaction holds one connection, so these would
      // serialise on it. Neither table is written here, so there is nothing to isolate them from.
      const [rows, buyers] = await Promise.all([loadBoardRows(), loadBuyers()]);
      let created = 0;
      let unroutable = 0;
      for (const p of planPrompts(rows, buyers)) {
        const ins = await tx
          .insert(schema.checkinPrompts)
          .values({
            promptDate: local.date,
            notionPageId: p.notionPageId,
            campaignTitle: p.campaignTitle,
            status: p.status,
            buyerPersonId: p.buyerPersonId,
            chatId: p.chatId,
            question: p.question,
            // An unbound buyer's prompt is still recorded, so the 09:00 escalation names the missing
            // binding instead of the campaign silently vanishing for the day.
            state: p.chatId ? "pending" : "unroutable",
          })
          // Targeted: an untargeted DO NOTHING would also swallow a serial-PK collision from a
          // broken sequence, silently counting a prompt that was never written.
          .onConflictDoNothing({
            target: [
              schema.checkinPrompts.promptDate,
              schema.checkinPrompts.notionPageId,
              schema.checkinPrompts.buyerPersonId,
            ],
          })
          .returning({ id: schema.checkinPrompts.id });
        created += ins.length;
        if (ins.length && !p.chatId) unroutable += 1;
      }

      await tx
        .update(schema.checkinRuns)
        .set({ plannedAt: new Date(), promptsCreated: created })
        .where(eq(schema.checkinRuns.runDate, local.date));
      return { created, unroutable };
    });
    if (plan === null) return null;

    const { sent, failed } = await sendDailyLists(local.date);
    // `sendDailyLists` reports its own outcome whenever it attempted a send, so a later iteration's
    // success overwrites a failure and recovery registers. Only report from here when there was
    // nothing to attempt — and then NOT unconditionally green: prompts that exist but reach nobody
    // are the same class of silent nothing-happened as an evening of failed sends, so a day whose
    // whole plan is unroutable must show red with the reason, while a genuinely quiet day stays green.
    if (sent === 0 && failed === 0) {
      const note =
        plan.unroutable > 0
          ? `${plan.created} prompts, none sent: ${plan.unroutable} unroutable (no Telegram chat bound)`
          : `${plan.created} prompts, nothing to send`;
      await recordServiceHealth("checkin", plan.unroutable === 0, note);
    }
    return { created: plan.created, sent, failed };
  } catch (err) {
    // Recorded rather than leaving the badge stale-green; best-effort, so that if the database is
    // what failed the original error is still the one that reaches the loop. Where the throw came
    // from decides what happens next, and both outcomes are safe: from inside the transaction it
    // rolled back, so the day is still claimable and the next iteration re-plans it; from the send
    // afterwards the day is planned and committed, and the null `listMessageId` retry covers it.
    const note = err instanceof Error ? err.message : String(err);
    await recordServiceHealth("checkin", false, note).catch(() => {});
    throw err;
  }
}

/**
 * One list message per buyer with a routable prompt today. Called from `runDailyCheckin` AND from the
 * worker loop, because it only picks up prompts whose `listMessageId` is still null — that is what
 * makes a failed or rate-limited send retry on the next iteration instead of being lost for the day.
 *
 * Reports its own health whenever it attempted at least one send, which is what makes recovery
 * register: `TelegramClient` never throws, so an evening where every send failed would otherwise be
 * recorded once, as success, by the claiming iteration and never revisited. Nothing to attempt writes
 * nothing, so a quiet 30s tick cannot clobber the day's real note.
 */
export async function sendDailyLists(date: string): Promise<{ sent: number; failed: number }> {
  const tg = telegram();
  if (!tg) return { sent: 0, failed: 0 }; // inert, not unhealthy: Settings surfaces the missing token
  const prompts = await db
    .select()
    .from(schema.checkinPrompts)
    .where(
      and(
        eq(schema.checkinPrompts.promptDate, date),
        isNull(schema.checkinPrompts.listMessageId),
        // Unroutable prompts never get a list message; they exist for the escalation to name.
        isNotNull(schema.checkinPrompts.chatId),
      ),
    );

  const byChat = new Map<string, PromptRecord[]>();
  for (const p of prompts) {
    if (!p.chatId) continue; // narrowing for the map key; the query already excluded these
    const list = byChat.get(p.chatId) ?? [];
    list.push(p);
    byChat.set(p.chatId, list);
  }

  let sent = 0;
  let failed = 0;
  let lastError: string | null = null;
  for (const [chatId, list] of byChat) {
    list.sort(byListOrder); // local to this call, so sorting in place needs no copy
    const ids = list.map((p) => p.id);
    const { text, keyboard } = renderList(dayLabel(date), list.map(toListItem));
    const res = await tg.sendMessage({ chatId, text, keyboard });
    // A send reporting success with no message id leaves nothing to re-render or address later, so
    // it counts as a failure — the same rule TelegramClient applies to an unstated `ok`.
    if (!res.ok || res.messageId === undefined) {
      failed += 1;
      lastError = res.error ?? "send reported no message id";
      // listMessageId is left null ON PURPOSE: that is what makes the next iteration retry this
      // buyer. Recorded before the sleep so the failure is durable even if the process dies in it.
      await db
        .update(schema.checkinPrompts)
        .set({ note: lastError })
        .where(inArray(schema.checkinPrompts.id, ids));
      if (res.retryAfter) await sleep(Math.min(res.retryAfter * 1000, MAX_RETRY_AFTER_MS));
      continue;
    }
    sent += 1;
    await db
      .update(schema.checkinPrompts)
      .set({ listMessageId: String(res.messageId), note: null })
      .where(inArray(schema.checkinPrompts.id, ids));
  }

  if (byChat.size > 0) {
    const note = `${sent} list${sent === 1 ? "" : "s"} sent, ${failed} failed`;
    await recordServiceHealth("checkin", failed === 0, lastError ? `${note}: ${lastError}` : note);
  }
  return { sent, failed };
}

/**
 * Total order for one buyer's list: title, then id as the tie-break. The collation is pinned to "en"
 * for the reason `planPrompts` pins it — bare `localeCompare` follows the ambient ICU build, so the
 * droplet and a dev machine could order the same board differently. The first send and every
 * re-render sort through this one comparator, so the numbers a buyer taps stay put; two same-titled
 * campaigns would otherwise fall back to whatever order Postgres happened to return.
 */
function byListOrder(a: PromptRecord, b: PromptRecord): number {
  return a.campaignTitle.localeCompare(b.campaignTitle, "en") || a.id - b.id;
}

function toListItem(p: PromptRecord): ListItem {
  return {
    promptId: p.id,
    title: p.campaignTitle,
    status: p.status,
    question: p.question,
    state: p.state,
  };
}

/** Re-render one buyer's daily list after a state change. Failure is non-fatal: the DB is the truth. */
export async function rerenderList(chatId: string, listMessageId: string): Promise<void> {
  const tg = telegram();
  if (!tg) return;
  const prompts = await db
    .select()
    .from(schema.checkinPrompts)
    .where(
      and(
        eq(schema.checkinPrompts.chatId, chatId),
        eq(schema.checkinPrompts.listMessageId, listMessageId),
      ),
    );
  if (prompts.length === 0) return;
  prompts.sort(byListOrder);
  const { text, keyboard } = renderList(dayLabel(prompts[0].promptDate), prompts.map(toListItem));
  const res = await tg.editMessageText({
    chatId,
    messageId: Number(listMessageId),
    text,
    keyboard,
  });
  if (!res.ok) console.error("[checkin] list re-render failed:", res.error);
}

/**
 * The dispatcher's view of a stored row. No cast on `state`: `schema.checkinPrompts.state` already
 * declares `.$type<PromptState>()`, so the column and `PromptRow` agree by construction — a cast here
 * would only hide the day they stop agreeing.
 */
const asPromptRow = (r: PromptRecord): PromptRow => ({
  id: r.id,
  promptDate: r.promptDate,
  chatId: r.chatId,
  campaignTitle: r.campaignTitle,
  status: r.status,
  question: r.question,
  listMessageId: r.listMessageId,
  state: r.state,
});

/** The real `UpdateDeps`: `handleUpdate` decides, and every effect it asks for lands here. */
function buildDeps(tg: TelegramClient): UpdateDeps {
  return {
    // `error` is passed through, not dropped: a force-reply that could not be armed is recorded on the
    // prompt via `noteFailure`, and "why" is the whole value of that note.
    sendMessage: async (chatId, text, forceReply) => {
      const r = await tg.sendMessage({ chatId, text, forceReply });
      return { ok: r.ok, messageId: r.messageId, error: r.error };
    },
    answerCallback: async (id, text) => {
      await tg.answerCallbackQuery({ id, text });
    },
    noteFailure: async (id, note) => {
      await db.update(schema.checkinPrompts).set({ note }).where(eq(schema.checkinPrompts.id, id));
    },
    recordChat: async (chatId, username, firstName) => {
      const vals = {
        chatId,
        username: username ?? null,
        firstName: firstName ?? null,
        lastSeenAt: new Date(),
      };
      await db
        .insert(schema.telegramChats)
        .values(vals)
        .onConflictDoUpdate({
          target: schema.telegramChats.chatId,
          // `firstSeenAt` is deliberately absent from the update: it defaults on insert and must keep
          // the first sighting, which is what an admin sorts the Settings discovery list by.
          set: { username: vals.username, firstName: vals.firstName, lastSeenAt: vals.lastSeenAt },
        });
    },
    isBoundChat: async (chatId) => {
      const [row] = await db
        .select({ id: schema.mediaBuyers.notionPersonId })
        .from(schema.mediaBuyers)
        .where(
          and(eq(schema.mediaBuyers.telegramChatId, chatId), eq(schema.mediaBuyers.active, true)),
        );
      return Boolean(row);
    },
    loadPrompt: async (id) => {
      const [row] = await db
        .select()
        .from(schema.checkinPrompts)
        .where(eq(schema.checkinPrompts.id, id));
      return row ? asPromptRow(row) : null;
    },
    // Matches on (chat, reply message id) ALONE — no state predicate, deliberately. An escalated
    // prompt still has its force-reply box live in the chat, and the 09:00 nag exists precisely to
    // provoke that late answer; the dispatcher owns the decision and documents it.
    loadPromptByReply: async (chatId, replyMessageId) => {
      const [row] = await db
        .select()
        .from(schema.checkinPrompts)
        .where(
          and(
            eq(schema.checkinPrompts.chatId, chatId),
            eq(schema.checkinPrompts.replyMessageId, String(replyMessageId)),
          ),
        );
      return row ? asPromptRow(row) : null;
    },
    openPromptsForChat: async (chatId) => {
      const rows = await db
        .select()
        .from(schema.checkinPrompts)
        .where(
          and(
            eq(schema.checkinPrompts.chatId, chatId),
            inArray(schema.checkinPrompts.state, ["pending", "awaiting_reply"]),
          ),
        );
      return rows.map(asPromptRow);
    },
    markNoChanges: async (id) => {
      await db
        .update(schema.checkinPrompts)
        .set({ state: "no_changes", answeredAt: new Date(), note: null })
        .where(eq(schema.checkinPrompts.id, id));
    },
    markAwaitingReply: async (id, replyMessageId) => {
      await db
        .update(schema.checkinPrompts)
        .set({ state: "awaiting_reply", replyMessageId: String(replyMessageId), note: null })
        .where(eq(schema.checkinPrompts.id, id));
    },
    saveAnswer: async (id, text) => {
      // Stored BEFORE any Notion call: a comment failure must never lose what the buyer typed.
      //
      // A REVISED answer must re-flush as a follow-up comment — the dispatcher accepts a second reply
      // to a live force-reply box ("actually, ignore that, we paused it"), and leaving
      // `notion_comment_id` set would strand that correction in Postgres forever, because the flush
      // only ever selects rows where it is null. An IDENTICAL replay must NOT re-flush: this loop
      // persists its Telegram offset only after a whole batch, so a crash mid-batch redelivers every
      // update in it, and a duplicate comment is visible to the client.
      //
      // `is distinct from` is the NULL-safe test that separates those two cases, and both columns ride
      // the SAME condition on purpose: resetting the attempt budget unconditionally would let a
      // replayed poison answer re-arm the cap forever, so the cap would stop meaning anything.
      const changed = sql`${schema.checkinPrompts.answerText} is distinct from ${text}`;
      await db
        .update(schema.checkinPrompts)
        .set({
          state: "answered",
          answerText: text,
          answeredAt: new Date(),
          note: null,
          notionCommentId: sql`case when ${changed} then null else ${schema.checkinPrompts.notionCommentId} end`,
          commentAttempts: sql`case when ${changed} then 0 else ${schema.checkinPrompts.commentAttempts} end`,
        })
        .where(eq(schema.checkinPrompts.id, id));
    },
    rerenderList,
  };
}

/**
 * One long-poll pass. Returns the number of updates handled.
 *
 * The offset is persisted ONCE, after the whole batch, so a crash mid-batch redelivers every update
 * in it — including the ones already applied. Every handler therefore has to be replay-safe:
 * `markNoChanges` and `saveAnswer` are idempotent under an identical replay (see `saveAnswer`), while
 * a replayed Update tap sends a second force-reply box and re-points `reply_message_id` at it,
 * orphaning the first. That last one is the dispatcher's to absorb; what this function owes it is the
 * honest statement that replay happens.
 *
 * Per-update failures are swallowed and the offset still advances past them: Telegram redelivers only
 * what the offset has not passed, so retrying a poison update forever would wedge the loop and stop
 * every other buyer being served. The 09:00 escalation is the backstop for an update lost this way.
 */
export async function pollTelegramOnce(): Promise<number> {
  const tg = telegram();
  if (!tg) return 0;
  const [state] = await db
    .select()
    .from(schema.telegramState)
    .where(eq(schema.telegramState.id, "singleton"));

  const res = await tg.getUpdates({
    offset: state?.updateOffset ?? null,
    timeoutSec: POLL_TIMEOUT_SEC,
  });
  if (!res.ok) {
    console.error("[checkin] getUpdates failed:", res.error);
    // Back off rather than spin: a persistent failure (revoked token, 429) would otherwise re-poll
    // immediately in a tight loop. Capped for the same reason `sendDailyLists` caps it — the loop is
    // sequential, so this sleep also stops the 17:00 and 09:00 gates being evaluated.
    await sleep(Math.min((res.retryAfter ?? 5) * 1000, MAX_RETRY_AFTER_MS));
    return 0;
  }

  const deps = buildDeps(tg);
  let highest = state?.updateOffset ?? 0;
  for (const update of res.updates) {
    try {
      await handleUpdate(update, deps);
    } catch (err) {
      console.error("[checkin] update handling failed:", err);
    }
    highest = Math.max(highest, update.update_id + 1);
  }
  if (res.updates.length) {
    const vals = { id: "singleton", updateOffset: highest, updatedAt: new Date() };
    await db
      .insert(schema.telegramState)
      .values(vals)
      .onConflictDoUpdate({ target: schema.telegramState.id, set: vals });
  }
  return res.updates.length;
}

/**
 * Write comments for answers that don't have one yet. Separate from the reply handler so a Notion
 * outage delays comments without losing answers.
 *
 * A duplicate comment is the one failure a CLIENT sees, so this is ordered for at-most-once, not
 * at-least-once:
 *
 * - The attempt is claimed with a compare-and-swap BEFORE the POST, so a death mid-POST still burns
 *   it. Without that, a restart between `createComment` returning and this row's update landing is
 *   indistinguishable from "never attempted" — and the deploy runbook restarts `meta-sync` every time.
 * - Because the claim is durable, `comment_attempts > 0` means "a POST may already have landed", and
 *   that is the only case that pays for a `listComments` round trip to check. `POST /comments` has no
 *   idempotency key, so there is nothing cheaper that closes it.
 * - "Accepted with no id" is not a failure: `createComment` returns null, and the row is marked done
 *   with `COMMENT_ID_UNKNOWN`, because the comment is on the card and a retry would post it twice.
 * - A retryable rejection (429, 5xx) refunds the claim and ENDS the pass. Notion answered, so nothing
 *   was written and the attempt must not count; and every remaining row would hit the same wall, so
 *   marching through the backlog would abandon a whole day of answers five passes later.
 *
 * A 4xx on the dedupe read (the integration has "Insert comments" but not "Read comments") is
 * deliberately fatal to that prompt rather than posting blind: unverifiable means unsafe, and the
 * alert carries Notion's own message, which names the missing capability.
 *
 * Returns the number of comments posted.
 */
export async function flushPendingComments(): Promise<number> {
  const creds = await getNotionCredentials();
  if (!creds) return 0;
  const notion = new NotionClient(creds.token);

  const pending = await db
    .select()
    .from(schema.checkinPrompts)
    .where(
      and(
        eq(schema.checkinPrompts.state, "answered"),
        isNull(schema.checkinPrompts.notionCommentId),
        lt(schema.checkinPrompts.commentAttempts, MAX_COMMENT_ATTEMPTS),
      ),
    )
    .orderBy(schema.checkinPrompts.id) // oldest answers first, so a backlog drains in the order given
    .limit(FLUSH_LIMIT);
  if (pending.length === 0) return 0;

  const names = new Map(
    (await db.select().from(schema.mediaBuyers)).map((b) => [b.notionPersonId, b.displayName]),
  );

  let written = 0;
  for (const p of pending) {
    // Not reachable through `saveAnswer`, which only ever writes a non-empty answer — but an empty
    // Notion comment is worse than none, and `createComment` would reject it anyway.
    if (!p.answerText) continue;
    const chunks = commentBody({
      date: p.promptDate,
      buyerName: names.get(p.buyerPersonId) ?? p.buyerPersonId,
      status: p.status,
      question: p.question,
      answer: p.answerText,
    });

    // One statement that both serialises this row against another pass and makes the attempt durable
    // before the network call. Compare-and-swap on the three facts the POST depends on: a competing
    // pass, a completed comment, or an answer revised since the SELECT all leave it matching nothing.
    const claimed = await db
      .update(schema.checkinPrompts)
      .set({ commentAttempts: p.commentAttempts + 1 })
      .where(
        and(
          eq(schema.checkinPrompts.id, p.id),
          eq(schema.checkinPrompts.commentAttempts, p.commentAttempts),
          isNull(schema.checkinPrompts.notionCommentId),
          eq(schema.checkinPrompts.answerText, p.answerText),
        ),
      )
      .returning({ id: schema.checkinPrompts.id });
    if (claimed.length === 0) continue;

    try {
      if (p.commentAttempts > 0) {
        // Compares the WHOLE body, not a prefix: a revision shares its date, buyer, status and
        // question with the comment it supersedes, and a prefix match would read the follow-up as
        // already posted and drop the correction.
        const body = chunks.join("");
        const already = (await notion.listComments(p.notionPageId)).find((c) => c.text === body);
        if (already) {
          await db
            .update(schema.checkinPrompts)
            .set({
              notionCommentId: already.id,
              note: "recovered: the comment was already on the page",
            })
            .where(eq(schema.checkinPrompts.id, p.id));
          continue;
        }
      }

      const commentId = await notion.createComment(p.notionPageId, chunks);
      written += 1;
      // Recorded only while the answer is still the one that was posted. A revision landing inside
      // this window nulled `notion_comment_id` deliberately; stamping this id over it would strand the
      // correction. The comment just posted stays valid history — the revision flushes after it.
      const stored = await db
        .update(schema.checkinPrompts)
        .set({
          notionCommentId: commentId ?? COMMENT_ID_UNKNOWN,
          note: commentId ? null : "Notion accepted the comment but returned no id",
        })
        .where(
          and(
            eq(schema.checkinPrompts.id, p.id),
            eq(schema.checkinPrompts.answerText, p.answerText),
          ),
        )
        .returning({ id: schema.checkinPrompts.id });
      if (stored.length === 0)
        console.log(`[checkin] prompt ${p.id} was revised mid-write; its comment will follow`);
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      if (err instanceof NotionApiError && err.retryable) {
        // Refunded only if the counter is still the one we claimed, so a concurrent revision's reset
        // to zero is never undone.
        await db
          .update(schema.checkinPrompts)
          .set({ commentAttempts: p.commentAttempts, note })
          .where(
            and(
              eq(schema.checkinPrompts.id, p.id),
              eq(schema.checkinPrompts.commentAttempts, p.commentAttempts + 1),
            ),
          );
        console.error("[checkin] comment flush paused:", note);
        break;
      }
      // The claimed attempt stands. A 4xx is a comment Notion will never accept; a transport failure
      // may have landed one, and the burnt attempt is exactly what routes the next pass through the
      // dedupe read above instead of posting again.
      // Conditioned on our own claim for the same reason the refund is: a revision that landed inside
      // the window cleared `note` and reset the budget deliberately, and neither a stale error nor an
      // "abandoned after 5 attempts" report belongs on an answer that just got a fresh one.
      const noted = await db
        .update(schema.checkinPrompts)
        .set({ note })
        .where(
          and(
            eq(schema.checkinPrompts.id, p.id),
            eq(schema.checkinPrompts.commentAttempts, p.commentAttempts + 1),
          ),
        )
        .returning({ id: schema.checkinPrompts.id });
      const attempts = p.commentAttempts + 1;
      if (noted.length > 0 && attempts >= MAX_COMMENT_ATTEMPTS) {
        await sendAlertChannelMessage(
          `❌ Check-in comment failed ${attempts}× for ${p.campaignTitle} (${p.promptDate}): ${note}\nThe answer is stored in checkin_prompts id ${p.id}.`,
        );
        await recordServiceHealth("checkin", false, `comment failed for prompt ${p.id}: ${note}`);
      }
    }
  }
  return written;
}

/**
 * Post yesterday's unanswered prompts to the shared alert channel, once. Unroutable prompts are named
 * too, so a missing Telegram binding is visible rather than silent.
 *
 * `escalated_at` is CLAIMED before the send, not written after it. The claim is a conditional update,
 * so it matches zero rows both when the day was never planned and when another pass already claimed
 * it — that is where the "no run row" check went. Sending first and recording after would re-post the
 * entire escalation to the shared channel on the next boot, and the deploy runbook restarts
 * `meta-sync` on every deploy. A crash after claiming loses one nag; a crash before it re-runs
 * cleanly. For an at-most-once notification that is the right way round.
 *
 * An `answered` prompt is never escalated even if its comment has not flushed yet, and the flush is
 * never consulted to decide that: escalation keys on `state`, the flush keys on `notion_comment_id`,
 * and keeping them independent is what stops a merely-slow comment being reported as a missing answer.
 *
 * Returns the number of prompts moved to `escalated`, or null when there was nothing to claim.
 */
export async function escalateUnanswered(now: Date): Promise<number | null> {
  const date = addDays(berlinNow(now).date, -1); // yesterday, via the shared date helper

  const claimed = await db
    .update(schema.checkinRuns)
    .set({ escalatedAt: new Date() })
    .where(and(eq(schema.checkinRuns.runDate, date), isNull(schema.checkinRuns.escalatedAt)))
    .returning({ runDate: schema.checkinRuns.runDate });
  if (claimed.length === 0) return null;

  const open = await db
    .select()
    .from(schema.checkinPrompts)
    .where(
      and(
        eq(schema.checkinPrompts.promptDate, date),
        inArray(schema.checkinPrompts.state, UNANSWERED_AT_ESCALATION),
      ),
    );
  if (open.length === 0) return 0;

  const names = new Map(
    (await db.select().from(schema.mediaBuyers)).map((b) => [b.notionPersonId, b.displayName]),
  );
  open.sort(byListOrder); // the same total order the buyer's list uses, so the message is reproducible
  const byBuyer = new Map<string, { buyerName: string; titles: string[]; unroutable: boolean }>();
  for (const p of open) {
    // Unroutable prompts are grouped apart from the same buyer's routable ones: the line for them
    // reads "(no Telegram binding)", which is a different problem for the reader to act on.
    const key = `${p.buyerPersonId}:${p.state === "unroutable"}`;
    const g = byBuyer.get(key) ?? {
      buyerName: names.get(p.buyerPersonId) ?? p.buyerPersonId,
      titles: [],
      unroutable: p.state === "unroutable",
    };
    g.titles.push(p.campaignTitle);
    byBuyer.set(key, g);
  }

  const sent = await sendAlertChannelMessage(escalationText(date, [...byBuyer.values()]));
  if (!sent.ok) {
    // Left in their open states on purpose. `renderList` draws buttons for `pending` and
    // `awaiting_reply` only, so closing them out for an escalation nobody received would take away
    // the buyer's buttons AND tell no one. The day stays claimed, so this is recorded rather than
    // retried.
    console.error("[checkin] escalation send failed:", sent.error);
    await recordServiceHealth(
      "checkin",
      false,
      `escalation for ${date} was not delivered: ${sent.error}`,
    );
    return 0;
  }

  // The state predicate matters even though the ids were captured moments ago: this is a blind write
  // by stale id across a network send. Forcing an answer that landed in that window back to
  // `escalated` would hide it from the flush forever — nothing rescans `escalated` rows — so the
  // buyer's answer would sit in `answer_text` unposted, permanently and silently.
  const moved = await db
    .update(schema.checkinPrompts)
    .set({ state: "escalated" })
    .where(
      and(
        inArray(
          schema.checkinPrompts.id,
          open.map((p) => p.id),
        ),
        inArray(schema.checkinPrompts.state, UNANSWERED_AT_ESCALATION),
      ),
    )
    .returning({ id: schema.checkinPrompts.id });
  return moved.length;
}
