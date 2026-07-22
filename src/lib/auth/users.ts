import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import { hashPassword, verifyPassword } from "./password";
import { isAdmin, isSuperadmin, type UserRole } from "./roles";

export type UserRow = typeof schema.users.$inferSelect;
export { isAdmin, isSuperadmin };
export type { UserRole };
export type UserStatus = "pending" | "approved" | "rejected";

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: UserStatus;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role as UserRole,
    status: u.status as UserStatus,
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isBootstrapAdmin = (email: string): boolean =>
  env().AUTH_BOOTSTRAP_ADMINS.includes(email.toLowerCase());
const isSuperadminEmail = (email: string): boolean =>
  env().AUTH_SUPERADMINS.includes(email.toLowerCase());

async function isFirstUser(): Promise<boolean> {
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(schema.users);
  return Number(r?.n ?? 0) === 0;
}

/** The role an email bootstraps into: superadmin > admin, else null (a normal pending member). */
async function bootstrapRole(email: string): Promise<UserRole | null> {
  if (isSuperadminEmail(email)) return "superadmin";
  const admins = env().AUTH_BOOTSTRAP_ADMINS;
  if (admins.length) return admins.includes(email.toLowerCase()) ? "admin" : null;
  return (await isFirstUser()) ? "admin" : null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return u ?? null;
}
async function findByEmail(email: string): Promise<UserRow | null> {
  const [u] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase()));
  return u ?? null;
}

export type AuthOutcome = { ok: true; user: UserRow } | { ok: false; error: string };

/** Promote a bootstrap-admin / superadmin email to its role + approved even if it signed up earlier. */
async function ensureBootstrap(u: UserRow): Promise<UserRow> {
  const target: UserRole | null = isSuperadminEmail(u.email)
    ? "superadmin"
    : isBootstrapAdmin(u.email)
      ? "admin"
      : null;
  if (target && (u.role !== target || u.status !== "approved")) {
    await db
      .update(schema.users)
      .set({ role: target, status: "approved" })
      .where(eq(schema.users.id, u.id));
    return { ...u, role: target, status: "approved" };
  }
  return u;
}

export async function signupWithPassword(
  name: string,
  email: string,
  password: string,
): Promise<AuthOutcome> {
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return { ok: false, error: "Enter a valid email address." };
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
  if (await findByEmail(e))
    return { ok: false, error: "An account with that email already exists — try logging in." };
  const bootRole = await bootstrapRole(e);
  const [u] = await db
    .insert(schema.users)
    .values({
      id: randomUUID(),
      email: e,
      name: name.trim() || null,
      passwordHash: await hashPassword(password),
      role: bootRole ?? "member",
      status: bootRole ? "approved" : "pending",
      lastLoginAt: new Date(),
    })
    .returning();
  return { ok: true, user: u };
}

export async function loginWithPassword(email: string, password: string): Promise<AuthOutcome> {
  const u = await findByEmail(email);
  if (!u || !(await verifyPassword(password, u.passwordHash))) {
    return { ok: false, error: "Wrong email or password." };
  }
  if (u.status === "rejected") return { ok: false, error: "Your account access was declined." };
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, u.id));
  return { ok: true, user: await ensureBootstrap(u) };
}

/** Stable id/email for the shared HTTP Basic Auth test admin (see lib/auth/gate). */
export const BASIC_AUTH_USER_ID = "basic-auth-test";
const BASIC_AUTH_EMAIL = "basic-auth@test.local";

/** Idempotently ensure the shared test-admin row exists; returns it (approved admin). */
export async function ensureBasicAuthUser(): Promise<UserRow> {
  const [u] = await db
    .insert(schema.users)
    .values({
      id: BASIC_AUTH_USER_ID,
      email: BASIC_AUTH_EMAIL,
      name: "Basic Auth (test)",
      role: "admin",
      status: "approved",
      lastLoginAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.users.id,
      set: { role: "admin", status: "approved", lastLoginAt: new Date() },
    })
    .returning();
  return u;
}

export interface AdminUser extends PublicUser {
  lastLoginAt: string | null;
  createdAt: string;
}
export async function listAllUsers(): Promise<AdminUser[]> {
  const rows = await db.select().from(schema.users).orderBy(schema.users.createdAt);
  return rows.map((u) => ({
    ...toPublicUser(u),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  }));
}
export async function setUserStatus(id: string, status: UserStatus): Promise<void> {
  await db.update(schema.users).set({ status }).where(eq(schema.users.id, id));
}
export async function setUserRole(id: string, role: UserRole): Promise<void> {
  await db.update(schema.users).set({ role }).where(eq(schema.users.id, id));
}
/** Overwrite a user's password (superadmin reset path — validation mirrors signup). Existing
 *  sessions stay valid until they expire (sessions are stateless signed cookies). */
export async function setUserPassword(
  id: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(schema.users.id, id));
  return { ok: true };
}
export async function deleteUser(id: string): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, id));
}
export async function getUserById(id: string): Promise<UserRow | null> {
  return findUserById(id);
}
