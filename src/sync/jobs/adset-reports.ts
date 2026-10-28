/**
 * Database and Telegram IO for the daily ad-set CSV reports. What is due lives in
 * `@/lib/adset-report`, what the report contains in `@/server/adset-report`; this file claims,
 * sends, and records the outcome.
 */
import { and, eq, lt, isNull, ne, or, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { isAdsetReportDue, reportedDay } from "@/lib/adset-report";
import { berlinNow } from "@/lib/berlin-time";
import { MAX_ATTEMPTS } from "@/lib/daily-report";
import { fmtCurrency, fmtNumber } from "@/lib/format";
import { adsetReportCsv, buildAdsetReport } from "@/server/adset-report";
import { telegram } from "./checkin";

export type DeliveryResult = { ok: true; adSets: number } | { ok: false; error: string };

/**
 * Build `date`'s report for one client and send it to one chat: the CSV with a one-line summary as
 * its caption, or a plain message when nothing delivered that day (an empty file reads as a fault).
 */
export async function deliverAdsetReport(
  target: { clientId: string; chatId: string },
  date: string,
): Promise<DeliveryResult> {
  const tg = await telegram();
  if (!tg) return { ok: false, error: "Telegram is not configured (TELEGRAM_BOT_TOKEN)." };
  const report = await buildAdsetReport(target.clientId, date);
  if ("error" in report) return { ok: false, error: report.error };

  const adSets = report.doc.rows.length;
  const t = report.totals;
  const sent =
    adSets === 0
      ? await tg.sendMessage({
          chatId: target.chatId,
          text: `${report.clientName} · ad sets · ${date}\nNo ad set delivered on this day.`,
        })
      : await tg.sendDocument({
          chatId: target.chatId,
          filename: `${report.doc.filename}.csv`,
          content: adsetReportCsv(report),
          mimeType: "text/csv",
          caption:
            `${report.clientName} · ad sets · ${date}\n` +
            `${adSets} ad set${adSets === 1 ? "" : "s"} · Spend ${fmtCurrency(t.spend, "USD", 2)} · ` +
            `${fmtNumber(t.impressions)} impr · ${fmtNumber(t.clicks)} clicks\n` +
            `Registrations ${fmtNumber(t.registrations)} · Purchases ${fmtNumber(t.purchases)}`,
        });
  return sent.ok
    ? { ok: true, adSets }
    : { ok: false, error: sent.error ?? "Telegram send failed" };
}

export interface AdsetReportRun {
  id: string;
  clientId: string;
  date: string;
  result: DeliveryResult;
}

/**
 * Send every schedule that has come due. Called from the worker's 30s notification loop.
 *
 * Each schedule's reported day is claimed by a conditional update BEFORE the send, so a second tick
 * (or a racing process) cannot send it twice while the first is still building. A failed send leaves
 * `sent_at` null and the next ticks retry until `MAX_ATTEMPTS`. A crash after Telegram accepted the
 * file but before `sent_at` was written re-sends it once — one duplicate file to a single reader is
 * the better failure than a missing day.
 *
 * Nothing is claimed while the bot is unconfigured, or the attempts would burn while the feature is
 * inert and the day could never be sent once the token was set.
 */
export async function runDueAdsetReports(now: Date): Promise<AdsetReportRun[]> {
  if (!(await telegram())) return [];
  const local = berlinNow(now);
  const day = reportedDay(local);
  const t = schema.adsetReportSchedules;
  const schedules = await db.select().from(t).where(eq(t.active, true));

  const runs: AdsetReportRun[] = [];
  for (const s of schedules) {
    if (!isAdsetReportDue(s, local, day)) continue;
    const claimed = await db
      .update(t)
      .set({
        runDate: day,
        sentAt: null,
        attempts: sql`case when ${t.runDate} = ${day} then ${t.attempts} + 1 else 1 end`,
        lastError: null,
      })
      .where(
        and(
          eq(t.id, s.id),
          eq(t.active, true),
          or(
            isNull(t.runDate),
            ne(t.runDate, day),
            and(isNull(t.sentAt), lt(t.attempts, MAX_ATTEMPTS)),
          ),
        ),
      )
      .returning({ id: t.id });
    if (claimed.length === 0) continue;

    const result = await deliverAdsetReport(s, day).catch(
      (e): DeliveryResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    await db
      .update(t)
      .set(result.ok ? { sentAt: new Date(), lastError: null } : { lastError: result.error })
      .where(eq(t.id, s.id));
    runs.push({ id: s.id, clientId: s.clientId, date: day, result });
  }
  return runs;
}
