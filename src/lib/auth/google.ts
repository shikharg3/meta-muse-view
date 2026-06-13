import { env } from "@/lib/env";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export function googleConfigured(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
}

export function googleAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env().GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `${AUTH_URL}?${params}`;
}

export interface GoogleUser {
  email: string;
  name: string | null;
  sub: string;
  emailVerified: boolean;
}

/** Exchange the auth code and fetch the user's profile; null on any failure. */
export async function exchangeCodeForUser(
  code: string,
  redirectUri: string,
): Promise<GoogleUser | null> {
  const e = env();
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: e.GOOGLE_CLIENT_ID ?? "",
      client_secret: e.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return null;
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) return null;

  const userRes = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) return null;
  const u = (await userRes.json()) as {
    email?: string;
    name?: string;
    sub?: string;
    email_verified?: boolean;
  };
  if (!u.email || !u.sub) return null;
  return {
    email: u.email.toLowerCase(),
    name: u.name ?? null,
    sub: u.sub,
    emailVerified: u.email_verified ?? false,
  };
}
