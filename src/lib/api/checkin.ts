import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/checkin";

export const getCheckinAdmin = createServerFn({ method: "GET" }).handler(() =>
  ops.getCheckinAdmin.run(undefined),
);

/**
 * Bind a media buyer to a discovered Telegram chat, keyed on the Notion person id. An empty `chatId`
 * unbinds. Binding a chat another buyer already holds returns `ok: false` with an actionable error.
 */
export const saveMediaBuyer = createServerFn({ method: "POST" })
  .inputValidator((d: { personId: string; displayName: string; chatId: string }) => d)
  .handler(({ data }) => ops.saveMediaBuyer.run(data));

/** Soft delete / restore: stops prompting without destroying the buyer's prompt history. */
export const toggleMediaBuyer = createServerFn({ method: "POST" })
  .inputValidator((d: { personId: string; active: boolean }) => d)
  .handler(({ data }) => ops.toggleMediaBuyer.run(data));
