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
import { loginWithPassword, signupWithPassword, upsertGoogleUser } from "./users";

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
  if (verifySession(readCookie(request, SESSION_COOKIE))) return null;

  // Unauthenticated: send page loads to /login, fail API/server-fn calls with 401.
  const accept = request.headers.get("accept") ?? "";
  if (request.method === "GET" && accept.includes("text/html")) return redirect("/login");
  return new Response("Unauthorized", { status: 401 });
}
