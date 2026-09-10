import { z } from "zod";
import {
  clearStatusOverride,
  fetchStatusOverrides,
  setStatusOverride,
} from "@/server/fns/account-status";
import { defineOp } from "../registry";

/**
 * Account-status override ops. All three delegates call `requireAdmin()` themselves; the wrappers
 * they replace carried no check of their own.
 *
 * `status` is a plain string: `setStatusOverride` rejects human-owned values with a returned
 * `{ok:false,error}` naming the accepted set, and validating the vocabulary here would turn that
 * actionable answer into a thrown validation error. `pageId` is likewise unconstrained — a blank
 * one is the delegate's `"No page id"` case.
 */

export const getStatusOverrides = defineOp({
  name: "getStatusOverrides",
  mode: "read",
  handler: () => fetchStatusOverrides(),
});

/** Pin one board row's Account Status. Only machine-owned values are accepted server-side. */
export const pinStatusOverride = defineOp({
  name: "pinStatusOverride",
  mode: "write",
  input: z.object({ pageId: z.string(), status: z.string() }),
  handler: (input) => setStatusOverride(input),
});

export const unpinStatusOverride = defineOp({
  name: "unpinStatusOverride",
  mode: "write",
  input: z.object({ pageId: z.string() }),
  handler: (input) => clearStatusOverride(input),
});
