import { randomUUID } from "node:crypto";
import { asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getRequestHost } from "@tanstack/react-start/server";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { berlinNow } from "@/lib/berlin-time";
import { DATE_PRESETS } from "@/lib/date-presets";
import { env } from "@/lib/env";
import { isImportHost } from "@/lib/import-host";
import { metric } from "@/lib/report-catalog";
import {
  CHAT_ID_PATTERN,
  IDENTITY_COLUMNS,
  NO_ADJUSTMENTS,
  SPLITTABLE_BREAKDOWNS,
  type ReportRecipe,
} from "@/lib/scheduled-report";
import { isTimeIncrement, resolveTimeIncrement } from "@/lib/time-increment";
import { REPORT_DIMS, type ReportPayload } from "@/server/agent/report";
import { loadClientScope } from "@/server/report-scope";
import { buildRecipeReport, FILE_MAX_ROWS } from "@/server/scheduled-report";
import { getClientRow } from "@/sync/jobs/clients";
import { telegram } from "@/sync/jobs/checkin";
import { deliverReport, scheduleFileNaming, scheduleRecipe } from "@/sync/jobs/telegram-reports";
import { audit, requireAdmin } from "./auth";

/**
 * The scheduled Telegram reports page (`/scheduled-reports`). Like the CSV import, every entry point
 * is IMPORT_HOSTS-only (the droplet's bare IP) and admin-only, and is a server fn rather than an op on
 * purpose: ops are also served on `/api/v1`, which would put this on the domains.
 */

export interface ScheduleView {
  id: string;
  name: string;
  clientName: string;
  /** Always a preset range: schedules resolve it on the day they send. */
  recipe: ReportRecipe;
  chatId: string;
  chatLabel: string;
  cadence: string;
  weekday: number | null;
  monthDay: number | null;
  hour: number;
  minute: number;
  active: boolean;
  runDate: string | null;
  sentAt: string | null;
  attempts: number;
  lastError: string | null;
  /** The schedule's own file name, or null for the generated one. */
  filename: string | null;
  /** Append "_modeled" to a modeled report's file name. */
  filenameModeled: boolean;
}

/** One of this page's saved recipes — separate from the Report Builder's templates. */
export interface TemplateOption {
  id: string;
  name: string;
  recipe: ReportRecipe;
}

export interface ScheduledReportsPageData {
  schedules: ScheduleView[];
  clients: { id: string; name: string; accountCount: number }[];
  chats: { chatId: string; label: string }[];
  templates: TemplateOption[];
  /** Berlin date presets resolve against, for the page's range labels. */
  today: string;
  botConfigured: boolean;
}

export interface ScopeView {
  brands: { key: string; title: string; status: string | null; accountCount: number }[];
  campaigns: { id: string; name: string; brand: string | null }[];
  /** Distinct ad set names in the client's campaigns, for the rename picker. */
  adSetNames: string[];
}

