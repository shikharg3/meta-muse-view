import { createServerFn } from "@tanstack/react-start";
import type { CredsForm } from "@/server/fns/settings";
import * as ops from "@/server/api/ops/settings";

export const getSettings = createServerFn({ method: "GET" }).handler(() =>
  ops.getSettings.run(undefined),
);

export const saveCredentialsForm = createServerFn({ method: "POST" })
  .inputValidator((d: CredsForm) => d)
  .handler(({ data }) => ops.saveCredentialsForm.run(data));

export const testConnection = createServerFn({ method: "POST" }).handler(() =>
  ops.testConnection.run(undefined),
);

/** Wipes all synced data (keeps credentials) and starts a full backfill resync. */
export const resetAndResync = createServerFn({ method: "POST" }).handler(() =>
  ops.resetAndResync.run(undefined),
);

/** Kicks a fresh core refresh (headline metrics) from Meta in the background; no wipe. Admin-only. */
export const syncNow = createServerFn({ method: "POST" }).handler(() => ops.syncNow.run(undefined));

export const saveNotionSettings = createServerFn({ method: "POST" })
  .inputValidator((d: { token?: string; board: string }) => d)
  .handler(({ data }) => ops.saveNotionSettings.run(data));

export const syncNotionNow = createServerFn({ method: "POST" }).handler(() =>
  ops.syncNotionNow.run(undefined),
);

export const saveChatSettings = createServerFn({ method: "POST" })
  .inputValidator((d: { token?: string; model: string; effort: string }) => d)
  .handler(({ data }) => ops.saveChatSettings.run(data));

export const saveTelegramSettings = createServerFn({ method: "POST" })
  .inputValidator((d: { token?: string; chatId: string }) => d)
  .handler(({ data }) => ops.saveTelegramSettings.run(data));

export const verifyTelegram = createServerFn({ method: "POST" }).handler(() =>
  ops.verifyTelegram.run(undefined),
);
