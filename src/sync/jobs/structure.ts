import { db, schema } from "@/db/client";
import type { GraphNode, InsightsClient } from "@/meta/types";

const now = () => new Date();

export async function syncStructure(client: InsightsClient, accountId: string): Promise<void> {
  const campaigns = await client.getChildren(accountId, "campaigns", [
    "id", "name", "status", "effective_status", "objective", "daily_budget",
  ]);
  for (const c of campaigns) {
    await db
      .insert(schema.campaigns)
      .values(row(c, { accountId, name: str(c.name), objective: str(c.objective), dailyBudget: int(c.daily_budget) }))
      .onConflictDoUpdate({ target: schema.campaigns.id, set: setCols(c, { accountId, name: str(c.name), objective: str(c.objective), dailyBudget: int(c.daily_budget) }) });
  }

  const adsets = await client.getChildren(accountId, "adsets", [
    "id", "name", "status", "effective_status", "campaign_id",
  ]);
  for (const s of adsets) {
    const base = { accountId, campaignId: str(s.campaign_id), name: str(s.name) };
    await db
      .insert(schema.adSets)
      .values(row(s, base))
      .onConflictDoUpdate({ target: schema.adSets.id, set: setCols(s, base) });
  }

  const ads = await client.getChildren(accountId, "ads", [
    "id", "name", "status", "effective_status", "adset_id", "creative{id}",
  ]);
  for (const a of ads) {
    const base = { accountId, adSetId: str(a.adset_id), name: str(a.name), creativeId: creativeId(a) };
    await db
      .insert(schema.ads)
      .values(row(a, base))
      .onConflictDoUpdate({ target: schema.ads.id, set: setCols(a, base) });
  }

  const creatives = await client.getChildren(accountId, "adcreatives", ["id", "name", "thumbnail_url"]);
  for (const cr of creatives) {
    const base = { name: str(cr.name), thumbnailUrl: str(cr.thumbnail_url) };
    await db
      .insert(schema.adCreatives)
      .values({ id: cr.id, ...base, raw: cr, syncedAt: now() })
      .onConflictDoUpdate({ target: schema.adCreatives.id, set: { ...base, raw: cr, syncedAt: now() } });
  }
}

export async function syncAccounts(client: InsightsClient, businessId: string): Promise<string[]> {
  const accts = await client.getAccounts(businessId);
  const ids: string[] = [];
  for (const a of accts) {
    const id = String(a.id);
    ids.push(id);
    const base = {
      name: str(a.name) ?? id,
      currency: str(a.currency) ?? "USD",
      status: str(a.account_status),
    };
    await db
      .insert(schema.accounts)
      .values({ id, ...base, raw: a, syncedAt: now() })
      .onConflictDoUpdate({ target: schema.accounts.id, set: { ...base, raw: a, syncedAt: now() } });
  }
  return ids;
}

// helpers
const str = (v: unknown) => (v == null ? null : String(v));
const int = (v: unknown) => (v == null ? null : Number(v) || null);
const creativeId = (a: GraphNode) =>
  a.creative && typeof a.creative === "object" ? str((a.creative as GraphNode).id) : null;

function row(node: GraphNode, extra: Record<string, unknown>) {
  return { id: node.id, status: str(node.status), effectiveStatus: str(node.effective_status), raw: node, syncedAt: now(), ...extra };
}
function setCols(node: GraphNode, extra: Record<string, unknown>) {
  return { status: str(node.status), effectiveStatus: str(node.effective_status), raw: node, syncedAt: now(), ...extra };
}
