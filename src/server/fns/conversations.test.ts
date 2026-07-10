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
