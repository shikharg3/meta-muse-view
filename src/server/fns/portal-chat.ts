import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { ToolTrace } from "@/server/agent/events";

/**
 * The portal assistant's log and meter (`portal_chat_turns`).
 *
 * Every turn a customer gets costs the agency a model bill, and a customer-facing text box is one
 * a script can hold down. The limit is per login and per UTC day, counted from the log itself so
 * the meter and the audit trail cannot disagree about how many turns there were.
 *
 * A turn is RESERVED before it runs, not logged after: its row is inserted, under a per-login lock,
 * in the same transaction that counts the day's rows, and only filled in when the turn ends. A
 * burst of simultaneous requests therefore queues on the lock and sees each other's rows, so the
 * cap holds however the portal-stream function is called — and a turn whose final write fails, or
 * whose process dies mid-answer, stays counted rather than being free.
 */

/** Turns one portal login may take per UTC day. An admin's preview of that login is not counted. */
export const PORTAL_CHAT_DAILY_TURNS = 40;
/** What a reserved turn's `error` says until it ends. Also what a turn cut off by a crash keeps. */
const IN_PROGRESS = "in_progress";

export interface PortalTurnStart {
  portalUserId: string;
  /** The portal brand id the turn was bound to (`portalBrandOf`). */
  brandId: string;
  question: string;
  /** The previewing admin's `users.id`; null when the client asked. */
  viewedBy: string | null;
}

export type PortalTurnReservation = { ok: true; id: string } | { ok: false; used: number };

/**
 * Claim one of today's turns for `start.portalUserId`, or report the cap reached.
 *
 * The transaction-scoped advisory lock serialises the count-then-insert per login (and only per
 * login — the two-key form keeps it out of any other lock space). A preview is recorded the same
 * way but neither counted nor locked: it is the agency's own spend, not the client's allowance.
 */
export async function reservePortalTurn(
  start: PortalTurnStart,
  now = new Date(),
): Promise<PortalTurnReservation> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return db.transaction(async (tx) => {
    if (start.viewedBy === null) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('portal_chat_turns'), hashtext(${start.portalUserId}))`,
      );
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.portalChatTurns)
        .where(
          and(
            eq(schema.portalChatTurns.portalUserId, start.portalUserId),
            isNull(schema.portalChatTurns.viewedBy),
            gte(schema.portalChatTurns.createdAt, midnight),
          ),
        );
      const used = Number(row?.n ?? 0);
      if (used >= PORTAL_CHAT_DAILY_TURNS) return { ok: false, used };
    }
    const id = crypto.randomUUID();
    await tx
      .insert(schema.portalChatTurns)
      .values({ id, ...start, answer: "", error: IN_PROGRESS });
    return { ok: true, id };
  });
}

export interface PortalTurnOutcome {
  answer: string;
  toolCalls: ToolTrace[];
  error: string | null;
  model: string | null;
  costUsd: number;
}

/** Fill in a reserved turn once it has ended, successfully or not. */
export async function finishPortalTurn(id: string, outcome: PortalTurnOutcome): Promise<void> {
  await db.update(schema.portalChatTurns).set(outcome).where(eq(schema.portalChatTurns.id, id));
}

/**
 * Turns one requester may have running at once. The daily cap bounds a login's spend over a day;
 * this bounds how much of it can be spent in parallel, which the lock alone does not.
 */
export const PORTAL_CHAT_MAX_IN_FLIGHT = 2;

/**
 * An in-process count of running turns per requester key. In memory on purpose: it is a cheap
 * second layer in front of the database meter, and the web service is a single process.
 */
export class InFlightTurns {
  private readonly running = new Map<string, number>();

  constructor(private readonly limit: number) {}

  /**
   * Take a slot for `key`, or null when it already has `limit` turns running. The returned release
   * is idempotent, so every exit path may call it without double-freeing a slot.
   */
  claim(key: string): (() => void) | null {
    const held = this.running.get(key) ?? 0;
    if (held >= this.limit) return null;
    this.running.set(key, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.running.get(key) ?? 1) - 1;
      if (left <= 0) this.running.delete(key);
      else this.running.set(key, left);
    };
  }
}
