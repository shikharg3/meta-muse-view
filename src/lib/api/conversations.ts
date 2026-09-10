import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/conversations";

export const listConversations = createServerFn({ method: "GET" }).handler(() =>
  ops.listConversations.run(undefined),
);

export const getConversation = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(({ data }) => ops.getConversation.run(data));

export const renameConversation = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; title: string }) => d)
  .handler(({ data }) => ops.renameConversation.run(data));

export const deleteConversation = createServerFn({ method: "POST" })
  .inputValidator((id: string) => id)
  .handler(({ data }) => ops.deleteConversation.run(data));

// ── Superadmin-only cross-user chat history ─────────────────────────────────────────────────────

export const adminListConversations = createServerFn({ method: "GET" })
  .inputValidator((userId: string | undefined) => userId)
  .handler(({ data }) => ops.adminListConversations.run(data));

export const adminGetConversation = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(({ data }) => ops.adminGetConversation.run(data));
