import { test, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import {
  createConversation,
  appendTurn,
  getConversation,
  listConversations,
  deleteConversation,
} from "./conversations";

beforeEach(async () => {
  await db.execute(sql`truncate table conversations, chat_messages, users cascade`);
  await db.insert(schema.users).values([
    { id: "userA", email: "a@example.com" },
    { id: "userB", email: "b@example.com" },
  ]);
});

test("conversations round-trip: ownership, ordering, payload + cost, cascade delete", async () => {
  const id = await createConversation("userA", "Spend Q");

  await appendTurn(id, "hi", {
    content: "hello",
    payload: { cards: null, report: null, toolCalls: [] },
    costUsd: 0.02,
  });

  const messages = await getConversation("userA", id);
  if (!messages) throw new Error("expected messages, got null");
  expect(messages.length).toBe(2);
  expect(messages[0]).toEqual({ role: "user", content: "hi", payload: null, costUsd: null });
  expect(messages[1]).toEqual({
    role: "assistant",
    content: "hello",
    payload: { cards: null, report: null, toolCalls: [] },
    costUsd: 0.02,
  });

  const summaries = await listConversations("userA");
  expect(summaries.length).toBe(1);
  expect(summaries[0].title).toBe("Spend Q");
  // The nudge and the header meter are driven off these two, so they are a real contract now.
  expect(summaries[0].turns).toBe(1);
  expect(summaries[0].costUsd).toBeCloseTo(0.02);

  // Ownership: userB cannot read userA's conversation.
  expect(await getConversation("userB", id)).toBeNull();

  await deleteConversation("userA", id);
  expect(await getConversation("userA", id)).toBeNull();

  // Cascade removed the messages.
  const rows = (await db.execute(
    sql`select count(*)::int as count from chat_messages where conversation_id = ${id}`,
  )) as unknown as { count: number }[];
  expect(rows[0].count).toBe(0);
});

test("thread cost sums every answered turn, and replay never reaches the browser", async () => {
  const id = await createConversation("userA", "Long thread");
  for (const cost of [0.05, 0.11, 0.2]) {
    await appendTurn(id, "q", {
      content: "a",
      payload: {
        cards: null,
        report: null,
        toolCalls: [],
        // Replay is what makes a long thread expensive AND what must not be shipped to the client:
        // it is thousands of characters of raw tool output per turn.
        replay: [
          { name: "list_clients", input: { days: 7 }, result: "[]", at: "2026-09-01T00:00:00Z" },
        ],
        usage: { input: 100, output: 20, cacheWrite: 0, cacheRead: 0 },
      },
      costUsd: cost,
    });
  }

  const [summary] = await listConversations("userA");
  expect(summary.turns).toBe(3);
  expect(summary.costUsd).toBeCloseTo(0.36);

  const client = await getConversation("userA", id);
  const assistant = client?.filter((m) => m.role === "assistant") ?? [];
  expect(assistant).toHaveLength(3);
  for (const m of assistant) {
    expect(m.payload).not.toBeNull();
    expect(m.payload && "replay" in m.payload).toBe(false);
    expect(m.payload && "usage" in m.payload).toBe(false);
  }
});

test("a conversation with no answers yet reports zero rather than null", async () => {
  await createConversation("userA", "Empty");
  const [summary] = await listConversations("userA");
  expect(summary.turns).toBe(0);
  expect(summary.costUsd).toBe(0);
});
