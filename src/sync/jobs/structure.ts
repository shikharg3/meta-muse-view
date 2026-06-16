import { db, schema } from "@/db/client";
import type { GraphNode, InsightsClient } from "@/meta/types";
import { NODE_FIELDS } from "@/meta/fieldsets";

const now = () => new Date();
const str = (v: unknown): string | null => (v == null ? null : String(v));
const reqStr = (v: unknown, fallback: string): string => (v == null ? fallback : String(v));
/** Numeric coercion that preserves 0 (Meta money fields are integer cents as strings). */
const big = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ts = (v: unknown): Date | null => {
  if (v == null) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const jsonOf = (v: unknown): unknown => (v == null ? null : v);
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
  // Full field sets (the client drops fields this token can't read); everything lands in `raw`.
  // Heavy nodes are paged smaller so Meta doesn't 500 with "reduce the amount of data".
  const campaigns = await client.getChildren(accountId, "campaigns", NODE_FIELDS.campaign, {
    limit: 100,
  });
  for (const c of campaigns) {
    const vals = {
      id: String(c.id),
      accountId,
      name: reqStr(c.name, String(c.id)),
      objective: str(c.objective),
      dailyBudget: big(c.daily_budget),
      lifetimeBudget: big(c.lifetime_budget),
      budgetRemaining: big(c.budget_remaining),
      bidStrategy: str(c.bid_strategy),
      buyingType: str(c.buying_type),
      startTime: ts(c.start_time),
      stopTime: ts(c.stop_time),
      createdTime: ts(c.created_time),
      updatedTime: ts(c.updated_time),
      specialAdCategories: jsonOf(c.special_ad_categories),
      promotedObject: jsonOf(c.promoted_object),
      ...meta(c),
    };
    await db
      .insert(schema.campaigns)
      .values(vals)
      .onConflictDoUpdate({ target: schema.campaigns.id, set: vals });
  }

  const adsets = await client.getChildren(accountId, "adsets", NODE_FIELDS.adset, { limit: 50 });
  for (const s of adsets) {
    const vals = {
      id: String(s.id),
      accountId,
      campaignId: reqStr(s.campaign_id, ""),
      name: reqStr(s.name, String(s.id)),
      optimizationGoal: str(s.optimization_goal),
      billingEvent: str(s.billing_event),
      bidAmount: big(s.bid_amount),
      bidStrategy: str(s.bid_strategy),
      dailyBudget: big(s.daily_budget),
      lifetimeBudget: big(s.lifetime_budget),
      budgetRemaining: big(s.budget_remaining),
      startTime: ts(s.start_time),
      endTime: ts(s.end_time),
      createdTime: ts(s.created_time),
      updatedTime: ts(s.updated_time),
      destinationType: str(s.destination_type),
      promotedObject: jsonOf(s.promoted_object),
      targeting: jsonOf(s.targeting),
      attributionSpec: jsonOf(s.attribution_spec),
      ...meta(s),
    };
    await db
      .insert(schema.adSets)
      .values(vals)
      .onConflictDoUpdate({ target: schema.adSets.id, set: vals });
  }

  const ads = await client.getChildren(accountId, "ads", NODE_FIELDS.ad, { limit: 100 });
  for (const a of ads) {
    const vals = {
      id: String(a.id),
      accountId,
      adSetId: reqStr(a.adset_id, ""),
      name: reqStr(a.name, String(a.id)),
      creativeId: creativeId(a),
      bidAmount: big(a.bid_amount),
      createdTime: ts(a.created_time),
      updatedTime: ts(a.updated_time),
      trackingSpecs: jsonOf(a.tracking_specs),
      conversionSpecs: jsonOf(a.conversion_specs),
      previewShareableLink: str(a.preview_shareable_link),
      ...meta(a),
    };
    await db
      .insert(schema.ads)
      .values(vals)
      .onConflictDoUpdate({ target: schema.ads.id, set: vals });
  }

  // Full creative field set (copy/CTA/assets land in `raw`; promoted columns added in Phase 2).
  // object_story_spec is large and 1080px thumbnails are heavy, so page small.
  const creatives = await client.getChildren(accountId, "adcreatives", NODE_FIELDS.creative, {
    thumbnail_width: 1080,
    thumbnail_height: 1080,
    limit: 25,
  });
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
    const business = (a.business ?? null) as { id?: unknown; name?: unknown } | null;
    const vals = {
      id,
      name: reqStr(a.name, id),
      currency: reqStr(a.currency, "USD"),
      status: str(a.account_status),
      amountSpent: big(a.amount_spent),
      balance: big(a.balance),
      spendCap: big(a.spend_cap),
      timezoneName: str(a.timezone_name),
      disableReason: big(a.disable_reason),
      businessId: business ? str(business.id) : null,
      businessName: business ? str(business.name) : null,
      createdTime: ts(a.created_time),
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
