import { test, expect } from "bun:test";
import { handleAuth } from "./gate";

test("privacy and terms are public (no session) — App Review opens them unauthenticated", async () => {
  for (const path of ["/privacy", "/terms"]) {
    const res = await handleAuth(new Request(`https://example.com${path}`));
    if (!res) throw new Error(`${path} fell through the gate`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(path === "/privacy" ? "Privacy Policy" : "Terms of Service");
    expect(html).toContain("shikhar@dotaudiences.com");
  }
});

test("an unauthenticated page load is still redirected to login", async () => {
  const res = await handleAuth(
    new Request("https://example.com/", { headers: { accept: "text/html" } }),
  );
  if (!res) throw new Error("unauthenticated request fell through");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/login");
});
