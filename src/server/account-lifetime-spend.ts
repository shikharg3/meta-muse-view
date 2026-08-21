import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";

/**
 * Lifetime spend per ad account for DISPLAY, in minor units, taken from our own daily records.
 *
 * ## Why `accounts.amount_spent` cannot answer this
 *
 * That column is Meta's `amount_spent`, and it is scoped to the CURRENT `spend_cap` cycle, not to the
 * account's life. Meta resets it when a cap is topped up, which is why the pair is only ever
 * meaningful together. Measured against production on 2026-08-21:
 *
 * - 172 of 203 accounts report `amount_spent = 0`, and **171 of those are uncapped** — for an uncapped
 *   account the field has nothing to count against, so 0 is correct and `canDeliver` never reads it.
 * - 11 capped accounts sit at `amount_spent == spend_cap` exactly: the "cap spent to the cent" state
 *   `canDeliver` is already tested against.
 * - 4 capped accounts have `spend_cap` BELOW their lifetime recorded spend, which is only coherent if
 *   the cap is a current-cycle ceiling that has been reset.
 *
 * ## What this is for, and what it must never be used for
 *
 * Reading a cycle-scoped counter as a lifetime total is what showed one of 5bet.com's disabled
 * accounts as "$0.00 spent" on the account page and through Ask while our own daily rows held
 * $1,135.25. This function fixes that, and only that.
 *
 * It MUST NOT be substituted into `spend_cap − amount_spent`. That subtraction is correct precisely
 * because both sides come from the same Meta cycle; feeding a lifetime total into it drives accounts
 * negative (measured: one to −$16,089.22) and makes accounts with real headroom look exhausted. The
 * funds math in `sync/jobs/notion-budget.ts` and the low-funds alert in `sync/alerts.ts` deliberately
 * keep using Meta's figure, and this module is not imported by either.
 */
export async function lifetimeSpendByAccount(accountIds?: string[]): Promise<Map<string, number>> {
  // An explicit empty list means "no accounts", not "all of them" — without this guard a caller that
  // resolved to zero accounts would silently aggregate the whole table.
  if (accountIds && accountIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: schema.accounts.id,
      reported: schema.accounts.amountSpent,
      // Scaled to minor units inside the query: `insights_daily.spend` is major-unit double
      // precision, and summing hundreds of them in JS before scaling reintroduces the float error at
      // the point the two figures are compared.
      recorded: sql<number>`coalesce(round(sum(${schema.insightsDaily.spend}) * 100), 0)`,
    })
    .from(schema.accounts)
    .leftJoin(
      schema.insightsDaily,
      and(
        eq(schema.insightsDaily.entityId, schema.accounts.id),
        // Account-level rows only. Campaign-level rows exist as well, for accounts shared between
        // clients, and summing both would double-count every shared account.
        eq(schema.insightsDaily.level, "account"),
      ),
    )
    .where(accountIds ? inArray(schema.accounts.id, accountIds) : undefined)
    .groupBy(schema.accounts.id, schema.accounts.amountSpent);

  const out = new Map<string, number>();
  for (const r of rows) out.set(r.id, lifetimeSpend(r.reported, Number(r.recorded)));
  return out;
}

/**
 * Lifetime spend for one account, in minor units: our recorded total, floored at Meta's counter.
 *
 * Our daily rows are the real answer — one row per (level, entity, date), never rewritten downwards,
 * so they cannot silently reset. Meta's counter acts only as a floor, for the case where insights
 * have not been backfilled for an account yet and our total would otherwise read 0. Because that
 * counter is cycle-scoped it can only ever be an UNDER-estimate of lifetime spend, which is exactly
 * what makes it safe as a floor and unsafe as the value.
 */
export function lifetimeSpend(reported: number | null, recordedCents: number): number {
  return Math.max(reported ?? 0, recordedCents);
}
