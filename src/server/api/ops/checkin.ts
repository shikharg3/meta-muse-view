import { z } from "zod";
import { fetchCheckinAdmin, setMediaBuyerActive, upsertMediaBuyer } from "@/server/fns/checkin";
import { defineOp } from "../registry";

/**
 * Check-in admin ops: the media-buyer roster behind the Settings panel. Every delegate calls
 * `requireAdmin()` itself, and the two writes rethrow it flattened.
 *
 * `chatId` accepts `""` on purpose — an empty value unbinds the buyer from their Telegram chat,
 * so it is a real instruction, not a missing field. `personId` and `displayName` are equally
 * unconstrained here because `upsertMediaBuyer` answers a blank or malformed id with a returned
 * `{ok:false,error}` that tells the admin where to copy the UUID from.
 */

export const getCheckinAdmin = defineOp({
  name: "getCheckinAdmin",
  mode: "read",
  handler: () => fetchCheckinAdmin(),
});

/**
 * Bind a media buyer to a discovered Telegram chat, keyed on the Notion person id. An empty `chatId`
 * unbinds. Binding a chat another buyer already holds returns `ok: false` with an actionable error.
 */
export const saveMediaBuyer = defineOp({
  name: "saveMediaBuyer",
  mode: "write",
  input: z.object({ personId: z.string(), displayName: z.string(), chatId: z.string() }),
  handler: (input) => upsertMediaBuyer(input),
});

/** Soft delete / restore: stops prompting without destroying the buyer's prompt history. */
export const toggleMediaBuyer = defineOp({
  name: "toggleMediaBuyer",
  mode: "write",
  input: z.object({ personId: z.string(), active: z.boolean() }),
  handler: (input) => setMediaBuyerActive(input),
});
