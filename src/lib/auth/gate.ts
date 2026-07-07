import { timingSafeEqual } from "node:crypto";
import {
  SESSION_COOKIE,
  verifySession,
  signSession,
  newSession,
  sessionSetCookie,
  sessionClearCookie,
  readCookie,
} from "./session";
import { loginWithPassword, signupWithPassword, findUserById, ensureBasicAuthUser } from "./users";
import { env } from "@/lib/env";

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

// Static assets reachable without a session (also served during basic-auth test mode).
function isStaticAsset(path: string): boolean {
  if (path.startsWith("/assets/")) return true;
  return /\.(js|css|map|svg|png|jpe?g|ico|webp|woff2?|ttf|json|txt)$/.test(path);
}

// Pages + static assets reachable without a session.
function isPublicPath(path: string): boolean {
  if (path === "/login" || path === "/signup") return true;
  return isStaticAsset(path);
}

// Meta's URL crawler (App Review "Broken URL" check + Sharing Debugger) can't authenticate, yet the
// app's public Site URL must return 200-299 to switch to Live mode. Match Meta's crawler user-agents
// and serve a minimal Open Graph stub — no dashboard data is exposed. Meta explicitly permits
// whitelisting its crawler user-agent strings for exactly this.
const META_CRAWLER_UA =
  /facebookexternalhit|facebookcatalog|facebookexternalua|meta-external(agent|fetcher)/i;
function isMetaCrawler(ua: string | null): boolean {
  return ua !== null && META_CRAWLER_UA.test(ua);
}

function metaCrawlerPage(url: URL): Response {
  const origin = `${url.protocol}//${url.host}`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MetaConsole — Meta Ads analytics</title>
<meta name="description" content="Private Meta Ads analytics dashboard. Sign in to continue." />
<meta property="og:type" content="website" />
<meta property="og:title" content="MetaConsole — Meta Ads analytics" />
<meta property="og:description" content="Private Meta Ads analytics dashboard." />
<meta property="og:url" content="${origin}/" />
</head>
<body>
<h1>MetaConsole</h1>
<p>Private Meta Ads analytics dashboard. Please sign in to continue.</p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const BASIC_REALM = 'Basic realm="MetaConsole (testing)", charset="UTF-8"';

/** Test-mode credentials: when both env vars are set, HTTP Basic Auth replaces login. */
function basicAuthCreds(): { user: string; pass: string } | null {
  const e = env();
  if (e.BASIC_AUTH_USER && e.BASIC_AUTH_PASS) {
    return { user: e.BASIC_AUTH_USER, pass: e.BASIC_AUTH_PASS };
  }
  return null;
}

function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Test-mode gate: a single shared HTTP Basic Auth credential stands in for the
 * Google/email login. A valid challenge seeds (once) and signs in a shared admin,
 * so the rest of the app (loaders, requireAdmin) is unchanged. Reverts the moment
 * the BASIC_AUTH_* env vars are unset.
 */
async function handleBasicAuth(
  request: Request,
  url: URL,
  path: string,
  creds: { user: string; pass: string },
): Promise<Response | null> {
  if (isStaticAsset(path)) return null;
  if (path === "/auth/logout") return redirect("/", [sessionClearCookie()]);
  if (path.startsWith("/auth/")) return new Response("Not found", { status: 404 });
  // The Google/email pages are replaced by the browser's basic-auth prompt.
  if (path === "/login" || path === "/signup") return redirect("/");

  // Already signed in via the seeded test session → let it through.
  const session = verifySession(readCookie(request, SESSION_COOKIE));
  if (session) {
    const u = await findUserById(session.uid);
    if (u && u.status === "approved") return null;
  }

  const provided = parseBasicAuth(request.headers.get("authorization"));
  if (!provided || !safeEqual(provided.user, creds.user) || !safeEqual(provided.pass, creds.pass)) {
    return new Response("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": BASIC_REALM },
    });
  }
  // Valid credentials → start the shared admin session, then reload via the cookie.
  const user = await ensureBasicAuthUser();
  return redirect(url.pathname + url.search, [sessionCookieFor(user)]);
}

async function authEndpoint(request: Request, path: string): Promise<Response> {
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
  const basic = basicAuthCreds();
  if (basic) return handleBasicAuth(request, url, path, basic);
  if (path.startsWith("/auth/")) return authEndpoint(request, path);
  if (isPublicPath(path)) return null;
  // Meta's URL crawler must get a direct 200 for the Site URL (App Review), never a login redirect.
  if (isMetaCrawler(request.headers.get("user-agent"))) return metaCrawlerPage(url);
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
