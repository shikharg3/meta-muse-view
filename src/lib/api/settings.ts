import { createServerFn } from "@tanstack/react-start";
import {
  fetchSettings,
  runTestConnection,
  saveCredentialsFormData,
  saveNotionForm,
  runNotionSync,
  saveChatForm,
  type CredsForm,
} from "@/server/fns/settings";
import { resetAndResync as resetAndResyncImpl, triggerSync } from "@/server/fns/reset";

export const getSettings = createServerFn({ method: "GET" }).handler(() => fetchSettings());

export const saveCredentialsForm = createServerFn({ method: "POST" })
  .inputValidator((d: CredsForm) => d)
  .handler(({ data }) => saveCredentialsFormData(data));

export const testConnection = createServerFn({ method: "POST" }).handler(() => runTestConnection());

/** Wipes all synced data (keeps credentials) and starts a full backfill resync. */
export const resetAndResync = createServerFn({ method: "POST" }).handler(() =>
  resetAndResyncImpl(),
);

/** Kicks a fresh core refresh (headline metrics) from Meta in the background; no wipe. Admin-only. */
export const syncNow = createServerFn({ method: "POST" }).handler(() => triggerSync());

export const saveNotionSettings = createServerFn({ method: "POST" })
  .inputValidator((d: { token?: string; board: string }) => d)
  .handler(({ data }) => saveNotionForm(data));

export const syncNotionNow = createServerFn({ method: "POST" }).handler(() => runNotionSync());

export const saveChatSettings = createServerFn({ method: "POST" })
  .inputValidator((d: { token?: string; model: string; effort: string }) => d)
  .handler(({ data }) => saveChatForm(data));
