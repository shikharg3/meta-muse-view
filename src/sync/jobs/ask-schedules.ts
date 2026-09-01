import { and, eq, ne, or, isNull } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { berlinNow } from "@/lib/berlin-time";
import { chatTurn } from "@/server/agent/chat";
import { sendReportChannelMessage } from "@/sync/alerts";
import { findUserById } from "@/lib/auth/users";

/** Telegram hard-caps a message; the daily report uses the same number. */
const TELEGRAM_TEXT_LIMIT = 4096;

export interface ScheduleRun {
  id: string;
  question: string;
  ok: boolean;
  error?: string;
}

/** Monday = 1 … Sunday = 7, matching the `weekday` column. */
function isoWeekday(ymd: string): number {
  const day = new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

export function isDue(
  row: {
    cadence: string;
    weekday: number | null;
    hour: number;
    minute: number;
    lastRunDate: string | null;
  },
  local: { date: string; hour: number; minute: number },
): boolean {
  if (row.lastRunDate === local.date) return false; // already claimed today
  if (local.hour * 60 + local.minute < row.hour * 60 + row.minute) return false;
  const wd = isoWeekday(local.date);
  if (row.cadence === "weekdays") return wd <= 5;
  if (row.cadence === "weekly") return wd === (row.weekday ?? 1);
  return true; // daily
}

/**
 * Answer every schedule that has come due and post it to the report channel.
 *
 * Claims the date BEFORE running the model, exactly like `sendDailyPerformanceReport`: the worker
 * ticks every 30 seconds and a turn can take a minute, so an unclaimed row would be picked up again
 * by the next tick and answered twice. A failure records `lastError` and keeps the claim, because
 * retrying an expensive model call in a 30s loop is a worse failure than skipping a day.
 */
export async function runDueSchedules(now: Date): Promise<ScheduleRun[]> {
  const local = berlinNow(now);
  const rows = await db
    .select()
    .from(schema.askSchedules)
    .where(
      and(
        eq(schema.askSchedules.active, true),
        or(
          isNull(schema.askSchedules.lastRunDate),
          ne(schema.askSchedules.lastRunDate, local.date),
        ),
      ),
    );

  const runs: ScheduleRun[] = [];
  for (const row of rows) {
    if (!isDue(row, local)) continue;

    const claimed = await db
      .update(schema.askSchedules)
      .set({ lastRunDate: local.date, lastError: null })
      .where(
        and(
          eq(schema.askSchedules.id, row.id),
          or(
            isNull(schema.askSchedules.lastRunDate),
            ne(schema.askSchedules.lastRunDate, local.date),
          ),
        ),
      )
      .returning({ id: schema.askSchedules.id });
    if (claimed.length === 0) continue; // another instance got there first

    try {
      const owner = await findUserById(row.userId);
      const result = await chatTurn([{ role: "user", content: row.question }], {
        userId: row.userId,
        role: owner?.role ?? null,
      });
      if (result.error) throw new Error(result.error);
      const body = result.reply.trim() || "(no answer)";
      const text = `*${escapeMd(row.question)}*\n\n${body}`.slice(0, TELEGRAM_TEXT_LIMIT);
      const sent = await sendReportChannelMessage(text);
      if (!sent.ok) throw new Error(sent.error ?? "Telegram send failed");
      runs.push({ id: row.id, question: row.question, ok: true });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await db
        .update(schema.askSchedules)
        .set({ lastError: error })
        .where(eq(schema.askSchedules.id, row.id));
      runs.push({ id: row.id, question: row.question, ok: false, error });
    }
  }
  return runs;
}

/** Telegram Markdown treats these as syntax; a question containing one would break the message. */
const escapeMd = (s: string): string => s.replace(/([*_`[\]])/g, "\\$1");
