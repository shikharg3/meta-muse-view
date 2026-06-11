import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getCredentials, saveCredentials } from "@/lib/credentials";
import { MetaClient } from "@/meta/client";
import { isCycleRunning } from "@/sync/cycle";

export interface SettingsView {
  appId: string; businessId: string; accountIds: string[]; apiVersion: string;
  hasSecret: boolean; hasToken: boolean;
  token: { isValid: boolean; scopes: string[]; checkedAt: string | null } | null;
  sync: { accounts: number; lastInsightsSync: string | null; errors: number } | null;
  syncRunning: boolean;
}

export interface CredsForm { appId: string; appSecret?: string; token?: string; businessId: string; accountIds: string; }

export async function fetchSettings(): Promise<SettingsView> {
  const [cred] = await db.select().from(schema.metaCredentials).where(eq(schema.metaCredentials.id, "singleton"));
  const [health] = await db.select().from(schema.tokenHealth).where(eq(schema.tokenHealth.id, "singleton"));
  const states = await db.select().from(schema.syncState);
  return {
    appId: cred?.appId ?? "",
    businessId: cred?.businessId ?? "",
    accountIds: (cred?.accountIds as string[] | null) ?? [],
    apiVersion: cred?.apiVersion ?? "v25.0",
    hasSecret: Boolean(cred?.appSecretEnc),
    hasToken: Boolean(cred?.systemUserTokenEnc),
    token: health
      ? { isValid: health.isValid, scopes: (health.scopes as string[] | null) ?? [], checkedAt: health.checkedAt?.toISOString() ?? null }
      : null,
    sync: states.length
      ? {
          accounts: states.length,
          lastInsightsSync: states.map((s) => s.lastInsightsSync?.toISOString() ?? "").sort().at(-1) || null,
          errors: states.filter((s) => s.status === "error").length,
        }
      : null,
    syncRunning: isCycleRunning(),
  };
}

export async function saveCredentialsFormData(data: CredsForm): Promise<{ ok: true }> {
  const existing = await getCredentials();
  // Secrets are write-only from the UI: keep the stored secret if the field is left blank.
  const appSecret = data.appSecret?.trim() || existing?.appSecret || "";
  const token = data.token?.trim() || existing?.token || "";
  await saveCredentials({
    appId: data.appId.trim(),
    appSecret,
    token,
    businessId: data.businessId.trim(),
    accountIds: data.accountIds.split(",").map((s) => s.trim()).filter(Boolean),
  });
  return { ok: true };
}

export async function runTestConnection(): Promise<{ isValid: boolean; scopes: string[]; error?: string }> {
  const creds = await getCredentials();
  if (!creds) return { isValid: false, scopes: [], error: "No credentials saved" };
  try {
    const client = new MetaClient({ appId: creds.appId, appSecret: creds.appSecret, token: creds.token, version: creds.apiVersion });
    const d = await client.debugToken();
    await db.insert(schema.tokenHealth)
      .values({ id: "singleton", checkedAt: new Date(), isValid: d.is_valid, scopes: d.scopes, note: null })
      .onConflictDoUpdate({ target: schema.tokenHealth.id, set: { checkedAt: new Date(), isValid: d.is_valid, scopes: d.scopes, note: null } });
    return { isValid: d.is_valid, scopes: d.scopes };
  } catch (e) {
    return { isValid: false, scopes: [], error: e instanceof Error ? e.message : String(e) };
  }
}

