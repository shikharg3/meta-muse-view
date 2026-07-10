import { createServerFn } from "@tanstack/react-start";
import { currentUser } from "@/server/fns/auth";
import {
  listConversations as listFn,
  getConversation as getFn,
  renameConversation as renameFn,
  deleteConversation as deleteFn,
} from "@/server/fns/conversations";

async function requireUid(): Promise<string> {
  const me = await currentUser();
  if (!me) throw new Error("You're not signed in.");
  return me.id;
}

export const listConversations = createServerFn({ method: "GET" }).handler(async () =>
  listFn(await requireUid()),
);

export const getConversation = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(async ({ data }) => getFn(await requireUid(), data));

export const renameConversation = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; title: string }) => d)
  .handler(async ({ data }) => renameFn(await requireUid(), data.id, data.title));

export const deleteConversation = createServerFn({ method: "POST" })
  .inputValidator((id: string) => id)
  .handler(async ({ data }) => deleteFn(await requireUid(), data));
