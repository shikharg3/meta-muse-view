import { z } from "zod";
import { resetAndResync as resetAndResyncImpl, triggerSync } from "@/server/fns/reset";
import {
  fetchSettings,
  runNotionSync,
  runTestConnection,
  saveChatForm,
  saveCredentialsFormData,
  saveNotionForm,
  saveTelegramForm,
  verifyTelegramChat,
} from "@/server/fns/settings";
import { defineOp } from "../registry";

/**
 * Settings ops: stored credentials, the manual sync triggers, and the integration self-tests.
 *
 * Every delegate calls `requireAdmin()` itself, so authorisation is unchanged by the move — the
 * wrappers these replace carried none.
 *
 * Secrets (`appSecret`, `token`) are write-only from the UI: the delegate keeps the stored value
 * when the field is blank or absent (`src/server/fns/settings.ts:157-158`). They therefore stay
 * optional here, and the schemas must not default an absent secret to `""` — that would still be
 * treated as "keep", but it would make the wire shape claim the client sent a secret it did not.
 *
 * Required text fields are plain `z.string()` rather than `.min(1)`: the delegates decide what a
 * blank value means (`saveNotionForm` returns `{ok:false}` for an unparseable board URL, an empty
 * `accountIds` legitimately clears the list), and tightening the schema would turn those returned
 * errors into thrown ones.
 */

export const getSettings = defineOp({
  name: "getSettings",
  mode: "read",
  handler: () => fetchSettings(),
});

export const saveCredentialsForm = defineOp({
  name: "saveCredentialsForm",
  mode: "write",
  input: z.object({
    appId: z.string(),
    appSecret: z.string().optional(),
    token: z.string().optional(),
    businessId: z.string(),
    /** Comma-separated; the delegate splits, trims and drops blanks. */
    accountIds: z.string(),
  }),
  handler: (input) => saveCredentialsFormData(input),
});

export const testConnection = defineOp({
  name: "testConnection",
  mode: "write",
  handler: () => runTestConnection(),
});

/** Wipes all synced data (keeps credentials) and starts a full backfill resync. */
export const resetAndResync = defineOp({
  name: "resetAndResync",
  mode: "write",
  handler: () => resetAndResyncImpl(),
});

/** Kicks a fresh core refresh (headline metrics) from Meta in the background; no wipe. */
export const syncNow = defineOp({
  name: "syncNow",
  mode: "write",
  handler: () => triggerSync(),
});

export const saveNotionSettings = defineOp({
  name: "saveNotionSettings",
  mode: "write",
  input: z.object({ token: z.string().optional(), board: z.string() }),
  handler: (input) => saveNotionForm(input),
});

export const syncNotionNow = defineOp({
  name: "syncNotionNow",
  mode: "write",
  handler: () => runNotionSync(),
});

export const saveChatSettings = defineOp({
  name: "saveChatSettings",
  mode: "write",
  input: z.object({ token: z.string().optional(), model: z.string(), effort: z.string() }),
  handler: (input) => saveChatForm(input),
});

export const saveTelegramSettings = defineOp({
  name: "saveTelegramSettings",
  mode: "write",
  input: z.object({ token: z.string().optional(), chatId: z.string() }),
  handler: (input) => saveTelegramForm(input),
});

export const verifyTelegram = defineOp({
  name: "verifyTelegram",
  mode: "write",
  handler: () => verifyTelegramChat(),
});
