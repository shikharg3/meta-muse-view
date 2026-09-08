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
  setUserPassword,
  isAdmin,
  isSuperadmin,
  type PublicUser,
  type AdminUser,
  type UserStatus,
  type UserRole,
} from "@/lib/auth/users";
import { roleChangeError } from "@/lib/auth/roles";

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
  if (!me || !isAdmin(me.role)) throw new Error("Forbidden: admin access required.");
  return me;
}

/**
 * Throw unless the caller is signed in AND approved — the floor for pages a `member` may use.
 *
 * Status is checked here, unlike `requireAdmin`, because this is the only guard a non-admin ever
 * clears: a pending or rejected account has a valid session cookie and would otherwise walk
 * straight in. `requireAdmin` gets away without it only because status and role move together for
 * admins — no approval flow ever leaves a pending user holding `admin`.
 */
export async function requireApproved(): Promise<PublicUser> {
  const me = await currentUser();
  if (!me || me.status !== "approved") throw new Error("Forbidden: approved access required.");
  return me;
}

/** Throw unless the caller is a superadmin — for cross-user chat history + finance. */
export async function requireSuperadmin(): Promise<PublicUser> {
  const me = await currentUser();
  if (!me || !isSuperadmin(me.role)) throw new Error("Forbidden: superadmin access required.");
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
  if (!me || !isAdmin(me.role)) return { error: "Forbidden" };
  return { users: await listAllUsers() };
}

export async function updateUserStatus(
  id: string,
  status: UserStatus,
): Promise<{ ok: boolean; error?: string }> {
  const me = await currentUser();
  if (!me || !isAdmin(me.role)) return { ok: false, error: "Forbidden" };
  if (me.id === id && status !== "approved")
    return { ok: false, error: "You can't change your own access." };
  const target = (await listAllUsers()).find((u) => u.id === id);
  if (target?.role === "superadmin" && !isSuperadmin(me.role))
    return { ok: false, error: "Only a superadmin can change a superadmin's access." };
  await setUserStatus(id, status);
  await audit(`user.${status}`, `${status} ${target?.email ?? id}`);
  return { ok: true };
}

export async function updateUserRole(
  id: string,
  role: UserRole,
): Promise<{ ok: boolean; error?: string }> {
  const me = await currentUser();
  if (!me) return { ok: false, error: "Forbidden" };
  const target = (await listAllUsers()).find((u) => u.id === id);
  // Every rule lives in `roleChangeError`, which is pure and unit-tested. This fn only supplies the
  // actor and target it had to read from the session and the database.
  const error = roleChangeError({
    actorId: me.id,
    actorRole: me.role,
    targetId: id,
    targetRole: target?.role,
    targetEnvPinned: target?.envPinned ?? false,
    nextRole: role,
  });
  if (error) return { ok: false, error };
  await setUserRole(id, role);
  await audit("user.role", `set ${target?.email ?? id} to ${role}`);
  return { ok: true };
}

export async function removeUser(id: string): Promise<{ ok: boolean; error?: string }> {
  const me = await currentUser();
  if (!me || !isAdmin(me.role)) return { ok: false, error: "Forbidden" };
  if (me.id === id) return { ok: false, error: "You can't delete your own account." };
  const target = (await listAllUsers()).find((u) => u.id === id);
  if (target?.role === "superadmin" && !isSuperadmin(me.role))
    return { ok: false, error: "Only a superadmin can delete a superadmin." };
  await deleteUser(id);
  await audit("user.delete", `deleted ${target?.email ?? id}`);
  return { ok: true };
}

/** Superadmin-only: overwrite another user's password (e.g. a locked-out teammate). */
export async function resetUserPassword(
  id: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  const me = await currentUser();
  if (!me || !isSuperadmin(me.role))
    return { ok: false, error: "Only a superadmin can reset passwords." };
  const target = (await listAllUsers()).find((u) => u.id === id);
  if (!target) return { ok: false, error: "Unknown user." };
  const r = await setUserPassword(id, newPassword);
  if (!r.ok) return r;
  await audit("user.password_reset", `reset password for ${target.email}`);
  return { ok: true };
}

export async function listAuditLog(): Promise<{ entries: AuditEntry[] } | { error: string }> {
  const me = await currentUser();
  if (!me || !isAdmin(me.role)) return { error: "Forbidden" };
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
