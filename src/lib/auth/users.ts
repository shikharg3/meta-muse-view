import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import { hashPassword, verifyPassword } from "./password";

export type UserRow = typeof schema.users.$inferSelect;
export type UserRole = "admin" | "member";
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

async function isFirstUser(): Promise<boolean> {
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(schema.users);
  return Number(r?.n ?? 0) === 0;
}

/**
 * Initial admin policy: if bootstrap admin email(s) are configured, ONLY those
 * are admins; otherwise the first account ever created bootstraps as admin.
 */
async function shouldBeAdmin(email: string): Promise<boolean> {
  const admins = env().AUTH_BOOTSTRAP_ADMINS;
  if (admins.length) return admins.includes(email.toLowerCase());
  return await isFirstUser();
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

/** Promote a bootstrap-admin email to admin/approved even if it signed up earlier. */
async function ensureBootstrap(u: UserRow): Promise<UserRow> {
  if (isBootstrapAdmin(u.email) && (u.role !== "admin" || u.status !== "approved")) {
    await db
      .update(schema.users)
      .set({ role: "admin", status: "approved" })
      .where(eq(schema.users.id, u.id));
    return { ...u, role: "admin", status: "approved" };
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
  const admin = await shouldBeAdmin(e);
  const [u] = await db
    .insert(schema.users)
    .values({
      id: randomUUID(),
      email: e,
      name: name.trim() || null,
      passwordHash: await hashPassword(password),
      role: admin ? "admin" : "member",
      status: admin ? "approved" : "pending",
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

export async function upsertGoogleUser(g: {
  email: string;
  name: string | null;
  sub: string;
}): Promise<AuthOutcome> {
  const existing = await findByEmail(g.email);
  if (existing) {
    if (existing.status === "rejected")
      return { ok: false, error: "Your account access was declined." };
    await db
      .update(schema.users)
      .set({ googleSub: g.sub, name: existing.name ?? g.name, lastLoginAt: new Date() })
      .where(eq(schema.users.id, existing.id));
    return { ok: true, user: await ensureBootstrap(existing) };
  }
  const admin = await shouldBeAdmin(g.email);
  const [u] = await db
    .insert(schema.users)
    .values({
      id: randomUUID(),
      email: g.email,
      name: g.name,
      role: admin ? "admin" : "member",
      status: admin ? "approved" : "pending",
      googleSub: g.sub,
      lastLoginAt: new Date(),
    })
    .returning();
  return { ok: true, user: u };
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
export async function deleteUser(id: string): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, id));
}
export async function getUserById(id: string): Promise<UserRow | null> {
  return findUserById(id);
}
