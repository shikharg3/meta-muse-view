/**
 * Pure rules of the scheduled Telegram reports: the recipe a schedule stores, its defaults, and when a
 * schedule is due. Client-safe — no database, clock or Telegram. The engine is
 * `src/server/scheduled-report.ts`; the sender is `src/sync/jobs/telegram-reports.ts`.
 */
import type { LocalNow } from "./berlin-time";
import { MAX_ATTEMPTS } from "./daily-report";
import type { TimeIncrement } from "./time-increment";

/** Pseudo-brand: a client's accounts that no Notion board row lists (added by hand on the client page). */
export const OTHER_BRAND = "__other__";

/** Everything that decides a report's content. A schedule stores one; a preview sends one. */
export interface ReportRecipe {
  clientId: string;
  /** Brand keys (normalised board-row titles, or OTHER_BRAND). Empty = the whole client. */
  brands: string[];
  /** Campaign whitelist inside the brand/client scope. Empty = every campaign in scope. */
  campaignIds: string[];
  /**
   * Column keys, in column order: report-catalog metrics, and `dim:` identity columns
   * (IDENTITY_COLUMNS). Every column of the file is one of these; nothing is added implicitly.
   */
  columns: string[];
  breakdown: string;
  timeIncrement: TimeIncrement;
  /** Fraction added to spend (0.15 = +15%), or null. */
  markup: number | null;
  /** A DATE_PRESETS key, resolved on the day the report runs; or explicit dates (previews only). */
  range: { preset: string } | { since: string; until: string };
  /**
   * Replace interrupted days with an estimate of uninterrupted delivery (`src/server/modeling.ts`).
   * The result is marked as modeled throughout; actual reporting is the default.
   */
  modeled: boolean;
}

/**
 * Identity columns a report can carry besides metrics. `payloadKey` is the engine's column key.
 * Which apply depends on the breakdown and granularity (`identityColumnsFor`); a selected one that
 * does not apply is simply absent from the file.
 */
export const IDENTITY_COLUMNS: { key: string; label: string; payloadKey: string }[] = [
  { key: "dim:period", label: "Date / period", payloadKey: "_period" },
  { key: "dim:value", label: "Breakdown value", payloadKey: "_dim" },
  { key: "dim:brand", label: "Brand", payloadKey: "_brand" },
  { key: "dim:account", label: "Account", payloadKey: "_account" },
  { key: "dim:account_id", label: "Account ID", payloadKey: "_account_id" },
  { key: "dim:campaign", label: "Campaign", payloadKey: "_campaign" },
  { key: "dim:campaign_id", label: "Campaign ID", payloadKey: "_campaign_id" },
  { key: "dim:adset", label: "Ad set", payloadKey: "_adset" },
  { key: "dim:adset_id", label: "Ad set ID", payloadKey: "_adset_id" },
  { key: "dim:ad", label: "Ad", payloadKey: "_ad" },
  { key: "dim:ad_id", label: "Ad ID", payloadKey: "_ad_id" },
];

export const isIdentityColumn = (key: string): boolean => key.startsWith("dim:");

const ENTITY_IDENTITY: Record<string, string[]> = {
  campaign: ["dim:brand", "dim:account", "dim:account_id", "dim:campaign", "dim:campaign_id"],
  adset: [
    "dim:brand",
    "dim:account",
    "dim:account_id",
    "dim:campaign",
    "dim:campaign_id",
    "dim:adset",
    "dim:adset_id",
  ],
  ad: [
    "dim:brand",
    "dim:account",
    "dim:account_id",
    "dim:campaign",
    "dim:campaign_id",
    "dim:adset",
    "dim:adset_id",
    "dim:ad",
    "dim:ad_id",
  ],
};

/** The identity columns a breakdown and granularity can fill. */
export function identityColumnsFor(breakdown: string, timeIncrement: TimeIncrement): string[] {
  const period = timeIncrement === "all_days" ? [] : ["dim:period"];
  if (breakdown === "none") return period;
  return [...period, ...(ENTITY_IDENTITY[breakdown] ?? ["dim:value"])];
}

/** The identity columns a breakdown starts with: what names a row, without the Account columns. */
export function defaultIdentityColumns(
  breakdown: string,
  timeIncrement: TimeIncrement,
  multiBrand: boolean,
): string[] {
  const period = timeIncrement === "all_days" ? [] : ["dim:period"];
  const brand = multiBrand ? ["dim:brand"] : [];
  switch (breakdown) {
    case "none":
      return period;
    case "campaign":
      return [...period, ...brand, "dim:campaign", "dim:campaign_id"];
    case "adset":
      return [...period, ...brand, "dim:campaign", "dim:adset", "dim:adset_id"];
    case "ad":
      return [...period, ...brand, "dim:campaign", "dim:adset", "dim:ad", "dim:ad_id"];
    default:
      return [...period, "dim:value"];
  }
}

