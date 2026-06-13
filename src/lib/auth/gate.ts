import { randomBytes } from "node:crypto";
import {
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  verifySession,
  signSession,
  newSession,
  sessionSetCookie,
  sessionClearCookie,
  stateSetCookie,
  stateClearCookie,
  readCookie,
} from "./session";
import { googleConfigured, googleAuthUrl, exchangeCodeForUser } from "./google";
import { loginWithPassword, signupWithPassword, upsertGoogleUser, findUserById } from "./users";

/** Public origin as seen by the browser (behind nginx: honor forwarded headers). */
function publicOrigin(request: Request, url: URL): string {
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = request.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}
function json(body: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status: 200, headers });
}
const sessionCookieFor = (user: { id: string; email: string }): string =>
  sessionSetCookie(signSession(newSession(user.id, user.email)));

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Pages + static assets reachable without a session.
function isPublicPath(path: string): boolean {
  if (path === "/login" || path === "/signup") return true;
  if (path.startsWith("/assets/")) return true;
  return /\.(js|css|map|svg|png|jpe?g|ico|webp|woff2?|ttf|json|txt)$/.test(path);
}

async function authEndpoint(request: Request, url: URL, path: string): Promise<Response> {
  const redirectUri = `${publicOrigin(request, url)}/auth/callback`;

  if (path === "/auth/google") {
    if (!googleConfigured()) return redirect("/login?error=google_unconfigured");
    const state = randomBytes(16).toString("hex");
    return redirect(googleAuthUrl(redirectUri, state), [stateSetCookie(state)]);
  }

  if (path === "/auth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const saved = readCookie(request, OAUTH_STATE_COOKIE);
    if (!code || !state || !saved || state !== saved) {
      return redirect("/login?error=google", [stateClearCookie()]);
    }
    const gUser = await exchangeCodeForUser(code, redirectUri);
    if (!gUser) return redirect("/login?error=google", [stateClearCookie()]);
    const res = await upsertGoogleUser({ email: gUser.email, name: gUser.name, sub: gUser.sub });
    if (!res.ok)
      return redirect(`/login?error=${encodeURIComponent(res.error)}`, [stateClearCookie()]);
    return redirect("/", [stateClearCookie(), sessionCookieFor(res.user)]);
  }

  if (path === "/auth/logout") {
    return redirect("/login", [sessionClearCookie()]);
  }

  if (path === "/auth/password/login" && request.method === "POST") {
    const { email, password } = await readJson(request);
    const res = await loginWithPassword(String(email ?? ""), String(password ?? ""));
    return res.ok
      ? json({ ok: true }, [sessionCookieFor(res.user)])
      : json({ ok: false, error: res.error });
  }

  if (path === "/auth/password/signup" && request.method === "POST") {
    const { name, email, password } = await readJson(request);
    const res = await signupWithPassword(
      String(name ?? ""),
      String(email ?? ""),
      String(password ?? ""),
    );
    return res.ok
      ? json({ ok: true }, [sessionCookieFor(res.user)])
      : json({ ok: false, error: res.error });
  }

  return new Response("Not found", { status: 404 });
}

/**
 * Auth gate, run before the app in server.ts. Returns a Response to short-circuit
 * (auth endpoint, login redirect, or 401), or null to let the request through.
 */
export async function handleAuth(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith("/auth/")) return authEndpoint(request, url, path);
  if (isPublicPath(path)) return null;
  const wantsHtml =
    request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
  const denied = (clear: boolean): Response => {
    const cookies = clear ? [sessionClearCookie()] : [];
    // Page loads → login; data/server-fn calls → status code (no redirect to confuse fetch).
    return wantsHtml
      ? redirect("/login", cookies)
      : new Response("Unauthorized", { status: 401, headers: headersWith(cookies) });
  };
  const session = verifySession(readCookie(request, SESSION_COOKIE));
  if (!session) return denied(false);
  // Resolve approval status fresh from the DB so revocation takes effect immediately
  // and a pending user's valid session can't pull data via direct server-fn calls.
  const user = await findUserById(session.uid);
  if (!user || user.status === "rejected") return denied(true);
  if (user.status === "approved") return null;
  // Pending: let page loads through (the app renders the "awaiting approval" screen),
  // but block all data/API/server-fn calls.
  if (wantsHtml) return null;
  return new Response("Forbidden", { status: 403 });
}

function headersWith(cookies: string[]): Headers {
  const h = new Headers();
  for (const c of cookies) h.append("set-cookie", c);
  return h;
}
