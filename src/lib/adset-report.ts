/**
 * Pure rules of the daily ad-set CSV report: which metrics it carries, which day it reports, and
 * when a schedule is due. No database, no clock, no Telegram — `src/server/adset-report.ts` builds the
 * report and `src/sync/jobs/adset-reports.ts` sends it.
 */
import type { LocalNow } from "./berlin-time";
import { MAX_ATTEMPTS } from "./daily-report";
import { addDays } from "./range";

/**
 * Report-catalog keys, in CSV column order. Read through the catalog so every figure means what it
 * means in the Report Builder: CPC/CPM/CTR derive from summed spend, clicks (all) and impressions,
 * and Registrations/Purchases are the de-duplicated event families (Meta reports one registration
 * under up to five action types).
 */
export const ADSET_REPORT_METRICS = [
  "spend",
  "impressions",
  "clicks",
  "cpc",
  "cpm",
  "ctr",
  "registrations",
  "purchases",
] as const;

/** Default send time, Berlin. See `DAILY_REPORT_AT` for why nothing earlier is safe. */
export const ADSET_REPORT_DEFAULT_AT = { hour: 10, minute: 0 };

/**
 * The day a send at `local` reports: the Berlin day before. Insight dates are each ad account's own
 * calendar day, so a send before 10:00 Berlin can catch a US account's "yesterday" still open.
 */
export function reportedDay(local: LocalNow): string {
  return addDays(local.date, -1);
}

export interface ScheduleState {
  active: boolean;
  hour: number;
  minute: number;
  /** The reported day last claimed. */
  runDate: string | null;
  sentAt: Date | string | null;
  attempts: number;
}

/**
 * Whether a schedule should send `day`'s report now. A new day is due once the wall clock reaches the
 * schedule's time; a day already claimed is due again only while unsent and under `MAX_ATTEMPTS`.
 * At-or-after rather than equality, so a worker that was down at the mark still sends late.
 */
export function isAdsetReportDue(s: ScheduleState, local: LocalNow, day: string): boolean {
  if (!s.active) return false;
  if (local.hour * 60 + local.minute < s.hour * 60 + s.minute) return false;
  if (s.runDate !== day) return true;
  return s.sentAt == null && s.attempts < MAX_ATTEMPTS;
}

/** A Telegram chat id: a user/group id, or a `-100…` channel/supergroup id. */
export const CHAT_ID_PATTERN = /^-?\d{1,20}$/;
