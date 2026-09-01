// Pure role helpers — NO server imports, so client components can use them safely.
export type UserRole = "superadmin" | "admin" | "member";

/** Superadmin is a strict superset of admin — every admin-only gate must accept both. */
export const isAdmin = (role: string | null | undefined): boolean =>
  role === "admin" || role === "superadmin";

export const isSuperadmin = (role: string | null | undefined): boolean => role === "superadmin";

/** Who is changing whose role, and to what. Everything the decision needs — no DB, no session. */
export interface RoleChange {
  actorId: string;
  actorRole: string | null | undefined;
  targetId: string;
  /** The target's CURRENT role. */
  targetRole: string | null | undefined;
  /**
   * The target's email is listed in `AUTH_SUPERADMINS`, which `ensureBootstrap` re-applies on every
   * login. Their superadmin status is owned by the environment, not by this table.
   */
  targetEnvPinned: boolean;
  nextRole: UserRole;
}

/**
 * Why this role change must be refused, or null when it is allowed.
 *
 * Pure and exported so the rules are testable: the server fn that enforces them reads the actor from
 * a session cookie, which no unit test can supply, and authorization is the last logic that should go
 * unverified because it is inconvenient to reach.
 */
export function roleChangeError(c: RoleChange): string | null {
  if (!isAdmin(c.actorRole)) return "Forbidden";
  // Self-service role edits are refused outright — including a superadmin demoting themselves, which
  // is how an estate ends up with no superadmin at all.
  if (c.actorId === c.targetId) return "You can't change your own role.";
  // Granting OR removing superadmin is superadmin-only. Both halves matter: without the second, an
  // ordinary admin could demote a superadmin and take the estate over.
  if ((c.nextRole === "superadmin" || c.targetRole === "superadmin") && !isSuperadmin(c.actorRole))
    return "Only a superadmin can manage the superadmin role.";
  // Refused rather than allowed-and-reverted: the write would succeed, look correct, and then undo
  // itself the next time that user logged in. A clear refusal beats a state that silently heals back.
  if (c.targetEnvPinned && c.targetRole === "superadmin" && c.nextRole !== "superadmin")
    return "That account is pinned as a superadmin by AUTH_SUPERADMINS. Remove it from that list to change this role.";
  return null;
}
