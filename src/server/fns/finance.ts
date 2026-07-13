import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";

export interface FinanceUserRow {
  userId: string;
  email: string;
  name: string | null;
  cost: number;
  calls: number; // billable assistant turns
  conversations: number; // distinct conversations
}

export interface FinanceDailyRow {
  date: string; // YYYY-MM-DD
  cost: number;
  calls: number;
}

export interface FinanceSummary {
  since: string;
  until: string;
  total: number;
  calls: number;
  conversations: number;
  users: number;
  perUser: FinanceUserRow[];
  daily: FinanceDailyRow[];
}

export interface FinanceQuery {
  since?: string; // YYYY-MM-DD inclusive
  until?: string; // YYYY-MM-DD inclusive
  userIds?: string[];
}

/**
 * Total Claude API cost, aggregated from persisted per-turn `chat_messages.cost_usd` joined through
 * conversations to their owning user. Filterable by date range + user; returns per-user and per-day
 * rollups plus overall totals. Cost is only ever set on assistant turns, so `calls` counts billed turns.
 */
export async function fetchFinance(q: FinanceQuery = {}): Promise<FinanceSummary> {
  const conds = [isNotNull(schema.chatMessages.costUsd)];
  if (q.since) conds.push(gte(schema.chatMessages.createdAt, new Date(`${q.since}T00:00:00.000Z`)));
  if (q.until) conds.push(lte(schema.chatMessages.createdAt, new Date(`${q.until}T23:59:59.999Z`)));
  if (q.userIds && q.userIds.length) conds.push(inArray(schema.conversations.userId, q.userIds));
  const where = and(...conds);

  const [perUserRows, dailyRows] = await Promise.all([
    db
      .select({
        userId: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        cost: sql<number>`coalesce(sum(${schema.chatMessages.costUsd}),0)`,
        calls: sql<number>`count(${schema.chatMessages.id})`,
        conversations: sql<number>`count(distinct ${schema.chatMessages.conversationId})`,
      })
      .from(schema.chatMessages)
      .innerJoin(
        schema.conversations,
        eq(schema.chatMessages.conversationId, schema.conversations.id),
      )
      .innerJoin(schema.users, eq(schema.conversations.userId, schema.users.id))
      .where(where)
      .groupBy(schema.users.id, schema.users.email, schema.users.name)
      .orderBy(desc(sql`coalesce(sum(${schema.chatMessages.costUsd}),0)`)),
    db
      .select({
        date: sql<string>`to_char(${schema.chatMessages.createdAt}, 'YYYY-MM-DD')`,
        cost: sql<number>`coalesce(sum(${schema.chatMessages.costUsd}),0)`,
        calls: sql<number>`count(${schema.chatMessages.id})`,
      })
      .from(schema.chatMessages)
      .innerJoin(
        schema.conversations,
        eq(schema.chatMessages.conversationId, schema.conversations.id),
      )
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`),
  ]);

  const perUser: FinanceUserRow[] = perUserRows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: r.name,
    cost: Number(r.cost),
    calls: Number(r.calls),
    conversations: Number(r.conversations),
  }));
  return {
    since: q.since ?? "",
    until: q.until ?? "",
    total: perUser.reduce((n, r) => n + r.cost, 0),
    calls: perUser.reduce((n, r) => n + r.calls, 0),
    conversations: perUser.reduce((n, r) => n + r.conversations, 0),
    users: perUser.length,
    perUser,
    daily: dailyRows.map((d) => ({ date: d.date, cost: Number(d.cost), calls: Number(d.calls) })),
  };
}
