import { createServerFn } from "@tanstack/react-start";
import { currentUser, listUsersForAdmin, updateUserStatus } from "@/server/fns/auth";
import type { UserStatus } from "@/lib/auth/users";

export const getCurrentUser = createServerFn({ method: "GET" }).handler(() => currentUser());

export const listUsers = createServerFn({ method: "GET" }).handler(() => listUsersForAdmin());

export const setUserStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; status: UserStatus }) => d)
  .handler(({ data }) => updateUserStatus(data.id, data.status));
