import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { normalizeTier, type AccessTier } from "@/meta/rate-limit";
import { getServiceHealth, type ServiceHealth } from "@/sync/state";

export interface MetaHealth {
  tokenValid: boolean | null; // null = never checked yet
  checkedAt: string | null; // ISO of the last token_health check
  tier: AccessTier | null; // last observed access tier
  note: string | null; // last error note, if any
  notion: ServiceHealth | null; // "notion": reads the client/account mapping off the board
  /** "notion-budget": writes the 🤖 columns back. Fails independently of the read above — a renamed
   *  column stopped it for six days in Aug 2026 while `notion` stayed green — so the badge needs
   *  both. Null = never run. */
  notionBudget: ServiceHealth | null;
  lastRefreshAt: string | null; // max lastInsightsSync — the last successful data refresh (ISO)
}

/** Lightweight Meta app + system-token health for the always-visible sidebar status badge.
 *  Reachable by any approved user (the auth gate blocks unapproved/anon before this runs). */
export async function fetchMetaHealth(): Promise<MetaHealth> {
  const [row] = await db
    .select({
      isValid: schema.tokenHealth.isValid,
      checkedAt: schema.tokenHealth.checkedAt,
      tier: schema.tokenHealth.tier,
      note: schema.tokenHealth.note,
    })
    .from(schema.tokenHealth)
    .where(eq(schema.tokenHealth.id, "singleton"));
  const [notion, notionBudget] = await Promise.all([
    getServiceHealth("notion"),
    getServiceHealth("notion-budget"),
  ]);
  const [sync] = await db
    .select({ last: sql<string | null>`max(${schema.syncState.lastInsightsSync})` })
    .from(schema.syncState);
  const syncDate = sync?.last ? new Date(sync.last) : null;
  const lastRefreshAt =
    syncDate && !Number.isNaN(syncDate.getTime()) ? syncDate.toISOString() : null;
  if (!row)
    return {
      tokenValid: null,
      checkedAt: null,
      tier: null,
      note: null,
      notion,
      notionBudget,
      lastRefreshAt,
    };
  return {
    // Never checked (no timestamp) reads as "unknown" rather than a scary "invalid".
    tokenValid: row.checkedAt ? row.isValid : null,
    checkedAt: row.checkedAt ? row.checkedAt.toISOString() : null,
    tier: normalizeTier(row.tier),
    note: row.note ?? null,
    notion,
    notionBudget,
    lastRefreshAt,
  };
}
