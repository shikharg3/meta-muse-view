import { getCookie } from "@tanstack/react-start/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import {
  findUserById,
  toPublicUser,
  listAllUsers,
  setUserStatus,
  type PublicUser,
  type UserStatus,
} from "@/lib/auth/users";

/** Resolve the signed-in user from the session cookie (fresh role/status from DB). */
export async function currentUser(): Promise<PublicUser | null> {
  const session = verifySession(getCookie(SESSION_COOKIE));
  if (!session) return null;
  const u = await findUserById(session.uid);
  return u ? toPublicUser(u) : null;
}

export async function listUsersForAdmin(): Promise<{ users: PublicUser[] } | { error: string }> {
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
  // An admin can't lock themselves out.
  if (me.id === id && status !== "approved")
    return { ok: false, error: "You can't change your own access." };
  await setUserStatus(id, status);
  return { ok: true };
}
