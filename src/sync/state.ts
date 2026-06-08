import { db, schema } from "@/db/client";
import type { InsightsClient } from "@/meta/types";

type Phase = "structure" | "insights";

export async function markSync(accountId: string, phase: Phase, error: string | null): Promise<void> {
  const ok = error === null;
  const stamp = new Date();
  const advanceStructure = ok && phase === "structure";
  const advanceInsights = ok && phase === "insights";
  const insertVals = {
    accountId,
    status: ok ? "ok" : "error",
    lastError: error,
    lastStructureSync: advanceStructure ? stamp : null,
    lastInsightsSync: advanceInsights ? stamp : null,
  };
  await db
    .insert(schema.syncState)
    .values(insertVals)
    .onConflictDoUpdate({
      target: schema.syncState.accountId,
      set: {
        status: insertVals.status,
        lastError: insertVals.lastError,
        ...(advanceStructure ? { lastStructureSync: stamp } : {}),
        ...(advanceInsights ? { lastInsightsSync: stamp } : {}),
      },
    });
}

export async function recordTokenHealth(client: InsightsClient): Promise<void> {
  let isValid = false;
  let scopes: string[] = [];
  let note: string | null = null;
  try {
    const d = await client.debugToken();
    isValid = d.is_valid;
    scopes = d.scopes;
  } catch (e) {
    note = e instanceof Error ? e.message : String(e);
  }
  await db
    .insert(schema.tokenHealth)
    .values({ id: "singleton", checkedAt: new Date(), isValid, scopes, note })
    .onConflictDoUpdate({
      target: schema.tokenHealth.id,
      set: { checkedAt: new Date(), isValid, scopes, note },
    });
}