/** Host first, so a domain answers "Not found" whoever is signed in. */
async function guard() {
  if (!isImportHost(getRequestHost(), env().IMPORT_HOSTS)) throw new Error("Not found");
  return requireAdmin();
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const today = () => berlinNow(new Date()).date;

export async function fetchScheduledReportsPage(): Promise<ScheduledReportsPageData> {
  await guard();
  const s = schema.telegramReportSchedules;
  const [schedules, clients, chats, templates, tg] = await Promise.all([
    db
      .select({ s, clientName: schema.clients.name })
      .from(s)
      .innerJoin(schema.clients, eq(schema.clients.id, s.clientId))
      .orderBy(asc(s.name), asc(s.createdAt)),
    db
      .select({
        id: schema.clients.id,
        name: schema.clients.name,
        accountCount: sql<number>`jsonb_array_length(coalesce(${schema.clients.notionAccountIds}, '[]'::jsonb)) + jsonb_array_length(coalesce(${schema.clients.manualAddIds}, '[]'::jsonb))`,
      })
      .from(schema.clients)
      .where(isNull(schema.clients.removedAt))
      .orderBy(asc(schema.clients.name)),
    db.select().from(schema.telegramChats).orderBy(desc(schema.telegramChats.lastSeenAt)),
    db
      .select()
      .from(schema.telegramReportTemplates)
      .orderBy(asc(schema.telegramReportTemplates.name)),
    telegram(),
  ]);
  const chatOptions = chats.map((c) => ({
    chatId: c.chatId,
    label: c.chatId.startsWith("-")
      ? `Group ${c.chatId}`
      : `${c.firstName ?? "User"}${c.username ? ` (@${c.username})` : ""} · ${c.chatId}`,
  }));
  const labelOf = new Map(chatOptions.map((c) => [c.chatId, c.label]));
  return {
    schedules: schedules.map(({ s: r, clientName }) => ({
      id: r.id,
      name: r.name,
      clientName,
      recipe: scheduleRecipe(r),
      filename: r.filename,
      filenameModeled: r.filenameModeled,
      chatId: r.chatId,
      chatLabel: labelOf.get(r.chatId) ?? r.chatId,
      cadence: r.cadence,
      weekday: r.weekday,
      monthDay: r.monthDay,
      hour: r.hour,
      minute: r.minute,
      active: r.active,
      runDate: r.runDate,
      sentAt: r.sentAt?.toISOString() ?? null,
      attempts: r.attempts,
      lastError: r.lastError,
    })),
    clients: clients.map((c) => ({ ...c, accountCount: Number(c.accountCount) })),
    chats: chatOptions,
    templates: templates.flatMap((t) => {
      // A template saved under an older recipe shape is skipped rather than loaded half-broken.
      const r = recipeSchema.safeParse(t.recipe);
      return r.success ? [{ id: t.id, name: t.name, recipe: toRecipe(r.data) }] : [];
    }),
    today: today(),
    botConfigured: tg !== null,
  };
}

const clientInput = z.object({ clientId: z.string().min(1).max(200) });

/** A client's brands and campaigns (each with its brand), for the builder's pickers. */
export async function fetchReportScope(input: unknown): Promise<ScopeView> {
  await guard();
  const { clientId } = clientInput.parse(input);
  const client = await getClientRow(clientId);
  if (!client) throw new Error("Unknown client.");
  const scope = await loadClientScope(client);
  const inScope = new Set(scope.campaigns.map((c) => c.id));
  const sets = scope.accountIds.length
    ? await db
        .select({ name: schema.adSets.name, campaignId: schema.adSets.campaignId })
        .from(schema.adSets)
        .where(inArray(schema.adSets.accountId, scope.accountIds))
    : [];
  return {
    brands: scope.brands.map((b) => ({
      key: b.key,
      title: b.title,
      status: b.status,
      accountCount: b.accountIds.length,
    })),
    campaigns: scope.campaigns.map((c) => ({ id: c.id, name: c.name, brand: c.brand })),
    adSetNames: [...new Set(sets.filter((s) => inScope.has(s.campaignId)).map((s) => s.name))].sort(
      (a, b) => a.localeCompare(b),
    ),
  };
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const presetKey = z
  .string()
  .refine((k) => DATE_PRESETS.some((p) => p.key === k), "Unknown date range.");

const names = z
  .record(z.string().max(300), z.string().trim().max(200))
  .refine((m) => Object.keys(m).length <= 2000, "Too many renames.");

const adjustmentsSchema = z.object({
  campaignNames: names,
  adSetNames: names,
  columnLabels: names,
  split: z
    .object({
      percent: z.number().gt(0, "Split more than 0%.").lt(100, "Split less than 100%."),
      campaign: z.string().trim().min(1, "Name the campaign the split goes to.").max(200),
    })
    .nullable(),
});

const recipeSchema = z
  .object({
    clientId: z.string().min(1).max(200),
    brands: z.array(z.string().max(300)).max(100),
    campaignIds: z.array(z.string().max(40)).max(2000),
    columns: z
      .array(
        z
          .string()
          .refine(
            (k) => metric(k) !== undefined || IDENTITY_COLUMNS.some((c) => c.key === k),
            "Unknown column.",
          ),
      )
      .max(150)
      .refine((ks) => ks.some((k) => metric(k) !== undefined), "Pick at least one metric column."),
    breakdown: z.string().refine((b) => b === "none" || b in REPORT_DIMS, "Unknown breakdown."),
    timeIncrement: z.string().refine(isTimeIncrement, "Unknown granularity."),
    markup: z.number().min(0).max(5).nullable(),
    modeled: z.boolean(),
    range: z.union([
      z.object({ preset: presetKey }),
      z
        .object({ since: ymd, until: ymd })
        .refine((r) => r.since <= r.until, "The range ends before it starts."),
    ]),
    // Templates saved before adjustments existed have none.
    adjustments: adjustmentsSchema.default(NO_ADJUSTMENTS),
  })
  .refine(
    (r) => !r.adjustments.split || SPLITTABLE_BREAKDOWNS.includes(r.breakdown),
    "A split needs a campaign, ad set or ad breakdown.",
  )
  .refine(
    (r) => !r.adjustments.split || r.columns.includes("dim:campaign"),
    "A split needs the Campaign column, or its rows cannot be told apart.",
  );

const toRecipe = (r: z.infer<typeof recipeSchema>): ReportRecipe => ({
  ...r,
  timeIncrement: resolveTimeIncrement(r.timeIncrement),
});

const parseRecipe = (v: unknown): ReportRecipe => toRecipe(recipeSchema.parse(v));

/** A file name as typed: blank = generated. Tokens and sanitising are `reportFilename`'s. */
const filenameInput = z
  .string()
  .trim()
  .max(200)
  .nullish()
  .transform((s) => s || null);

const previewInput = z.object({
  recipe: z.unknown(),
  filename: filenameInput,
  filenameModeled: z.boolean().default(false),
});

/** Run the builder's recipe as of today (Berlin), for the preview and the CSV/PDF downloads. */
export async function previewRecipe(input: unknown): Promise<ReportPayload> {
  await guard();
  const v = previewInput.parse(input);
  const r = await buildRecipeReport(parseRecipe(v.recipe), today(), FILE_MAX_ROWS, {
    name: v.filename,
    markModeled: v.filenameModeled,
  });
  if ("error" in r) throw new Error(r.error);
  return r;
}

const chatId = z
  .string()
  .trim()
  .regex(CHAT_ID_PATTERN, "A Telegram chat id is digits, e.g. 347759628.");

const saveInput = z
  .object({
    id: z.string().uuid().nullish(),
    name: z.string().trim().min(1, "Name the schedule.").max(120),
    recipe: z.unknown(),
    chatId,
    cadence: z.enum(["daily", "weekdays", "weekly", "monthly"]),
    weekday: z.number().int().min(1).max(7).nullable(),
    monthDay: z.number().int().min(1).max(28).nullable(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    active: z.boolean(),
    filename: filenameInput,
    filenameModeled: z.boolean().default(false),
  })
  .refine((v) => v.cadence !== "weekly" || v.weekday !== null, "Pick the weekday.")
  .refine((v) => v.cadence !== "monthly" || v.monthDay !== null, "Pick the day of the month.");

/** The bot can only message a chat that started it (or a group it is in); find out now, not at 10:00. */
async function checkChat(id: string): Promise<void> {
  const tg = await telegram();
  if (!tg) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN).");
  const chat = await tg.getChat(id);
  if (!chat.ok)
    throw new Error(
      `The bot cannot reach chat ${id} (${chat.error}). Send /start to the bot from that account, ` +
        `or add the bot to the group, then try again.`,
    );
}

export async function saveScheduledReport(input: unknown): Promise<{ id: string }> {
  const me = await guard();
  const v = saveInput.parse(input);
  const recipe = parseRecipe(v.recipe);
  if (!("preset" in recipe.range))
    throw new Error(
      "A schedule needs a relative range (e.g. Yesterday, Last week) — fixed dates would resend the same window forever.",
    );
  const client = await getClientRow(recipe.clientId);
  if (!client) throw new Error("Unknown client.");
  await checkChat(v.chatId);

  const values = {
    name: v.name,
    clientId: recipe.clientId,
    brands: recipe.brands,
    campaignIds: recipe.campaignIds,
    columns: recipe.columns,
    breakdown: recipe.breakdown,
    timeIncrement: recipe.timeIncrement,
    rangePreset: recipe.range.preset,
    markup: recipe.markup,
    modeled: recipe.modeled,
    adjustments: recipe.adjustments,
    filename: v.filename,
    filenameModeled: v.filenameModeled,
    chatId: v.chatId,
    cadence: v.cadence,
    weekday: v.cadence === "weekly" ? v.weekday : null,
    monthDay: v.cadence === "monthly" ? v.monthDay : null,
    hour: v.hour,
    minute: v.minute,
    active: v.active,
    updatedAt: new Date(),
  };
  const t = schema.telegramReportSchedules;
  let id = v.id ?? null;
  if (id) {
    const updated = await db.update(t).set(values).where(eq(t.id, id)).returning({ id: t.id });
    if (updated.length === 0) throw new Error("That schedule no longer exists.");
  } else {
    id = randomUUID();
    await db.insert(t).values({ id, ...values, createdBy: me.email });
  }
  await audit(
    "telegram_report.save",
    `"${v.name}" ${client.name} → chat ${v.chatId}${v.active ? "" : " (paused)"} [${id}]`,
  );
  return { id };
}

const idInput = z.object({ id: z.string().uuid() });

/** Pause or resume without re-validating the whole recipe. */
export async function setScheduledReportActive(input: unknown): Promise<{ ok: true }> {
  await guard();
  const { id, active } = idInput.extend({ active: z.boolean() }).parse(input);
  const t = schema.telegramReportSchedules;
  const [row] = await db
    .update(t)
    .set({ active, updatedAt: new Date() })
    .where(eq(t.id, id))
    .returning({ name: t.name });
  if (!row) throw new Error("That schedule no longer exists.");
  await audit("telegram_report.active", `"${row.name}" ${active ? "resumed" : "paused"} [${id}]`);
  return { ok: true };
}

export async function deleteScheduledReport(input: unknown): Promise<{ ok: true }> {
  await guard();
  const { id } = idInput.parse(input);
  const t = schema.telegramReportSchedules;
  const [gone] = await db
    .delete(t)
    .where(eq(t.id, id))
    .returning({ name: t.name, chatId: t.chatId });
  if (gone) await audit("telegram_report.delete", `"${gone.name}" → chat ${gone.chatId} [${id}]`);
  return { ok: true };
}

/**
 * Send a saved schedule's report now. Deliberately leaves its claim columns alone: a manual send is
 * extra, and must neither stand in for nor block the scheduled one.
 */
export async function sendScheduledReportNow(input: unknown): Promise<{ rows: number }> {
  await guard();
  const { id } = idInput.parse(input);
  const t = schema.telegramReportSchedules;
  const [s] = await db.select().from(t).where(eq(t.id, id));
  if (!s) throw new Error("That schedule no longer exists.");
  const r = await deliverReport(
    s.name,
    scheduleRecipe(s),
    s.chatId,
    today(),
    scheduleFileNaming(s),
  );
  if (!r.ok) throw new Error(r.error);
  await audit("telegram_report.send", `"${s.name}" → chat ${s.chatId} [${id}]`);
  return { rows: r.rows };
}

const draftInput = z.object({
  name: z.string().trim().min(1).max(120),
  recipe: z.unknown(),
  chatId,
  filename: filenameInput,
  filenameModeled: z.boolean().default(false),
});

/** Send the builder's current recipe once, without saving it — custom dates allowed. */
export async function sendDraftReport(input: unknown): Promise<{ rows: number }> {
  await guard();
  const v = draftInput.parse(input);
  const recipe = parseRecipe(v.recipe);
  await checkChat(v.chatId);
  const r = await deliverReport(v.name, recipe, v.chatId, today(), {
    name: v.filename,
    markModeled: v.filenameModeled,
  });
  if (!r.ok) throw new Error(r.error);
  await audit(
    "telegram_report.send",
    `"${v.name}" (unsaved) ${recipe.clientId} → chat ${v.chatId}`,
  );
  return { rows: r.rows };
}

const templateInput = z.object({
  id: z.string().uuid().nullish(),
  name: z.string().trim().min(1, "Name the template.").max(120),
  recipe: z.unknown(),
});

/** Create or update one of this page's own templates (never the Report Builder's). */
export async function saveReportTemplate(input: unknown): Promise<{ id: string }> {
  const me = await guard();
  const v = templateInput.parse(input);
  const recipe = parseRecipe(v.recipe);
  const t = schema.telegramReportTemplates;
  let id = v.id ?? null;
  if (id) {
    const updated = await db
      .update(t)
      .set({ name: v.name, recipe, updatedAt: new Date() })
      .where(eq(t.id, id))
      .returning({ id: t.id });
    if (updated.length === 0) throw new Error("That template no longer exists.");
  } else {
    id = randomUUID();
    await db.insert(t).values({ id, name: v.name, recipe, createdBy: me.email });
  }
  await audit("telegram_report.template_save", `"${v.name}" [${id}]`);
  return { id };
}

export async function deleteReportTemplate(input: unknown): Promise<{ ok: true }> {
  await guard();
  const { id } = idInput.parse(input);
  const t = schema.telegramReportTemplates;
  const [gone] = await db.delete(t).where(eq(t.id, id)).returning({ name: t.name });
  if (gone) await audit("telegram_report.template_delete", `"${gone.name}" [${id}]`);
  return { ok: true };
}
