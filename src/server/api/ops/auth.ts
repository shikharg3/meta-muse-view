import { z } from "zod";
import {
  currentUser,
  listAuditLog,
  listUsersForAdmin,
  removeUser,
  resetUserPassword,
  updateUserRole,
  updateUserStatus,
} from "@/server/fns/auth";
import { defineOp } from "../registry";
import { idOnly } from "../schemas";

/**
 * User administration ops.
 *
 * Every delegate here resolves `currentUser()` itself and *returns* `{error}` / `{ok:false,error}`
 * rather than throwing — the admin screens render those strings inline. That contract is preserved
 * verbatim: an op must not turn a returned refusal into an HTTP error, or the UI loses the reason.
 */

export const getCurrentUser = defineOp({
  name: "getCurrentUser",
  mode: "read",
  handler: () => currentUser(),
});

export const listUsers = defineOp({
  name: "listUsers",
  mode: "read",
  handler: () => listUsersForAdmin(),
});

export const listAudit = defineOp({
  name: "listAudit",
  mode: "read",
  handler: () => listAuditLog(),
});

export const setUserStatus = defineOp({
  name: "setUserStatus",
  mode: "write",
  input: idOnly.extend({ status: z.enum(["pending", "approved", "rejected"]) }),
  handler: (input) => updateUserStatus(input.id, input.status),
});

export const setUserRole = defineOp({
  name: "setUserRole",
  mode: "write",
  input: idOnly.extend({ role: z.enum(["superadmin", "admin", "member"]) }),
  handler: (input) => updateUserRole(input.id, input.role),
});

export const deleteUser = defineOp({
  name: "deleteUser",
  mode: "write",
  input: idOnly,
  handler: (input) => removeUser(input.id),
});

export const resetPassword = defineOp({
  name: "resetPassword",
  mode: "write",
  // No length rule here on purpose: `setUserPassword` applies the same rules as signup and returns
  // its wording as `{ok:false,error}`. A schema minimum would pre-empt it with a parse failure.
  input: idOnly.extend({ newPassword: z.string() }),
  handler: (input) => resetUserPassword(input.id, input.newPassword),
});
