import { randomUUID } from "node:crypto";
import { asc, desc, eq, isNull } from "drizzle-orm";
import { getRequestHost } from "@tanstack/react-start/server";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { CHAT_ID_PATTERN, reportedDay } from "@/lib/adset-report";
import { berlinNow } from "@/lib/berlin-time";
import { env } from "@/lib/env";
import { isImportHost } from "@/lib/import-host";
import type { ReportDoc } from "@/lib/report-export";
import { buildAdsetReport, type AdsetReport } from "@/server/adset-report";
import { deliverAdsetReport } from "@/sync/jobs/adset-reports";
import { telegram } from "@/sync/jobs/checkin";
import { audit, requireAdmin } from "./auth";

/**
 * The daily ad-set CSV reports page (`/adset-reports`). Like the CSV import, every entry point is
 * IMPORT_HOSTS-only (the droplet's bare IP) and admin-only, and is a server fn rather than an op on
 * purpose: ops are also served on `/api/v1`, which would put this on the domains.
 */

export interface AdsetScheduleView {
  id: string;
  clientId: string;
  clientName: string;
  chatId: string;
  chatLabel: string;
  hour: number;
  minute: number;
  active: boolean;
  runDate: string | null;
  sentAt: string | null;
  attempts: number;
  lastError: string | null;
}

export interface AdsetReportsPageData {
  schedules: AdsetScheduleView[];
  clients: { id: string; name: string }[];
  chats: { chatId: string; label: string }[];
  /** The day a send right now would report (Berlin yesterday). */
  reportedDay: string;
  botConfigured: boolean;
}

/** Host first, so a domain answers "Not found" whoever is signed in. */
async function guard() {
  if (!isImportHost(getRequestHost(), env().IMPORT_HOSTS)) throw new Error("Not found");
  return requireAdmin();
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.");

export async function fetchAdsetReportsPage(): Promise<AdsetReportsPageData> {
  await guard();
  const [schedules, clients, chats, tg] = await Promise.all([
    db
      .select({ s: schema.adsetReportSchedules, clientName: schema.clients.name })
      .from(schema.adsetReportSchedules)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.adsetReportSchedules.clientId))
      .orderBy(asc(schema.clients.name), asc(schema.adsetReportSchedules.createdAt)),
    db
      .select({ id: schema.clients.id, name: schema.clients.name })
      .from(schema.clients)
      .where(isNull(schema.clients.removedAt))
      .orderBy(asc(schema.clients.name)),
    db.select().from(schema.telegramChats).orderBy(desc(schema.telegramChats.lastSeenAt)),
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
    schedules: schedules.map(({ s, clientName }) => ({
      id: s.id,
      clientId: s.clientId,
      clientName,
      chatId: s.chatId,
      chatLabel: labelOf.get(s.chatId) ?? s.chatId,
      hour: s.hour,
      minute: s.minute,
      active: s.active,
      runDate: s.runDate,
      sentAt: s.sentAt?.toISOString() ?? null,
      attempts: s.attempts,
      lastError: s.lastError,
    })),
    clients,
    chats: chatOptions,
    reportedDay: reportedDay(berlinNow(new Date())),
    botConfigured: tg !== null,
  };
}

const previewInput = z.object({ clientId: z.string().min(1).max(200), date: ymd });

export async function previewAdsetReport(
  input: unknown,
): Promise<{ doc: ReportDoc; totals: AdsetReport["totals"] }> {
  await guard();
  const { clientId, date } = previewInput.parse(input);
  const r = await buildAdsetReport(clientId, date);
  if ("error" in r) throw new Error(r.error);
  return { doc: r.doc, totals: r.totals };
}

const saveInput = z.object({
  id: z.string().uuid().nullish(),
  clientId: z.string().min(1).max(200),
  chatId: z.string().trim().regex(CHAT_ID_PATTERN, "A Telegram chat id is digits, e.g. 347759628."),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  active: z.boolean(),
});

/**
 * Create or update a schedule. The chat is checked with `getChat` first: the bot can only message a
 * chat that has started it (or a group it is in), and finding that out at 10:00 tomorrow is too late.
 */
export async function saveAdsetReportSchedule(input: unknown): Promise<{ id: string }> {
  const me = await guard();
  const v = saveInput.parse(input);
  const [client] = await db
    .select({ name: schema.clients.name })
    .from(schema.clients)
    .where(eq(schema.clients.id, v.clientId));
  if (!client) throw new Error("Unknown client.");
  const tg = await telegram();
  if (!tg) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN).");
  const chat = await tg.getChat(v.chatId);
  if (!chat.ok) {
    throw new Error(
      `The bot cannot reach chat ${v.chatId} (${chat.error}). Send /start to the bot from that ` +
        `account, or add the bot to the group, then save again.`,
    );
  }

  const values = {
    clientId: v.clientId,
    chatId: v.chatId,
    hour: v.hour,
    minute: v.minute,
    active: v.active,
    updatedAt: new Date(),
  };
  let id = v.id ?? null;
  if (id) {
    const updated = await db
      .update(schema.adsetReportSchedules)
      .set(values)
      .where(eq(schema.adsetReportSchedules.id, id))
      .returning({ id: schema.adsetReportSchedules.id });
    if (updated.length === 0) throw new Error("That schedule no longer exists.");
  } else {
    id = randomUUID();
    await db.insert(schema.adsetReportSchedules).values({ id, ...values, createdBy: me.email });
  }
  const at = `${String(v.hour).padStart(2, "0")}:${String(v.minute).padStart(2, "0")}`;
  await audit(
    "adset_report.save",
    `${client.name} → chat ${v.chatId} at ${at} Berlin${v.active ? "" : " (paused)"} [${id}]`,
  );
  return { id };
}

const idInput = z.object({ id: z.string().uuid() });

export async function deleteAdsetReportSchedule(input: unknown): Promise<{ ok: true }> {
  await guard();
  const { id } = idInput.parse(input);
  const [gone] = await db
    .delete(schema.adsetReportSchedules)
    .where(eq(schema.adsetReportSchedules.id, id))
    .returning({
      clientId: schema.adsetReportSchedules.clientId,
      chatId: schema.adsetReportSchedules.chatId,
    });
  if (gone) await audit("adset_report.delete", `${gone.clientId} → chat ${gone.chatId} [${id}]`);
  return { ok: true };
}

const sendInput = z.object({ id: z.string().uuid(), date: ymd });

/**
 * Send one schedule's report for `date` right now. Deliberately leaves the schedule's claim columns
 * alone: a manual send is extra, and must neither stand in for nor block the scheduled one.
 */
export async function sendAdsetReportNow(input: unknown): Promise<{ adSets: number }> {
  await guard();
  const { id, date } = sendInput.parse(input);
  const [s] = await db
    .select()
    .from(schema.adsetReportSchedules)
    .where(eq(schema.adsetReportSchedules.id, id));
  if (!s) throw new Error("That schedule no longer exists.");
  const r = await deliverAdsetReport(s, date);
  if (!r.ok) throw new Error(r.error);
  await audit("adset_report.send", `${s.clientId} ${date} → chat ${s.chatId} [${id}]`);
  return { adSets: r.adSets };
}
