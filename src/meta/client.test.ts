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
    return jsonResponse({ data: [{ id: "a" }], paging: { cursors: { after: "CURSOR1" }, next: "x" } });
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
