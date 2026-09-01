/**
 * Database and Telegram IO for the 10:00 daily performance report. Every rule it acts on lives in
 * `@/lib/daily-report` (what counts, how it rolls up) and `@/lib/daily-report-render` (what it says);
 * this file only claims the day, reads, sends, and records the outcome.
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getReportChatCredentials } from "@/lib/credentials";
import { aggregateEngagements, MAX_ATTEMPTS } from "@/lib/daily-report";
import { renderDailyReport } from "@/lib/daily-report-render";
import { fetchDailyEngagementRows, yesterdayWindow } from "@/server/fns/daily-report";
import { sendReportChannelMessage } from "@/sync/alerts";
import { recordServiceHealth } from "@/sync/state";

/** What one completed run did. Null means the gate produced nothing (see `sendDailyPerformanceReport`). */
export interface DailyReportRun {
  date: string;
  engagements: number;
  messages: number;
}

/**
 * Send yesterday's performance report, at most once per reported day.
 *
 * Returns null when there is nothing to report on: the day is already sent, its retries are spent, or
 * Telegram is not configured. The gate re-enters every ~30s, so null is the normal answer all day.
 *
 * ORDER MATTERS. The day is claimed BEFORE the send, the opposite of the check-in's reminders: a
 * duplicate performance post is worse than a late one, so a crash between claiming and sending must
 * lose the post rather than risk two. Recovery is `attempts`, not re-entry — a failed send leaves
 * `sent_at` null and the next iteration resumes.
 *
 * Credentials are checked BEFORE claiming. An unconfigured bot must leave the day unclaimed, or the
 * five attempts would burn while the feature is inert and the day could never be sent once the token
 * was finally set.
 */
export async function sendDailyPerformanceReport(now: Date): Promise<DailyReportRun | null> {
  if (!(await getReportChatCredentials())) return null;

  const w = yesterdayWindow(now);
  const date = w.since;

  const claimed = await db
    .insert(schema.dailyReportRuns)
    .values({ runDate: date })
    .onConflictDoNothing()
    .returning({ runDate: schema.dailyReportRuns.runDate });

  // Chunks already delivered on an earlier attempt. Resuming from here is what stops a retry after a
  // partial failure from re-posting the messages that did land.
  let alreadySent = 0;
  if (claimed.length === 0) {
    const [row] = await db
      .select({
        sentAt: schema.dailyReportRuns.sentAt,
        attempts: schema.dailyReportRuns.attempts,
        messages: schema.dailyReportRuns.messages,
      })
      .from(schema.dailyReportRuns)
      .where(eq(schema.dailyReportRuns.runDate, date));
    if (!row || row.sentAt !== null || row.attempts >= MAX_ATTEMPTS) return null;
    alreadySent = row.messages;
  }

  const { campaigns, accounts } = await fetchDailyEngagementRows(w);
  const rows = aggregateEngagements(campaigns, accounts);
  const chunks = renderDailyReport(date, rows);

  for (let i = alreadySent; i < chunks.length; i++) {
    // `chunks[i]` is in-bounds by the loop condition, but this project does not enable
    // `noUncheckedIndexedAccess`, so the non-null assertion is the honest form of what TS cannot see.
    const res = await sendReportChannelMessage(chunks[i]!);
    if (!res.ok) {
      const error = res.error ?? "unknown Telegram error";
      await db
        .update(schema.dailyReportRuns)
        .set({
          attempts: sql`${schema.dailyReportRuns.attempts} + 1`,
          // Persisted so the retry resumes after the chunks that DID land.
          messages: i,
          error,
        })
        .where(eq(schema.dailyReportRuns.runDate, date));
      console.error(`[daily-report] send failed for ${date} at message ${i + 1}: ${error}`);
      await recordServiceHealth("daily-report", false, error);
      return null;
    }
  }

  await db
    .update(schema.dailyReportRuns)
    .set({
      sentAt: new Date(),
      engagements: rows.length,
      messages: chunks.length,
      error: null,
    })
    .where(eq(schema.dailyReportRuns.runDate, date));
  await recordServiceHealth("daily-report", true, null);
  return { date, engagements: rows.length, messages: chunks.length };
}
