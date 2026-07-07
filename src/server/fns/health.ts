import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { normalizeTier, type AccessTier } from "@/meta/rate-limit";

export interface MetaHealth {
  tokenValid: boolean | null; // null = never checked yet
  checkedAt: string | null; // ISO of the last token_health check
  tier: AccessTier | null; // last observed access tier
  note: string | null; // last error note, if any
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
  if (!row) return { tokenValid: null, checkedAt: null, tier: null, note: null };
  return {
    // Never checked (no timestamp) reads as "unknown" rather than a scary "invalid".
    tokenValid: row.checkedAt ? row.isValid : null,
    checkedAt: row.checkedAt ? row.checkedAt.toISOString() : null,
    tier: normalizeTier(row.tier),
    note: row.note ?? null,
  };
}
