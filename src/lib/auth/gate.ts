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

/** Public legal pages. Meta App Review requires a Privacy Policy URL (and data-deletion
 *  instructions) that a reviewer can open in a normal browser with NO session — the crawler-UA
 *  stub above is not enough for that. Served before every auth mode. */
function legalPage(path: string): Response {
  const isPrivacy = path === "/privacy";
  const title = isPrivacy ? "Privacy Policy" : "Terms of Service";
  const body = isPrivacy
    ? `
<h2>Who we are</h2>
<p>MetaConsole is an internal advertising-analytics dashboard operated by DOT (dotaudiences.com).
It is used only by our own team to monitor advertising performance for ad accounts managed in our
own Meta Business Manager. It is not offered to the public.</p>
<h2>Data we process</h2>
<ul>
<li><b>Meta advertising data</b> — campaign/ad-set/ad metadata and aggregate performance metrics
(spend, impressions, clicks, conversions) retrieved from the Meta Marketing API using system-user
credentials for ad accounts we manage. This is business data; it contains no consumer personal data
and no data about Facebook users.</li>
<li><b>Internal account data</b> — name, email address, and a hashed password for members of our
team who sign in to the dashboard, used solely for authentication and access control.</li>
<li><b>Cookies</b> — a single signed session cookie required to keep you signed in. No advertising,
tracking, or third-party cookies.</li>
</ul>
<h2>How we use it</h2>
<p>Exclusively for internal reporting and monitoring of our own advertising operations. We do not
sell, rent, or share any data with third parties. No data is used for advertising targeting or
profiling of individuals.</p>
<h2>Storage and security</h2>
<p>Data is stored in an access-controlled database on infrastructure we operate. API credentials
are stored encrypted. Access requires an approved account; transport is HTTPS only.</p>
<h2>Retention and deletion</h2>
<p>Advertising metrics are retained while we operate the affected ad accounts. Internal accounts
are removed when a team member leaves.</p>
<h2>Data deletion requests</h2>
<p>To request deletion of any data held by this application (including all data retrieved via the
Meta Marketing API for a given ad account, or an internal user account), email
<a href="mailto:shikhar@dotaudiences.com">shikhar@dotaudiences.com</a>. Requests are honored within
30 days.</p>
<h2>Contact</h2>
<p><a href="mailto:shikhar@dotaudiences.com">shikhar@dotaudiences.com</a></p>`
    : `
<h2>Use of this service</h2>
<p>MetaConsole is a private, internal tool operated by DOT (dotaudiences.com). Access is restricted
to authorized team members with approved accounts; any other use is prohibited.</p>
<h2>Accounts</h2>
<p>You are responsible for keeping your credentials confidential. We may suspend or remove accounts
at any time.</p>
<h2>Data</h2>
<p>Advertising data shown here is retrieved from the Meta Marketing API for ad accounts we manage
and is subject to our <a href="/privacy">Privacy Policy</a> and to Meta's Platform Terms.</p>
<h2>Warranty</h2>
<p>The service is provided "as is", without warranty of any kind, for internal business use.</p>
<h2>Contact</h2>
<p><a href="mailto:shikhar@dotaudiences.com">shikhar@dotaudiences.com</a></p>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — MetaConsole</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a1a1a}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:1.6em}a{color:#0b62d6}</style>
</head>
<body>
<h1>${title}</h1>
<p><i>Last updated: July 19, 2026</i></p>
${body}
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
  // Legal pages are public in EVERY mode (incl. basic-auth test mode) — App Review opens them.
  if (path === "/privacy" || path === "/terms") return legalPage(path);
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
