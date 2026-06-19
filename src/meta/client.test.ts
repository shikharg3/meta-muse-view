import { test, expect } from "bun:test";
import { MetaClient } from "./client";
import type { MetaApiEvent } from "./types";

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

test("retries Meta rate-limit error codes (#17) then succeeds", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1)
      return jsonResponse({ error: { code: 17, message: "(#17) User request limit reached" } });
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

test("applies a persisted field blocklist on load, skipping those fields without probing", async () => {
  const urls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    urls.push(String(url));
    return jsonResponse({ data: [{ id: "ok" }] });
  };
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      fieldStore: {
        load: async (k) => (k === "campaigns" ? ["gated"] : []),
        save: async () => {},
      },
    },
  );
  const rows = await client.getChildren("act_1", "campaigns", ["id", "gated", "name"]);
  expect(rows[0].id).toBe("ok");
  expect(urls).toHaveLength(1); // blocklist applied up front: no error round-trip, no bisection
  expect(urls[0]).not.toContain("gated");
});

test("emits a rate_limit event when retries are exhausted on a #17", async () => {
  const events: MetaApiEvent[] = [];
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    {
      fetchImpl: (async () =>
        jsonResponse({
          error: { code: 17, message: "User request limit reached" },
        })) as unknown as typeof fetch,
      sleep: async () => {},
      maxRetries: 1,
      onEvent: (e) => events.push(e),
    },
  );
  await expect(client.getChildren("act_1", "campaigns", ["id"])).rejects.toThrow(/error 17/);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: "rate_limit", code: 17, accountId: "act_1" });
});

test("emits a proactive rate_limit event when usage headers cross the threshold", async () => {
  const events: MetaApiEvent[] = [];
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    {
      fetchImpl: (async () =>
        jsonResponse(
          { data: [] },
          {
            "x-business-use-case-usage": JSON.stringify({
              act_1: [{ type: "ads_insights", call_count: 95, total_cputime: 10, total_time: 10 }],
            }),
          },
        )) as unknown as typeof fetch,
      sleep: async () => {},
      onEvent: (e) => events.push(e),
    },
  );
  await client.getChildren("act_1", "campaigns", ["id"]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: "rate_limit", code: 0 });
  expect(events[0].pressure).toBe(95);
});

test("async insights recover from a named bad field via the memoKey", async () => {
  const posts: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: { method?: string }) => {
    const u = String(url);
    if (init?.method === "POST") {
      posts.push(u);
      if (u.includes("bad"))
        return jsonResponse({ error: { code: 100, message: "(#100) nonexisting field (bad)" } });
      return jsonResponse({ report_run_id: "run1" });
    }
    if (u.includes("run1/insights"))
      return jsonResponse({ data: [{ date_start: "2026-06-01", spend: "5" }] });
    if (u.includes("run1")) return jsonResponse({ async_status: "Job Completed" });
    return jsonResponse({ data: [] });
  }) as unknown as typeof fetch;
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    { fetchImpl, sleep: async () => {} },
  );
  const rows = await client.runAsyncInsights(
    "act_1",
    { level: "account", fields: ["good", "bad"] },
    { memoKey: "insights:account:" },
  );
  expect(rows).toHaveLength(1);
  expect(posts.some((u) => u.includes("bad"))).toBe(true); // first submit tried the bad field
  expect(posts.length).toBeGreaterThanOrEqual(2); // then retried without it
});

test("drops a field Meta says must be queried alone (#100 total_postbacks)", async () => {
  const seen: string[][] = [];
  const fetchImpl = (async (url: string | URL) => {
    const fields = (new URL(String(url)).searchParams.get("fields") ?? "")
      .split(",")
      .filter(Boolean);
    seen.push(fields);
    if (fields.includes("total_postbacks"))
      return jsonResponse({
        error: {
          code: 100,
          message: "(#100) total_postbacks should not be queried with other field values.",
        },
      });
    return jsonResponse({ data: [{ id: "ok" }] });
  }) as unknown as typeof fetch;
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    { fetchImpl, sleep: async () => {} },
  );
  const rows = await client.getInsights("act_1", {
    level: "account",
    fields: ["spend", "total_postbacks"],
  });
  expect(rows[0].id).toBe("ok");
  expect(seen.at(-1)).not.toContain("total_postbacks"); // retried without the exclusive field
});

test("fails fast on a transient #2 (few retries, not a rate-limit event)", async () => {
  let n = 0;
  const events: MetaApiEvent[] = [];
  const client = new MetaClient(
    { appId: "1", appSecret: "s", token: "t", version: "v25.0" },
    {
      fetchImpl: (async () => {
        n++;
        return jsonResponse({ error: { code: 2, message: "Service temporarily unavailable" } });
      }) as unknown as typeof fetch,
      sleep: async () => {},
      maxRetries: 5,
      onEvent: (e) => events.push(e),
    },
  );
  await expect(client.getChildren("act_1", "campaigns", ["id"])).rejects.toThrow(/error 2/);
  expect(n).toBeLessThanOrEqual(4); // ~3 quick retries, NOT the 5 maxRetries a rate limit gets
  expect(events).toHaveLength(0); // a transient service error is not surfaced as a rate-limit
});
