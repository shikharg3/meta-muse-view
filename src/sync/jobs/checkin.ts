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
 * "not planned"). The unconfigured check comes before the claim on purpose — claiming a day we
 * cannot send on would silently burn that day if the token were set later the same afternoon.
 *
 * Known gap: the claim is written before the prompts, so a crash between the two leaves the day
 * claimed with a null `planned_at` and nothing to retry. Recovery is deleting that `checkin_runs`
 * row; the alternative (re-claiming while `planned_at` is null) reopens the double-send this claim
 * exists to close.
 */
export async function runDailyCheckin(
  now: Date,
): Promise<{ created: number; sent: number } | null> {
  const tg = telegram();
  if (!tg) return null;
  const local = berlinNow(now);

  const claimed = await db
    .insert(schema.checkinRuns)
    .values({ runDate: local.date })
    .onConflictDoNothing()
    .returning({ runDate: schema.checkinRuns.runDate });
  if (claimed.length === 0) return null; // another iteration (or process) already planned today

  try {
    const plans = planPrompts(await loadBoardRows(), await loadBuyers());
    let created = 0;
    for (const p of plans) {
      // One statement per prompt rather than one batch: the day is already claimed, so a failure
      // part-way through must leave the prompts written so far standing.
      const ins = await db
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
        .onConflictDoNothing()
        .returning({ id: schema.checkinPrompts.id });
      created += ins.length;
    }

    await db
      .update(schema.checkinRuns)
      .set({ plannedAt: new Date(), promptsCreated: created })
      .where(eq(schema.checkinRuns.runDate, local.date));

    const sent = await sendDailyLists(local.date);
    await recordServiceHealth("checkin", true, `${created} prompts, ${sent} messages`);
    return { created, sent };
  } catch (err) {
    // The day is claimed, so this will not be re-planned: record it rather than leaving the Settings
    // badge stale-green. Best-effort — if the database is what failed, the original error must still
    // be the one that reaches the loop.
    const note = err instanceof Error ? err.message : String(err);
    await recordServiceHealth("checkin", false, note).catch(() => {});
    throw err;
  }
}

/**
 * One list message per buyer with a routable prompt today. Called from `runDailyCheckin` AND from the
 * worker loop, because it only picks up prompts whose `listMessageId` is still null — that is what
 * makes a failed or rate-limited send retry on the next iteration instead of being lost for the day.
 * Returns the number of messages sent.
 */
export async function sendDailyLists(date: string): Promise<number> {
  const tg = telegram();
  if (!tg) return 0;
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
  for (const [chatId, list] of byChat) {
    list.sort(byListOrder); // local to this call, so sorting in place needs no copy
    const ids = list.map((p) => p.id);
    const { text, keyboard } = renderList(dayLabel(date), list.map(toListItem));
    const res = await tg.sendMessage({ chatId, text, keyboard });
    // A send reporting success with no message id leaves nothing to re-render or address later, so
    // it counts as a failure — the same rule TelegramClient applies to an unstated `ok`.
    if (!res.ok || res.messageId === undefined) {
      // listMessageId is left null ON PURPOSE: that is what makes the next iteration retry this
      // buyer. Recorded before the sleep so the failure is durable even if the process dies in it.
      await db
        .update(schema.checkinPrompts)
        .set({ note: res.error ?? "send reported no message id" })
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
  return sent;
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
