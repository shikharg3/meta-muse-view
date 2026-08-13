import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env, type Env } from "@/lib/env";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import {
  CHAT_MODELS,
  CHAT_EFFORTS,
  DEFAULT_CHAT_MODEL,
  DEFAULT_CHAT_EFFORT,
} from "@/lib/chat-options";

export interface Credentials {
  appId: string;
  appSecret: string;
  token: string;
  businessId: string;
  accountIds: string[];
  apiVersion: string;
}

export interface CredentialsInput {
  appId: string;
  appSecret: string;
  token: string;
  businessId: string;
  accountIds: string[];
  apiVersion?: string;
}

export async function saveCredentials(input: CredentialsInput): Promise<void> {
  const key = env().APP_ENCRYPTION_KEY;
  const row = {
    id: "singleton",
    appId: input.appId,
    appSecretEnc: input.appSecret ? encryptSecret(input.appSecret, key) : null,
    systemUserTokenEnc: input.token ? encryptSecret(input.token, key) : null,
    businessId: input.businessId,
    accountIds: input.accountIds,
    apiVersion: input.apiVersion ?? "v25.0",
    updatedAt: new Date(),
  };
  await db
    .insert(schema.metaCredentials)
    .values(row)
    .onConflictDoUpdate({ target: schema.metaCredentials.id, set: row });
  // A credential change may be a swap to a different (possibly dev-tier) app. Reset the observed
  // access tier so the next sync starts on conservative pacing until it re-observes the real tier.
  await db
    .update(schema.tokenHealth)
    .set({ tier: null })
    .where(eq(schema.tokenHealth.id, "singleton"));
}

export async function getCredentials(): Promise<Credentials | null> {
  const key = env().APP_ENCRYPTION_KEY;
  const [row] = await db
    .select()
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.id, "singleton"));

  if (row?.systemUserTokenEnc) {
    return {
      appId: row.appId ?? "",
      appSecret: row.appSecretEnc ? decryptSecret(row.appSecretEnc, key) : "",
      token: decryptSecret(row.systemUserTokenEnc, key),
      businessId: row.businessId ?? "",
      accountIds: (row.accountIds as string[] | null) ?? [],
      apiVersion: row.apiVersion ?? "v25.0",
    };
  }

  const e = env();
  if (e.META_SYSTEM_USER_TOKEN) {
    return {
      appId: e.META_APP_ID ?? "",
      appSecret: e.META_APP_SECRET ?? "",
      token: e.META_SYSTEM_USER_TOKEN,
      businessId: e.META_BUSINESS_ID ?? "",
      accountIds: e.META_AD_ACCOUNT_IDS ?? [],
      apiVersion: e.META_API_VERSION,
    };
  }
  return null;
}

export interface NotionCredentials {
  token: string;
  dbId: string;
}

/** Notion fields live on the same singleton row; blank token keeps the stored one. */
export async function saveNotionCredentials(token: string, dbId: string): Promise<void> {
  const key = env().APP_ENCRYPTION_KEY;
  const set: Record<string, unknown> = { notionDbId: dbId, updatedAt: new Date() };
  if (token) set.notionTokenEnc = encryptSecret(token, key);
  await db
    .insert(schema.metaCredentials)
    .values({ id: "singleton", ...set })
    .onConflictDoUpdate({ target: schema.metaCredentials.id, set });
}

export async function getNotionCredentials(): Promise<NotionCredentials | null> {
  const [row] = await db
    .select({
      tokenEnc: schema.metaCredentials.notionTokenEnc,
      dbId: schema.metaCredentials.notionDbId,
    })
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.id, "singleton"));
  if (!row?.tokenEnc || !row.dbId) return null;
  return { token: decryptSecret(row.tokenEnc, env().APP_ENCRYPTION_KEY), dbId: row.dbId };
}
export interface ChatCredentials {
  token: string;
  model: string;
  effort: string;
}

/** Anthropic key + model/effort live on the singleton row; blank token keeps the stored one. */
export async function saveChatCredentials(
  token: string,
  model: string,
  effort: string,
): Promise<void> {
  const key = env().APP_ENCRYPTION_KEY;
  const set: Record<string, unknown> = {
    chatModel: CHAT_MODELS.includes(model as (typeof CHAT_MODELS)[number])
      ? model
      : DEFAULT_CHAT_MODEL,
    chatEffort: CHAT_EFFORTS.includes(effort as (typeof CHAT_EFFORTS)[number])
      ? effort
      : DEFAULT_CHAT_EFFORT,
    updatedAt: new Date(),
  };
  if (token) set.anthropicTokenEnc = encryptSecret(token, key);
  await db
    .insert(schema.metaCredentials)
    .values({ id: "singleton", ...set })
    .onConflictDoUpdate({ target: schema.metaCredentials.id, set });
}

export async function getChatCredentials(): Promise<ChatCredentials | null> {
  const [row] = await db
    .select({
      tokenEnc: schema.metaCredentials.anthropicTokenEnc,
      model: schema.metaCredentials.chatModel,
      effort: schema.metaCredentials.chatEffort,
    })
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.id, "singleton"));
  if (!row?.tokenEnc) return null;
  return {
    token: decryptSecret(row.tokenEnc, env().APP_ENCRYPTION_KEY),
    model: row.model ?? DEFAULT_CHAT_MODEL,
    effort: row.effort ?? DEFAULT_CHAT_EFFORT,
  };
}

export interface TelegramCredentials {
  token: string;
  chatId: string;
}

/**
 * Telegram bot token + alert chat id, from the singleton row, falling back to env.
 *
 * Each half falls back independently and treats "" as unset, so saving only one field in the UI does
 * not strand the other that env still supplies. Env is the bootstrap path — a fresh deploy alerts
 * before anyone opens Settings — and a stored value wins the moment it exists, matching how the
 * Meta credentials behave.
 *
 * `e` is injectable because `env()` memoises on first call, so a test cannot exercise the fallback
 * by mutating `process.env`. Same reason `NotionClient` and `TelegramClient` take a `fetchImpl`.
 */
export async function getTelegramCredentials(
  e: Pick<Env, "APP_ENCRYPTION_KEY" | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_ALERT_CHAT_ID"> = env(),
): Promise<TelegramCredentials | null> {
  const [row] = await db
    .select({
      tokenEnc: schema.metaCredentials.telegramTokenEnc,
      chatId: schema.metaCredentials.telegramChatId,
    })
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.id, "singleton"));
  const token = row?.tokenEnc
    ? decryptSecret(row.tokenEnc, e.APP_ENCRYPTION_KEY)
    : e.TELEGRAM_BOT_TOKEN;
  const chatId = row?.chatId || e.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) return null;
  return { token, chatId };
}

/** Telegram fields live on the same singleton row; blank token keeps the stored one. */
export async function saveTelegramCredentials(token: string, chatId: string): Promise<void> {
  const key = env().APP_ENCRYPTION_KEY;
  const set: Record<string, unknown> = { telegramChatId: chatId, updatedAt: new Date() };
  if (token) set.telegramTokenEnc = encryptSecret(token, key);
  await db
    .insert(schema.metaCredentials)
    .values({ id: "singleton", ...set })
    .onConflictDoUpdate({ target: schema.metaCredentials.id, set });
}
