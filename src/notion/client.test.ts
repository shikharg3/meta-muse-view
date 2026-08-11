import { test, expect } from "bun:test";
import { NotionClient } from "./client";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch stand-in that records calls and replays queued JSON responses. */
function recorder(responses: unknown[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(responses[calls.length - 1] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const schemaWith = (names: string[]) => ({
  properties: {
    "Account Status": {
      id: "biOx",
      name: "Account Status",
      type: "status",
      status: { options: names.map((name, i) => ({ id: `id${i}`, name, color: "default" })) },
    },
  },
});

test("addStatusOptions appends only the missing options and keeps the existing ones", async () => {
  const { calls, impl } = recorder([schemaWith(["Live", "Paused"]), {}]);
  const client = new NotionClient("tok", impl);

  const added = await client.addStatusOptions("ds1", "Account Status", [
    "Live",
    "All ads rejected",
    "Ad Account Blocked",
  ]);

  expect(added).toEqual(["All ads rejected", "Ad Account Blocked"]);
  expect(calls[1].method).toBe("PATCH");
  const sent = calls[1].body as {
    properties: { "Account Status": { status: { options: { name: string }[] } } };
  };
  // Existing options are resent: the array REPLACES the list, so omitting one deletes it.
  expect(sent.properties["Account Status"].status.options.map((o) => o.name)).toEqual([
    "Live",
    "Paused",
    "All ads rejected",
    "Ad Account Blocked",
  ]);
});

test("addStatusOptions makes no write when every option already exists", async () => {
  const { calls, impl } = recorder([schemaWith(["Live", "Paused"])]);
  const client = new NotionClient("tok", impl);

  const added = await client.addStatusOptions("ds1", "Account Status", ["Live", "Paused"]);

  expect(added).toEqual([]);
  expect(calls).toHaveLength(1); // read only, no PATCH
});

test("addStatusOptions matches option names case-insensitively", async () => {
  // Notion requires option names to be unique case-insensitively, so "live" is not addable
  // alongside "Live" — attempting it would 400.
  const { calls, impl } = recorder([schemaWith(["Live"])]);
  const client = new NotionClient("tok", impl);

  expect(await client.addStatusOptions("ds1", "Account Status", ["live"])).toEqual([]);
  expect(calls).toHaveLength(1);
});

test("addStatusOptions rejects a name containing a comma", async () => {
  // Commas are not valid in Notion option names; failing loudly beats a 400 from the API.
  const { impl } = recorder([schemaWith(["Live"])]);
  const client = new NotionClient("tok", impl);

  await expect(client.addStatusOptions("ds1", "Account Status", ["a,b"])).rejects.toThrow("comma");
});

test("addStatusOptions throws when the property is not a status property", async () => {
  const { impl } = recorder([
    { properties: { "Account Status": { id: "x", name: "Account Status", type: "select" } } },
  ]);
  const client = new NotionClient("tok", impl);

  await expect(client.addStatusOptions("ds1", "Account Status", ["Live"])).rejects.toThrow("status");
});
