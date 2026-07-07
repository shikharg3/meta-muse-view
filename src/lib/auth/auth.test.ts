import { test, expect, beforeAll } from "bun:test";
import { hashPassword, verifyPassword } from "./password";
import { signSession, verifySession, newSession } from "./session";
import { handleAuth } from "./gate";

beforeAll(() => {
  // session signing needs APP_ENCRYPTION_KEY
  process.env.APP_ENCRYPTION_KEY ??= "a".repeat(64);
  process.env.DATABASE_URL ??= "postgres://x";
});

test("password hash verifies and rejects wrong password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  expect(hash.startsWith("scrypt:")).toBe(true);
  expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  expect(await verifyPassword("wrong", hash)).toBe(false);
  expect(await verifyPassword("x", null)).toBe(false);
  expect(await verifyPassword("x", "garbage")).toBe(false);
});

test("password hashes are salted (distinct for same input)", async () => {
  expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
});

test("session round-trips and rejects tampering + expiry", () => {
  const token = signSession(newSession("u1", "a@b.com"));
  const s = verifySession(token);
  expect(s?.uid).toBe("u1");
  expect(s?.email).toBe("a@b.com");

  // tampered payload (flip a char) → rejected
  expect(verifySession("x" + token.slice(1))).toBeNull();
  expect(verifySession(token + "z")).toBeNull();
  expect(verifySession(null)).toBeNull();
  expect(verifySession("nodot")).toBeNull();

  // expired session → rejected
  const expired = signSession({ uid: "u", email: "e", exp: Math.floor(Date.now() / 1000) - 10 });
  expect(verifySession(expired)).toBeNull();
});

test("Meta crawler UA gets a 200 OG stub, not a login redirect", async () => {
  const res = await handleAuth(
    new Request("https://analytics.madsmonitor.com/", {
      headers: {
        "user-agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      },
    }),
  );
  if (!res) throw new Error("expected a Response from the gate");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('property="og:title"');
  expect(body).toContain("https://analytics.madsmonitor.com/");
});

test("meta-externalagent crawler is matched too", async () => {
  const res = await handleAuth(
    new Request("https://analytics.madsmonitor.com/", {
      headers: { "user-agent": "meta-externalagent/1.1" },
    }),
  );
  if (!res) throw new Error("expected a Response from the gate");
  expect(res.status).toBe(200);
});

test("browser with no session is redirected to /login, never a violating code", async () => {
  const res = await handleAuth(
    new Request("https://analytics.madsmonitor.com/", { headers: { accept: "text/html" } }),
  );
  if (!res) throw new Error("expected a Response from the gate");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/login");
});

test("non-crawler, non-browser request with no session gets 401", async () => {
  const res = await handleAuth(new Request("https://analytics.madsmonitor.com/api/x"));
  if (!res) throw new Error("expected a Response from the gate");
  expect(res.status).toBe(401);
});
