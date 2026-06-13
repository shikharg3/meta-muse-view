import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import { getCookie } from "@tanstack/react-start/server";
import { db, schema } from "@/db/client";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import {
  findUserById,
  toPublicUser,
  listAllUsers,
  setUserStatus,
  setUserRole,
  deleteUser,
  type PublicUser,
  type AdminUser,
  type UserStatus,
  type UserRole,
} from "@/lib/auth/users";

/** Resolve the signed-in user from the session cookie (fresh role/status from DB). */
export async function currentUser(): Promise<PublicUser | null> {
  const session = verifySession(getCookie(SESSION_COOKIE));
  if (!session) return null;
  const u = await findUserById(session.uid);
  return u ? toPublicUser(u) : null;
}

/** Throw unless the caller is an approved admin — for sensitive (settings/reset/mapping) fns. */
export async function requireAdmin(): Promise<PublicUser> {
  const me = await currentUser();
  if (me?.role !== "admin") throw new Error("Forbidden: admin access required.");
  return me;
}

/** Record an admin action against the current user. */
export async function audit(action: string, detail: string): Promise<void> {
  const me = await currentUser();
  await db
    .insert(schema.auditLog)
    .values({ id: randomUUID(), actorEmail: me?.email ?? "system", action, detail });
}

export interface AuditEntry {
  id: string;
  actorEmail: string;
  action: string;
  detail: string;
  createdAt: string;
}

export async function listUsersForAdmin(): Promise<{ users: AdminUser[] } | { error: string }> {
  const me = await currentUser();
  if (me?.role !== "admin") return { error: "Forbidden" };
  return { users: await listAllUsers() };
}

export async function updateUserStatus(
  id: string,
  status: UserStatus,
): Promise<{ ok: boolean; error?: string }> {
  const me = await currentUser();
  if (me?.role !== "admin") return { ok: false, error: "Forbidden" };
  if (me.id === id && status !== "approved")
    return { ok: false, error: "You can't change your own access." };
  const target = (await listAllUsers()).find((u) => u.id === id);
  await setUserStatus(id, status);
  await audit(`user.${status}`, `${status} ${target?.email ?? id}`);
  return { ok: true };
}

export async function updateUserRole(
  id: string,
  role: UserRole,
): Promise<{ ok: boolean; error?: string }> {
  const me = await currentUser();
  if (me?.role !== "admin") return { ok: false, error: "Forbidden" };
  if (me.id === id) return { ok: false, error: "You can't change your own role." };
  const target = (await listAllUsers()).find((u) => u.id === id);
  await setUserRole(id, role);
  await audit("user.role", `set ${target?.email ?? id} to ${role}`);
  return { ok: true };
}

export async function removeUser(id: string): Promise<{ ok: boolean; error?: string }> {
  const me = await currentUser();
  if (me?.role !== "admin") return { ok: false, error: "Forbidden" };
  if (me.id === id) return { ok: false, error: "You can't delete your own account." };
  const target = (await listAllUsers()).find((u) => u.id === id);
  await deleteUser(id);
  await audit("user.delete", `deleted ${target?.email ?? id}`);
  return { ok: true };
}

export async function listAuditLog(): Promise<{ entries: AuditEntry[] } | { error: string }> {
  const me = await currentUser();
  if (me?.role !== "admin") return { error: "Forbidden" };
  const rows = await db
    .select()
    .from(schema.auditLog)
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(100);
  return {
    entries: rows.map((r) => ({
      id: r.id,
      actorEmail: r.actorEmail,
      action: r.action,
      detail: r.detail,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
