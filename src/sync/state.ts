import { db, schema } from "@/db/client";
import type { InsightsClient } from "@/meta/types";

type Phase = "structure" | "insights";

export async function markSync(accountId: string, phase: Phase, error: string | null): Promise<void> {
  const stamp = new Date();
  const ins = {
    accountId,
    status: error ? "error" : "ok",
    lastError: error,
    lastStructureSync: phase === "structure" ? stamp : null,
    lastInsightsSync: phase === "insights" ? stamp : null,
  };
  await db
    .insert(schema.syncState)
    .values(ins)
    .onConflictDoUpdate({
      target: schema.syncState.accountId,
      set: {
        status: ins.status,
        lastError: ins.lastError,
        ...(phase === "structure" ? { lastStructureSync: stamp } : {}),
        ...(phase === "insights" ? { lastInsightsSync: stamp } : {}),
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
