import { createServerFn } from "@tanstack/react-start";
import { fetchSettings, runTestConnection, saveCredentialsFormData, type CredsForm } from "@/server/fns/settings";
import { resetAndResync as resetAndResyncImpl } from "@/server/fns/reset";

export const getSettings = createServerFn({ method: "GET" }).handler(() => fetchSettings());

export const saveCredentialsForm = createServerFn({ method: "POST" })
  .inputValidator((d: CredsForm) => d)
  .handler(({ data }) => saveCredentialsFormData(data));

export const testConnection = createServerFn({ method: "POST" }).handler(() => runTestConnection());

/** Wipes all synced data (keeps credentials) and starts a full backfill resync. */
export const resetAndResync = createServerFn({ method: "POST" }).handler(() => resetAndResyncImpl());
