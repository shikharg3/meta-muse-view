import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "mc_session";
export const OAUTH_STATE_COOKIE = "mc_oauth_state";
const MAX_AGE_S = 7 * 24 * 60 * 60; // 7 days

export interface Session {
  uid: string;
  email: string;
  exp: number; // epoch seconds
}

const hmac = (data: string): string =>
  createHmac("sha256", Buffer.from(env().APP_ENCRYPTION_KEY, "hex"))
    .update(data)
    .digest("base64url");

/** Signed, tamper-proof session token: base64url(json).base64url(hmac). */
export function signSession(s: Session): string {
  const payload = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${payload}.${hmac(payload)}`;
}

export function verifySession(token: string | null | undefined): Session | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    if (!s.exp || s.exp * 1000 < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

export function newSession(uid: string, email: string): Session {
  return { uid, email, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S };
}

const base = "Path=/; HttpOnly; Secure; SameSite=Lax";
export const sessionSetCookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; ${base}; Max-Age=${MAX_AGE_S}`;
export const sessionClearCookie = (): string => `${SESSION_COOKIE}=; ${base}; Max-Age=0`;
export const stateSetCookie = (state: string): string =>
  `${OAUTH_STATE_COOKIE}=${state}; ${base}; Max-Age=600`;
export const stateClearCookie = (): string => `${OAUTH_STATE_COOKIE}=; ${base}; Max-Age=0`;

/** Read a cookie value from a raw request Cookie header (for the server.ts gate). */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
