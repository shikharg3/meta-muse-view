import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { ChatResult, ToolTrace } from "@/server/agent/chat";

// Idempotent prod migration (run once on the droplet before deploying):
//
//   CREATE TABLE IF NOT EXISTS conversations (
//     id text PRIMARY KEY,
//     user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//     title text NOT NULL,
//     created_at timestamptz NOT NULL DEFAULT now(),
//     updated_at timestamptz NOT NULL DEFAULT now()
//   );
//   CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id);
//
//   CREATE TABLE IF NOT EXISTS chat_messages (
//     id text PRIMARY KEY,
//     conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
//     role text NOT NULL,
//     content text NOT NULL,
//     payload jsonb,
//     cost_usd double precision,
//     created_at timestamptz NOT NULL DEFAULT now()
//   );
//   CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages (conversation_id);

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

/** Rich per-message payload persisted as jsonb (all fields JSON-serializable). */
export interface MessagePayload {
  cards: ChatResult["cards"];
  report: ChatResult["report"];
  toolCalls: ToolTrace[];
  error?: string;
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  payload: MessagePayload | null;
  costUsd: number | null;
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed ? trimmed.slice(0, 80) : "New chat";
}

export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  const rows = await db
    .select({
      id: schema.conversations.id,
      title: schema.conversations.title,
      updatedAt: schema.conversations.updatedAt,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.userId, userId))
    .orderBy(desc(schema.conversations.updatedAt));
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
}

export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<StoredMessage[] | null> {
  const [owned] = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(eq(schema.conversations.id, conversationId), eq(schema.conversations.userId, userId)),
    )
    .limit(1);
  if (!owned) return null;

  const rows = await db
    .select({
      role: schema.chatMessages.role,
      content: schema.chatMessages.content,
      payload: schema.chatMessages.payload,
      costUsd: schema.chatMessages.costUsd,
    })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.conversationId, conversationId))
    .orderBy(asc(schema.chatMessages.createdAt));
  return rows.map((r) => ({
    role: r.role as StoredMessage["role"],
    content: r.content,
    payload: r.payload as MessagePayload | null,
    costUsd: r.costUsd,
  }));
}

export async function createConversation(userId: string, title: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(schema.conversations).values({
    id,
    userId,
    title: normalizeTitle(title),
  });
  return id;
}

export async function renameConversation(userId: string, id: string, title: string): Promise<void> {
  await db
    .update(schema.conversations)
    .set({ title: normalizeTitle(title), updatedAt: new Date() })
    .where(and(eq(schema.conversations.id, id), eq(schema.conversations.userId, userId)));
}

export async function deleteConversation(userId: string, id: string): Promise<void> {
  await db
    .delete(schema.conversations)
    .where(and(eq(schema.conversations.id, id), eq(schema.conversations.userId, userId)));
}

export async function appendTurn(
  conversationId: string,
  userContent: string,
  assistant: { content: string; payload: MessagePayload; costUsd: number },
): Promise<void> {
  await db.insert(schema.chatMessages).values({
    id: crypto.randomUUID(),
    conversationId,
    role: "user",
    content: userContent,
    payload: null,
    costUsd: null,
  });
  await db.insert(schema.chatMessages).values({
    id: crypto.randomUUID(),
    conversationId,
    role: "assistant",
    content: assistant.content,
    payload: assistant.payload,
    costUsd: assistant.costUsd,
  });
  await db
    .update(schema.conversations)
    .set({ updatedAt: new Date() })
    .where(eq(schema.conversations.id, conversationId));
}
