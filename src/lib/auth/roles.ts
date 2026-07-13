// Pure role helpers — NO server imports, so client components can use them safely.
export type UserRole = "superadmin" | "admin" | "member";

/** Superadmin is a strict superset of admin — every admin-only gate must accept both. */
export const isAdmin = (role: string | null | undefined): boolean =>
  role === "admin" || role === "superadmin";

export const isSuperadmin = (role: string | null | undefined): boolean => role === "superadmin";
