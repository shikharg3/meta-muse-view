import { db, schema } from "@/db/client";
import type { GraphNode, InsightsClient } from "@/meta/types";

const now = () => new Date();
const str = (v: unknown): string | null => (v == null ? null : String(v));
const reqStr = (v: unknown, fallback: string): string => (v == null ? fallback : String(v));
const int = (v: unknown): number | null => (v == null ? null : Number(v) || null);
const creativeId = (a: GraphNode): string | null =>
  a.creative && typeof a.creative === "object" ? str((a.creative as GraphNode).id) : null;

/** Common columns shared by structure tables (status/effective_status/raw/synced_at). */
function meta(node: GraphNode) {
  return {
    status: str(node.status),
    effectiveStatus: str(node.effective_status),
    raw: node,
    syncedAt: now(),
  };
}

export async function syncStructure(client: InsightsClient, accountId: string): Promise<void> {
  const campaigns = await client.getChildren(accountId, "campaigns", [
    "id",
    "name",
    "status",
    "effective_status",
    "objective",
    "daily_budget",
  ]);
  for (const c of campaigns) {
    const vals = {
      id: String(c.id),
      accountId,
      name: reqStr(c.name, String(c.id)),
      objective: str(c.objective),
      dailyBudget: int(c.daily_budget),
      ...meta(c),
    };
    await db
      .insert(schema.campaigns)
      .values(vals)
      .onConflictDoUpdate({ target: schema.campaigns.id, set: vals });
  }

  const adsets = await client.getChildren(accountId, "adsets", [
    "id",
    "name",
    "status",
    "effective_status",
    "campaign_id",
  ]);
  for (const s of adsets) {
    const vals = {
      id: String(s.id),
      accountId,
      campaignId: reqStr(s.campaign_id, ""),
      name: reqStr(s.name, String(s.id)),
      ...meta(s),
    };
    await db
      .insert(schema.adSets)
      .values(vals)
      .onConflictDoUpdate({ target: schema.adSets.id, set: vals });
  }

  const ads = await client.getChildren(accountId, "ads", [
    "id",
    "name",
    "status",
    "effective_status",
    "adset_id",
    "creative{id}",
  ]);
  for (const a of ads) {
    const vals = {
      id: String(a.id),
      accountId,
      adSetId: reqStr(a.adset_id, ""),
      name: reqStr(a.name, String(a.id)),
      creativeId: creativeId(a),
      ...meta(a),
    };
    await db
      .insert(schema.ads)
      .values(vals)
      .onConflictDoUpdate({ target: schema.ads.id, set: vals });
  }

  // thumbnail_url defaults to 64x64; ask for 1080 so cards render sharp.
  // image_url / object_story_spec carry the original-resolution assets in raw.
  // object_story_spec is large and forcing 1080px thumbnails is heavy: a full
  // page (200) makes Meta 500 with "reduce the amount of data". Page small.
  const creatives = await client.getChildren(
    accountId,
    "adcreatives",
    ["id", "name", "thumbnail_url", "image_url", "object_type", "object_story_spec"],
    { thumbnail_width: 1080, thumbnail_height: 1080, limit: 25 },
  );
  for (const cr of creatives) {
    const vals = {
      id: String(cr.id),
      name: str(cr.name),
      thumbnailUrl: str(cr.thumbnail_url),
      raw: cr,
      syncedAt: now(),
    };
    await db
      .insert(schema.adCreatives)
      .values(vals)
      .onConflictDoUpdate({ target: schema.adCreatives.id, set: vals });
  }
}

/** Enumerate the BM's owned ad accounts and upsert them; returns the account ids. */
export async function syncAccounts(client: InsightsClient, businessId: string): Promise<string[]> {
  const accts = await client.getAccounts(businessId);
  const ids: string[] = [];
  for (const a of accts) {
    const id = String(a.id);
    ids.push(id);
    const vals = {
      id,
      name: reqStr(a.name, id),
      currency: reqStr(a.currency, "USD"),
      status: str(a.account_status),
      raw: a,
      syncedAt: now(),
    };
    await db
      .insert(schema.accounts)
      .values(vals)
      .onConflictDoUpdate({ target: schema.accounts.id, set: vals });
  }
  return ids;
}
