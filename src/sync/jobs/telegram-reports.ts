/**
 * Database and Telegram IO for the scheduled report CSVs. What is due lives in
 * `@/lib/scheduled-report`, what a report contains in `@/server/scheduled-report`; this file claims,
 * sends, and records the outcome.
 */
import { and, eq, lt, isNull, ne, or, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { berlinNow } from "@/lib/berlin-time";
import { MAX_ATTEMPTS } from "@/lib/daily-report";
import { isScheduleDue, type ReportRecipe } from "@/lib/scheduled-report";
import { showCell } from "@/lib/report-export";
import { resolveTimeIncrement } from "@/lib/time-increment";
import { buildRecipeReport, FILE_MAX_ROWS, reportCsv } from "@/server/scheduled-report";
import type { ReportPayload } from "@/server/agent/report";
import { telegram } from "./checkin";

type ScheduleRow = typeof schema.telegramReportSchedules.$inferSelect;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The recipe a stored schedule runs. */
export function scheduleRecipe(s: ScheduleRow): ReportRecipe {
  return {
    clientId: s.clientId,
    brands: strings(s.brands),
    campaignIds: strings(s.campaignIds),
    columns: strings(s.columns),
    breakdown: s.breakdown,
    timeIncrement: resolveTimeIncrement(s.timeIncrement),
    markup: s.markup,
    range: { preset: s.rangePreset },
  };
}

export type DeliveryResult = { ok: true; rows: number } | { ok: false; error: string };

/**
 * Run `recipe` as of `today` (Berlin) and send it to `chatId`: the CSV, captioned with its scope,
 * window and headline totals; or a plain message when nothing matched (an empty file reads as a
 * fault).
 */
export async function deliverReport(
  name: string,
  recipe: ReportRecipe,
  chatId: string,
  today: string,
): Promise<DeliveryResult> {
  const tg = await telegram();
  if (!tg) return { ok: false, error: "Telegram is not configured (TELEGRAM_BOT_TOKEN)." };
  const report = await buildRecipeReport(recipe, today, FILE_MAX_ROWS);
  if ("error" in report) return { ok: false, error: report.error };

  const head = `${name}\n${report.title} · ${report.subtitle}`;
  const sent =
    report.rowCount === 0
      ? await tg.sendMessage({
          chatId,
          text: `${head}\nNo delivery in this window.${report.note ? `\n${report.note}` : ""}`,
        })
      : await tg.sendDocument({
          chatId,
          filename: `${report.filename}.csv`,
          content: reportCsv(report),
          mimeType: "text/csv",
          caption: `${head}\n${report.rowCount} row${report.rowCount === 1 ? "" : "s"}${headline(report)}`,
        });
  return sent.ok
    ? { ok: true, rows: report.rowCount }
    : { ok: false, error: sent.error ?? "Telegram send failed" };
}

/** "\nSpend $1,234 · Impressions 56,789 …" from the totals row's first four metric columns. */
function headline(r: ReportPayload): string {
  if (!r.totals) return "";
  const parts: string[] = [];
  r.columns.forEach((c, i) => {
    const v = r.totals![i];
    if (c.kind !== "text" && typeof v === "number" && parts.length < 4)
      parts.push(`${c.label} ${showCell(v, c.kind)}`);
  });
  return parts.length ? `\n${parts.join(" · ")}` : "";
}

export interface ReportRun {
  id: string;
  name: string;
  result: DeliveryResult;
}

/**
 * Send every schedule that has come due. Called from the worker's 30s notification loop.
 *
 * Each schedule's send date is claimed by a conditional update BEFORE the run, so a second tick (or a
 * racing process) cannot send it twice while the first is still building. A failed send leaves
 * `sent_at` null and the next ticks retry until `MAX_ATTEMPTS`. A crash after Telegram accepted the
 * file but before `sent_at` was written re-sends it once — one duplicate file to one chat is the
 * better failure than a missing day.
 *
 * Nothing is claimed while the bot is unconfigured, or the attempts would burn while the feature is
 * inert and the day could never be sent once the token was set.
 */
export async function runDueReports(now: Date): Promise<ReportRun[]> {
  if (!(await telegram())) return [];
  const local = berlinNow(now);
  const t = schema.telegramReportSchedules;
  const schedules = await db.select().from(t).where(eq(t.active, true));

  const runs: ReportRun[] = [];
  for (const s of schedules) {
    if (!isScheduleDue(s, local)) continue;
    const claimed = await db
      .update(t)
      .set({
        runDate: local.date,
        sentAt: null,
        attempts: sql`case when ${t.runDate} = ${local.date} then ${t.attempts} + 1 else 1 end`,
        lastError: null,
      })
      .where(
        and(
          eq(t.id, s.id),
          eq(t.active, true),
          or(
            isNull(t.runDate),
            ne(t.runDate, local.date),
            and(isNull(t.sentAt), lt(t.attempts, MAX_ATTEMPTS)),
          ),
        ),
      )
      .returning({ id: t.id });
    if (claimed.length === 0) continue;

    const result = await deliverReport(s.name, scheduleRecipe(s), s.chatId, local.date).catch(
      (e): DeliveryResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    await db
      .update(t)
      .set(result.ok ? { sentAt: new Date(), lastError: null } : { lastError: result.error })
      .where(eq(t.id, s.id));
    runs.push({ id: s.id, name: s.name, result });
  }
  return runs;
}
