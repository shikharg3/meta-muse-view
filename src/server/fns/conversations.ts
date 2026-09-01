import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { MessageExtras } from "@/server/agent/events";
import type { ReplayedTool } from "@/server/agent/chat";
import type { TokenUsage } from "@/server/agent/pricing";

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
  /** Answered questions in the thread. Drives the "this is getting long" nudge. */
  turns: number;
  /** What the thread has cost so far. One thread reached $59 before anyone noticed. */
  costUsd: number;
}

/**
 * Rich per-message payload persisted as jsonb (all fields JSON-serializable).
 *
 * `replay` is the consequential one: the tool results this turn fetched, fed back into the next
 * turn's context. Without it the model saw its own prose and nothing behind it, so every follow-up
 * re-ran the whole tool chain. Every field is optional on read — rows written before a field existed
 * must keep loading.
 */
export interface MessagePayload extends Partial<MessageExtras> {
  /** Tool results captured this turn, replayed into the next one. */
  replay?: ReplayedTool[];
  /** Which model answered, so cost can be attributed after the fact. */
  model?: string;
  /** Raw token counts; `cost_usd` is derived from these and the rates of the day. */
  usage?: TokenUsage;
  error?: string;
}

/**
 * What the browser gets. Deliberately NOT the full payload.
 *
 * `replay` holds every tool result the turn fetched — thousands of characters per turn that the UI
 * never renders. Shipping it would put the entire conversation's raw data through the wire on every
 * thread open, and TanStack's serializer rejects its `Record<string, unknown>` anyway.
 */
export type ClientMessagePayload = Omit<MessagePayload, "replay" | "usage">;

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  payload: ClientMessagePayload | null;
  costUsd: number | null;
}

/** Server-side view, replay included. Only the streaming turn needs this. */
export interface StoredMessageFull extends Omit<StoredMessage, "payload"> {
  payload: MessagePayload | null;
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
      turns: sql<number>`count(${schema.chatMessages.id}) filter (where ${schema.chatMessages.role} = 'assistant')`,
      costUsd: sql<number>`coalesce(sum(${schema.chatMessages.costUsd}), 0)`,
    })
    .from(schema.conversations)
    .leftJoin(schema.chatMessages, eq(schema.chatMessages.conversationId, schema.conversations.id))
    .where(eq(schema.conversations.userId, userId))
    .groupBy(schema.conversations.id)
    .orderBy(desc(schema.conversations.updatedAt));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updatedAt.toISOString(),
    turns: Number(r.turns),
    costUsd: Number(r.costUsd),
  }));
}

/** Full rows including replay. Server-only — see `ClientMessagePayload`. */
export async function getConversationFull(
  userId: string,
  conversationId: string,
): Promise<StoredMessageFull[] | null> {
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

export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<StoredMessage[] | null> {
  const full = await getConversationFull(userId, conversationId);
  if (!full) return null;
  return full.map((m) => {
    if (!m.payload) return { ...m, payload: null };
    const { replay: _replay, usage: _usage, ...client } = m.payload;
    return { ...m, payload: client };
  });
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

// ── Superadmin-only cross-user views (see requireSuperadmin gate in the API layer) ──────────────

export interface AdminConversation {
  id: string;
  title: string;
  updatedAt: string;
  userId: string;
  userEmail: string;
  userName: string | null;
  messages: number;
  costUsd: number;
}

/** Every conversation across ALL users (optionally one user), with per-conversation message count
 * and total cost. Superadmin-only — bypasses the per-user ownership scoping above. */
export async function listAllConversations(userId?: string): Promise<AdminConversation[]> {
  const convs = await db
    .select({
      id: schema.conversations.id,
      title: schema.conversations.title,
      updatedAt: schema.conversations.updatedAt,
      userId: schema.conversations.userId,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.conversations)
    .innerJoin(schema.users, eq(schema.conversations.userId, schema.users.id))
    .where(userId ? eq(schema.conversations.userId, userId) : undefined)
    .orderBy(desc(schema.conversations.updatedAt));
  if (convs.length === 0) return [];
  const agg = await db
    .select({
      conversationId: schema.chatMessages.conversationId,
      messages: sql<number>`count(*)`,
      cost: sql<number>`coalesce(sum(${schema.chatMessages.costUsd}),0)`,
    })
    .from(schema.chatMessages)
    .groupBy(schema.chatMessages.conversationId);
  const aggById = new Map(agg.map((a) => [a.conversationId, a]));
  return convs.map((c) => {
    const a = aggById.get(c.id);
    return {
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt.toISOString(),
      userId: c.userId,
      userEmail: c.email,
      userName: c.name,
      messages: Number(a?.messages ?? 0),
      costUsd: Number(a?.cost ?? 0),
    };
  });
}

export interface AdminConversationDetail {
  id: string;
  title: string;
  userEmail: string;
  userName: string | null;
  messages: StoredMessage[];
}

/** Full message transcript for ANY conversation (no ownership check). Superadmin-only. */
export async function getAnyConversation(
  conversationId: string,
): Promise<AdminConversationDetail | null> {
  const [conv] = await db
    .select({
      id: schema.conversations.id,
      title: schema.conversations.title,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.conversations)
    .innerJoin(schema.users, eq(schema.conversations.userId, schema.users.id))
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  if (!conv) return null;
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
  return {
    id: conv.id,
    title: conv.title,
    userEmail: conv.email,
    userName: conv.name,
    messages: rows.map((r) => ({
      role: r.role as StoredMessage["role"],
      content: r.content,
      payload: r.payload as MessagePayload | null,
      costUsd: r.costUsd,
    })),
  };
}
