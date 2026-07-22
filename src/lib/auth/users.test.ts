import { test, expect, beforeEach } from "bun:test";
import { sql as dsql } from "drizzle-orm";
import { db } from "@/db/client";
import { signupWithPassword, loginWithPassword, setUserPassword } from "./users";

beforeEach(async () => {
  await db.execute(dsql`truncate table users cascade`);
});

test("setUserPassword rotates the password: old login fails, new login works", async () => {
  const s = await signupWithPassword("Test User", "reset.me@x.com", "old-password-1");
  if (!s.ok) throw new Error(s.error);

  const short = await setUserPassword(s.user.id, "short");
  expect(short.ok).toBe(false); // mirrors signup's minimum length

  const r = await setUserPassword(s.user.id, "new-password-22");
  expect(r.ok).toBe(true);

  const oldLogin = await loginWithPassword("reset.me@x.com", "old-password-1");
  expect(oldLogin.ok).toBe(false);
  const newLogin = await loginWithPassword("reset.me@x.com", "new-password-22");
  expect(newLogin.ok).toBe(true);
});
