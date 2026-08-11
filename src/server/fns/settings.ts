import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import {
  getCredentials,
  saveCredentials,
  saveNotionCredentials,
  saveChatCredentials,
} from "@/lib/credentials";
import { DEFAULT_CHAT_MODEL, DEFAULT_CHAT_EFFORT } from "@/lib/chat-options";
import { MetaClient } from "@/meta/client";
import { isCycleRunning } from "@/sync/cycle";
import { syncClients } from "@/sync/jobs/clients";
import { syncNotionDailyBudgets } from "@/sync/jobs/notion-budget";
import { parseNotionDbId } from "@/notion/client";
import { requireAdmin, audit } from "./auth";
import { getRecentSyncEvents } from "@/sync/state";

export interface SettingsView {
  appId: string;
  businessId: string;
  accountIds: string[];
  apiVersion: string;
  hasSecret: boolean;
  hasToken: boolean;
  token: { isValid: boolean; scopes: string[]; checkedAt: string | null } | null;
  sync: { accounts: number; lastInsightsSync: string | null; errors: number } | null;
  syncRunning: boolean;
  notion: { configured: boolean; dbId: string; clients: number; lastSync: string | null };
  chat: { configured: boolean; model: string; effort: string };
  health: {
    rateLimitedLastHour: number;
    events: {
      at: string;
      kind: string;
      code: number;
      accountId: string | null;
      message: string;
      retryAfterMin: number | null;
      pressure: number | null;
    }[];
    accountErrors: { accountId: string; error: string; at: string | null }[];
  };
}

export interface CredsForm {
  appId: string;
  appSecret?: string;
  token?: string;
  businessId: string;
  accountIds: string;
}

export async function fetchSettings(): Promise<SettingsView> {
  await requireAdmin();
  const [cred] = await db
    .select()
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.id, "singleton"));
  const [health] = await db
    .select()
    .from(schema.tokenHealth)
    .where(eq(schema.tokenHealth.id, "singleton"));
  const states = await db.select().from(schema.syncState);
  const clientRows = await db.select({ syncedAt: schema.clients.syncedAt }).from(schema.clients);
  const events = await getRecentSyncEvents(50);
  const hourAgo = Date.now() - 3_600_000;
  return {
    appId: cred?.appId ?? "",
    businessId: cred?.businessId ?? "",
    accountIds: (cred?.accountIds as string[] | null) ?? [],
    apiVersion: cred?.apiVersion ?? "v25.0",
    hasSecret: Boolean(cred?.appSecretEnc),
    hasToken: Boolean(cred?.systemUserTokenEnc),
    token: health
      ? {
          isValid: health.isValid,
          scopes: (health.scopes as string[] | null) ?? [],
          checkedAt: health.checkedAt?.toISOString() ?? null,
        }
      : null,
    sync: states.length
      ? {
          accounts: states.length,
          lastInsightsSync:
            states
              .map((s) => s.lastInsightsSync?.toISOString() ?? "")
              .sort()
              .at(-1) || null,
          errors: states.filter((s) => s.status === "error").length,
        }
      : null,
    syncRunning: isCycleRunning(),
    notion: {
      configured: Boolean(cred?.notionTokenEnc && cred?.notionDbId),
      dbId: cred?.notionDbId ?? "",
      clients: clientRows.length,
      lastSync:
        clientRows
          .map((c) => c.syncedAt?.toISOString() ?? "")
          .sort()
          .at(-1) || null,
    },
    chat: {
      configured: Boolean(cred?.anthropicTokenEnc),
      model: cred?.chatModel ?? DEFAULT_CHAT_MODEL,
      effort: cred?.chatEffort ?? DEFAULT_CHAT_EFFORT,
    },
    health: {
      rateLimitedLastHour: events.filter(
        (e) => e.kind === "rate_limit" && e.at.getTime() >= hourAgo,
      ).length,
      events: events.map((e) => ({
        at: e.at.toISOString(),
        kind: e.kind,
        code: e.code,
        accountId: e.accountId,
        message: e.message,
        retryAfterMin: e.retryAfterMin,
        pressure: e.pressure,
      })),
      accountErrors: states
        .filter((s) => s.status === "error" && s.lastError)
        .map((s) => ({
          accountId: s.accountId,
          error: s.lastError as string,
          at: (s.lastInsightsSync ?? s.lastStructureSync)?.toISOString() ?? null,
        })),
    },
  };
}

export async function saveChatForm(data: {
  token?: string;
  model: string;
  effort: string;
}): Promise<{ ok: true }> {
  await requireAdmin();
  await saveChatCredentials(data.token?.trim() ?? "", data.model, data.effort);
  await audit("settings.chat", "saved assistant (Claude) settings");
  return { ok: true };
}

export async function saveCredentialsFormData(data: CredsForm): Promise<{ ok: true }> {
  await requireAdmin();
  const existing = await getCredentials();
  // Secrets are write-only from the UI: keep the stored secret if the field is left blank.
  const appSecret = data.appSecret?.trim() || existing?.appSecret || "";
  const token = data.token?.trim() || existing?.token || "";
  await saveCredentials({
    appId: data.appId.trim(),
    appSecret,
    token,
    businessId: data.businessId.trim(),
    accountIds: data.accountIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
  await audit("settings.meta", "saved Meta credentials");
  return { ok: true };
}

export async function runTestConnection(): Promise<{
  isValid: boolean;
  scopes: string[];
  error?: string;
}> {
  await requireAdmin();
  const creds = await getCredentials();
  if (!creds) return { isValid: false, scopes: [], error: "No credentials saved" };
  try {
    const client = new MetaClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      token: creds.token,
      version: creds.apiVersion,
    });
    const d = await client.debugToken();
    await db
      .insert(schema.tokenHealth)
      .values({
        id: "singleton",
        checkedAt: new Date(),
        isValid: d.is_valid,
        scopes: d.scopes,
        note: null,
      })
      .onConflictDoUpdate({
        target: schema.tokenHealth.id,
        set: { checkedAt: new Date(), isValid: d.is_valid, scopes: d.scopes, note: null },
      });
    return { isValid: d.is_valid, scopes: d.scopes };
  } catch (e) {
    return { isValid: false, scopes: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function saveNotionForm(data: {
  token?: string;
  board: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const dbId = parseNotionDbId(data.board);
  if (!dbId) return { ok: false, error: "Could not find a database id in that URL" };
  await saveNotionCredentials(data.token?.trim() ?? "", dbId);
  await audit("settings.notion", "saved Notion settings");
  return { ok: true };
}

export async function runNotionSync(): Promise<{
  ok: boolean;
  clients?: number;
  budgets?: number;
  error?: string;
}> {
  await requireAdmin();
  try {
    const n = await syncClients();
    if (n === null) return { ok: false, error: "Notion is not configured" };
    // Reading the mapping and writing back the auto-updated daily-budget column are two halves of the
    // same board sync. The push needs no Meta call — it sums structure rows already in Postgres.
    const b = await syncNotionDailyBudgets();
    await audit(
      "sync.notion",
      `synced ${n} clients from Notion; wrote ${b?.updated ?? 0} board cell(s)`,
    );
    return { ok: true, clients: n, budgets: b?.updated ?? 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
