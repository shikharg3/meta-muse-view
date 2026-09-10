import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/auth";
import type { UserStatus, UserRole } from "@/lib/auth/users";

export const getCurrentUser = createServerFn({ method: "GET" }).handler(() =>
  ops.getCurrentUser.run(undefined),
);

export const listUsers = createServerFn({ method: "GET" }).handler(() =>
  ops.listUsers.run(undefined),
);

export const listAudit = createServerFn({ method: "GET" }).handler(() =>
  ops.listAudit.run(undefined),
);

export const setUserStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: UserStatus }) => d)
  .handler(({ data }) => ops.setUserStatus.run(data));

export const setUserRole = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; role: UserRole }) => d)
  .handler(({ data }) => ops.setUserRole.run(data));

export const deleteUser = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(({ data }) => ops.deleteUser.run(data));

export const resetPassword = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; newPassword: string }) => d)
  .handler(({ data }) => ops.resetPassword.run(data));