/** The original OneAgency ad-set report, and the builder's starting point. */
export const DEFAULT_RECIPE: Omit<ReportRecipe, "clientId"> = {
  brands: [],
  campaignIds: [],
  columns: [
    ...defaultIdentityColumns("adset", "1", true),
    "spend",
    "impressions",
    "clicks",
    "cpc",
    "cpm",
    "ctr",
    "registrations",
    "purchases",
  ],
  breakdown: "adset",
  timeIncrement: "1",
  markup: null,
  range: { preset: "yesterday" },
  modeled: false,
};

/** Placeholders a schedule's file name may use; each is replaced by a YYYY-MM-DD date. */
export const FILENAME_TOKENS = ["{since}", "{until}", "{today}"];

/**
 * The file name a report is sent under, without extension. A schedule's own name wins over the
 * engine's default; tokens are filled, characters a file system rejects are dropped, and a modeled
 * report always says "modeled" — the file name is where that is read from.
 */
export function reportFilename(
  custom: string | null,
  fallback: string,
  ctx: { since: string; until: string; today: string; modeled: boolean },
): string {
  const filled = [
    ...(custom ?? "")
      .replace(/\{since\}/g, ctx.since)
      .replace(/\{until\}/g, ctx.until)
      .replace(/\{today\}/g, ctx.today)
      .replace(/\.csv$/i, "")
      .replace(/[\\/:*?"<>|]/g, ""),
  ]
    .filter((ch) => ch >= " ") // control characters
    .join("")
    .trim();
  const name = filled || fallback;
  return ctx.modeled && !/modeled/i.test(name) ? `${name}_modeled` : name;
}

export type Cadence = "daily" | "weekdays" | "weekly" | "monthly";

export const CADENCES: { key: Cadence; label: string }[] = [
  { key: "daily", label: "Every day" },
  { key: "weekdays", label: "Weekdays (Mon–Fri)" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

/** ISO weekday labels, Monday = 1. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Default send time, Berlin. See `DAILY_REPORT_AT` for why nothing earlier is safe for "yesterday". */
export const DEFAULT_SEND_AT = { hour: 10, minute: 0 };

/** The period a cadence most naturally reports, offered when the cadence changes. */
export const CADENCE_DEFAULT_PRESET: Record<Cadence, string> = {
  daily: "yesterday",
  weekdays: "yesterday",
  weekly: "last_week_mon_sun",
  monthly: "last_month",
};

export interface ScheduleState {
  active: boolean;
  cadence: string;
  /** ISO weekday for `weekly`, 1 = Monday. */
  weekday: number | null;
  /** Day of month for `monthly`, 1–28 so every month has it. */
  monthDay: number | null;
  hour: number;
  minute: number;
  /** The Berlin date of the last claimed send. */
  runDate: string | null;
  sentAt: Date | string | null;
  attempts: number;
}

/** Monday = 1 … Sunday = 7. */
function isoWeekday(ymd: string): number {
  const d = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * Whether a schedule should send now. Today must be one of its days and the Berlin clock past its
 * time (at-or-after, so a worker that was down at the mark still sends late). A day already claimed
 * is due again only while unsent and under `MAX_ATTEMPTS`.
 */
export function isScheduleDue(s: ScheduleState, local: LocalNow): boolean {
  if (!s.active) return false;
  if (local.hour * 60 + local.minute < s.hour * 60 + s.minute) return false;
  const wd = isoWeekday(local.date);
  if (s.cadence === "weekdays" && wd > 5) return false;
  if (s.cadence === "weekly" && wd !== (s.weekday ?? 1)) return false;
  if (s.cadence === "monthly" && Number(local.date.slice(8, 10)) !== (s.monthDay ?? 1))
    return false;
  if (s.runDate !== local.date) return true;
  return s.sentAt == null && s.attempts < MAX_ATTEMPTS;
}

/** "Every day 10:00", "Weekly Mon 09:30", "Monthly on the 1st 10:00". */
export function cadenceLabel(s: {
  cadence: string;
  weekday: number | null;
  monthDay: number | null;
  hour: number;
  minute: number;
}): string {
  const at = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
  if (s.cadence === "weekly") return `Weekly ${WEEKDAYS[(s.weekday ?? 1) - 1]} ${at}`;
  if (s.cadence === "monthly") {
    const d = s.monthDay ?? 1;
    const suffix =
      d % 10 === 1 && d !== 11
        ? "st"
        : d % 10 === 2 && d !== 12
          ? "nd"
          : d % 10 === 3 && d !== 13
            ? "rd"
            : "th";
    return `Monthly on the ${d}${suffix} ${at}`;
  }
  return `${CADENCES.find((c) => c.key === s.cadence)?.label ?? s.cadence} ${at}`;
}

/** A Telegram chat id: a user/group id, or a `-100…` channel/supergroup id. */
export const CHAT_ID_PATTERN = /^-?\d{1,20}$/;
