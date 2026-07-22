import { createServerFn } from "@tanstack/react-start";
import {
  currentUser,
  listUsersForAdmin,
  updateUserStatus,
  updateUserRole,
  removeUser,
  resetUserPassword,
  listAuditLog,
} from "@/server/fns/auth";
import type { UserStatus, UserRole } from "@/lib/auth/users";

export const getCurrentUser = createServerFn({ method: "GET" }).handler(() => currentUser());

export const listUsers = createServerFn({ method: "GET" }).handler(() => listUsersForAdmin());

export const listAudit = createServerFn({ method: "GET" }).handler(() => listAuditLog());

export const setUserStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: UserStatus }) => d)
  .handler(({ data }) => updateUserStatus(data.id, data.status));

export const setUserRole = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; role: UserRole }) => d)
  .handler(({ data }) => updateUserRole(data.id, data.role));

export const deleteUser = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => removeUser(data.id));

export const resetPassword = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; newPassword: string }) => d)
  .handler(({ data }) => resetUserPassword(data.id, data.newPassword));
