import { z } from "zod";
import { isSuperadmin } from "@/lib/auth/roles";
import { currentUser, requireUser } from "@/server/fns/auth";
import {
  deleteConversation as deleteConversationFn,
  getAnyConversation,
  getConversation as getConversationFn,
  listAllConversations,
  listConversations as listConversationsFn,
  renameConversation as renameConversationFn,
} from "@/server/fns/conversations";
import { defineOp, optionalScalarString, scalarString } from "../registry";
import { idOnly } from "../schemas";

/**
 * Chat history ops.
 *
 * Every authorisation check on this surface used to live in `src/lib/api/conversations.ts`, i.e. in
 * the TanStack transport, so deleting that frontend would have deleted all six. They are here now,
 * and the two distinct failure modes are preserved because callers depend on both:
 *
 * - The owner-scoped four **throw** (`requireUser`, previously the wrapper's private `requireUid`).
 *   The delegates take the owner id as their filter argument, so this is the ownership key, not a
 *   permission gate — a signed-in member reads their own threads.
 * - The two admin views **return** `{error:"Forbidden"}`; the admin UI branches on that field.
 */

export const listConversations = defineOp({
  name: "listConversations",
  mode: "read",
  handler: async () => listConversationsFn((await requireUser()).id),
});

export const getConversation = defineOp({
  name: "getConversation",
  mode: "read",
  input: scalarString,
  handler: async (id) => getConversationFn((await requireUser()).id, id),
});

export const renameConversation = defineOp({
  name: "renameConversation",
  mode: "write",
  input: idOnly.extend({ title: z.string() }),
  handler: async (input) => renameConversationFn((await requireUser()).id, input.id, input.title),
});

export const deleteConversation = defineOp({
  name: "deleteConversation",
  mode: "write",
  input: scalarString,
  handler: async (id) => deleteConversationFn((await requireUser()).id, id),
});

// ── Superadmin-only cross-user chat history ─────────────────────────────────────────────────────

export const adminListConversations = defineOp({
  name: "adminListConversations",
  mode: "read",
  // Absent (or empty) means every user, one id means that user — the filter is optional, not a
  // required argument that happens to be blank.
  input: optionalScalarString,
  handler: async (userId) => {
    const me = await currentUser();
    if (!isSuperadmin(me?.role)) return { error: "Forbidden" as const };
    return { conversations: await listAllConversations(userId || undefined) };
  },
});

export const adminGetConversation = defineOp({
  name: "adminGetConversation",
  mode: "read",
  input: scalarString,
  handler: async (id) => {
    const me = await currentUser();
    if (!isSuperadmin(me?.role)) return { error: "Forbidden" as const };
    return { conversation: await getAnyConversation(id) };
  },
});
