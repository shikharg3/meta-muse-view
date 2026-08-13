import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { saveCredentials, saveTelegramCredentials, getTelegramCredentials } from "./credentials";

beforeEach(async () => {
  await db.execute(sql`truncate table meta_credentials, token_health cascade`);
});

test("saveCredentials resets the observed tier so a swapped (possibly dev) app re-paces safely", async () => {
  // A previously-observed standard-tier app.
  await db
    .insert(schema.tokenHealth)
    .values({ id: "singleton", isValid: true, tier: "standard_access" });

  await saveCredentials({
    appId: "123",
    appSecret: "secret",
    token: "tok",
    businessId: "biz",
    accountIds: [],
    apiVersion: "v25.0",
  });

  // Tier is cleared → the next cycle starts on conservative pacing until it re-observes the tier.
  const [row] = await db.select().from(schema.tokenHealth);
  expect(row.tier).toBeNull();
});

// `env()` memoises, so the fallback is exercised through the injection seam rather than by mutating
// process.env, which would silently do nothing after the first call anywhere in the suite.
const withEnv = (token?: string, chatId?: string) => ({
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY as string,
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_ALERT_CHAT_ID: chatId,
});

test("stored Telegram credentials win over env, and each half falls back on its own", async () => {
  const e = withEnv("envtok", "-100env");

  // Nothing stored: env is the bootstrap path, so a fresh deploy alerts before anyone opens Settings.
  expect(await getTelegramCredentials(e)).toEqual({ token: "envtok", chatId: "-100env" });

  // Saving only the chat id must not strand the token env still supplies: the halves fall back
  // independently, or rebinding one field would silently disable alerts entirely.
  await saveTelegramCredentials("", "-100db");
  expect(await getTelegramCredentials(e)).toEqual({ token: "envtok", chatId: "-100db" });

  // Both stored: the database wins outright.
  await saveTelegramCredentials("dbtok", "-100db");
  expect(await getTelegramCredentials(e)).toEqual({ token: "dbtok", chatId: "-100db" });

  // A blank token means "keep what is stored", exactly like the Notion and Anthropic forms.
  await saveTelegramCredentials("", "-100other");
  expect(await getTelegramCredentials(e)).toEqual({ token: "dbtok", chatId: "-100other" });

  // Clearing the chat id falls back to env rather than persisting "" and reporting the integration
  // as unconfigured.
  await saveTelegramCredentials("", "");
  expect(await getTelegramCredentials(e)).toEqual({ token: "dbtok", chatId: "-100env" });
});

test("Telegram is unconfigured unless both halves resolve", async () => {
  const bare = withEnv(undefined, undefined);
  expect(await getTelegramCredentials(bare)).toBeNull();

  // A token with nowhere to send is still unconfigured — `sendAlertChannelMessage` needs both.
  await saveTelegramCredentials("dbtok", "");
  expect(await getTelegramCredentials(bare)).toBeNull();

  // ...and a chat id with no bot behind it likewise.
  await db.execute(sql`truncate table meta_credentials cascade`);
  expect(await getTelegramCredentials(withEnv(undefined, "-100env"))).toBeNull();
});
