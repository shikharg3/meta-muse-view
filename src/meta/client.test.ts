import { test, expect } from "bun:test";
import { MetaClient } from "./client";

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("follows cursor pagination and aggregates pages", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("after=CURSOR1")) {
      return jsonResponse({ data: [{ id: "b" }], paging: {} });
    }
    return jsonResponse({
      data: [{ id: "a" }],
      paging: { cursors: { after: "CURSOR1" }, next: "x" },
    });
  };
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
  );
  const rows = await client.getChildren("act_1", "campaigns", ["id"]);
  expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("appsecret_proof=");
});

test("retries on 429 then succeeds", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return new Response("{}", { status: 429 });
    return jsonResponse({ data: [{ id: "ok" }] });
  };
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
  );
  const rows = await client.getChildren("act_1", "campaigns", ["id"]);
  expect(rows[0].id).toBe("ok");
  expect(n).toBe(2);
});

test("getAccounts enumerates strictly via /me/adaccounts (token's assigned set), ignoring BM edges", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("me/adaccounts"))
      return jsonResponse({ data: [{ id: "act_1" }, { id: "act_2" }] });
    // owned/client edges must NOT be queried — they include unassigned accounts.
    return jsonResponse({ data: [{ id: "act_should_not_appear" }] });
  };
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
  );
  // Numeric BM id present, but enumeration still only uses /me/adaccounts.
  const ids = (await client.getAccounts("696773192960095")).map((a) => a.id).sort();
  expect(ids).toEqual(["act_1", "act_2"]);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("me/adaccounts");
  expect(
    calls.some((u) => u.includes("owned_ad_accounts") || u.includes("client_ad_accounts")),
  ).toBe(false);
});

test("drops fields Meta rejects, then remembers them for later calls", async () => {
  const urls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    urls.push(u);
    const fields = (new URL(u).searchParams.get("fields") ?? "").split(",");
    if (fields.includes("bad_field"))
      return jsonResponse({
        error: {
          code: 100,
          message: "(#100) Tried accessing nonexisting field (bad_field) on node type (Campaign)",
        },
      });
    return jsonResponse({ data: [{ id: "ok" }] });
  };
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
  );
  const rows1 = await client.getChildren("act_1", "campaigns", ["id", "bad_field", "name"]);
  expect(rows1[0].id).toBe("ok");
  expect(urls).toHaveLength(2); // first attempt errors, retry without bad_field succeeds
  expect(urls[1]).not.toContain("bad_field");
  // Same edge again: the bad field is remembered, so no wasted error round-trip.
  urls.length = 0;
  await client.getChildren("act_1", "campaigns", ["id", "bad_field", "name"]);
  expect(urls).toHaveLength(1);
  expect(urls[0]).not.toContain("bad_field");
});

test("isolates an unnamed permission-gated field by bisection, then remembers it", async () => {
  const urls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    urls.push(u);
    const fields = (new URL(u).searchParams.get("fields") ?? "").split(",").filter(Boolean);
    if (fields.includes("gated"))
      return jsonResponse({
        error: { code: 10, message: "(#10) Application does not have permission for this action" },
      });
    return jsonResponse({ data: [{ id: "ok" }] });
  };
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
  );
  const rows = await client.getChildren("act_1", "campaigns", ["id", "gated", "name", "status"]);
  expect(rows[0].id).toBe("ok"); // bisected out the gated field, request succeeded
  // Second call remembers "gated": no error round-trip, one clean request omitting it.
  urls.length = 0;
  const rows2 = await client.getChildren("act_1", "campaigns", ["id", "gated", "name", "status"]);
  expect(rows2[0].id).toBe("ok");
  expect(urls).toHaveLength(1);
  expect(urls.every((u) => !u.includes("gated"))).toBe(true);
});
