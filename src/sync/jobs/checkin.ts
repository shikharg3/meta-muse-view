/**
 * Database and Telegram IO for the daily media-buyer check-in. Every decision this file acts on was
 * made in the pure core (`@/lib/checkin`, `@/lib/checkin-render`, `@/lib/berlin-time`) and is unit
 * tested there; what lives here is ordering, idempotency and retry.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import { boardRows } from "@/notion/parse";
import { TelegramClient } from "@/telegram/client";
import { berlinNow } from "@/lib/berlin-time";
import { dayLabel, renderList, type ListItem } from "@/lib/checkin-render";
import { planPrompts, type CheckinBoardRow, type CheckinBuyer } from "@/lib/checkin";
import { recordServiceHealth } from "@/sync/state";

/** A stored prompt row. Not `PromptRow`: that name belongs to the update handler's own view of one. */
type PromptRecord = typeof schema.checkinPrompts.$inferSelect;

/**
 * A 429 is honoured, but never for longer than this. The check-in loop is sequential, so sleeping
 * here also stops taps and replies being polled — and the retry is durable (`listMessageId` stays
 * null), so waiting out a long flood-wait buys nothing the next iteration does not.
 */
const MAX_RETRY_AFTER_MS = 60_000;

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
