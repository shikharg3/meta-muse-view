import { test, expect, beforeEach } from "bun:test";
import { sql as dsql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { fetchFinance } from "./finance";
import { listAllConversations, getAnyConversation } from "./conversations";

async function seed() {
  await db.execute(dsql`truncate table chat_messages, conversations, users cascade`);
  await db.insert(schema.users).values([
    { id: "u1", email: "a@x.com", name: "Alice", role: "member", status: "approved" },
    { id: "u2", email: "b@x.com", name: "Bob", role: "admin", status: "approved" },
  ]);
  await db.insert(schema.conversations).values([
    { id: "c1", userId: "u1", title: "Alice chat" },
    { id: "c2", userId: "u2", title: "Bob chat" },
  ]);
  await db.insert(schema.chatMessages).values([
    {
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "hi",
      costUsd: null,
      createdAt: new Date("2026-07-01T10:00:00Z"),
    },
    {
      id: "m2",
      conversationId: "c1",
      role: "assistant",
      content: "hello",
      costUsd: 0.1,
      createdAt: new Date("2026-07-01T10:00:01Z"),
    },
    {
      id: "m3",
      conversationId: "c1",
      role: "assistant",
      content: "more",
      costUsd: 0.2,
      createdAt: new Date("2026-07-05T10:00:00Z"),
    },
    {
      id: "m4",
      conversationId: "c2",
      role: "assistant",
      content: "bob reply",
      costUsd: 0.5,
      createdAt: new Date("2026-07-05T10:00:00Z"),
    },
  ]);
}
beforeEach(seed);

test("fetchFinance sums cost per user with overall totals (billed turns only)", async () => {
  const f = await fetchFinance();
  expect(f.total).toBeCloseTo(0.8);
  expect(f.calls).toBe(3); // 3 assistant messages carry cost; the user message (null) is excluded
  expect(f.users).toBe(2);
  const alice = f.perUser.find((r) => r.email === "a@x.com");
  expect(alice?.cost).toBeCloseTo(0.3);
  expect(alice?.calls).toBe(2);
  expect(alice?.conversations).toBe(1);
  // sorted by cost desc → Bob ($0.50) first
  expect(f.perUser[0].email).toBe("b@x.com");
});

test("fetchFinance filters by user and by date range", async () => {
  const byUser = await fetchFinance({ userIds: ["u2"] });
  expect(byUser.total).toBeCloseTo(0.5);
  expect(byUser.users).toBe(1);

  const byDate = await fetchFinance({ since: "2026-07-01", until: "2026-07-01" });
  expect(byDate.total).toBeCloseTo(0.1); // only the 07-01 assistant turn
  expect(byDate.calls).toBe(1);
});

test("cross-user chat history: listAllConversations + getAnyConversation ignore ownership", async () => {
  const all = await listAllConversations();
  expect(all.length).toBe(2);
  const c1 = all.find((c) => c.id === "c1");
  expect(c1?.userEmail).toBe("a@x.com");
  expect(c1?.messages).toBe(3);
  expect(c1?.costUsd).toBeCloseTo(0.3);

  const filtered = await listAllConversations("u2");
  expect(filtered.map((c) => c.id)).toEqual(["c2"]);

  const detail = await getAnyConversation("c1");
  expect(detail?.userEmail).toBe("a@x.com");
  expect(detail?.messages.length).toBe(3);
  expect(detail?.messages[0].content).toBe("hi");
});
