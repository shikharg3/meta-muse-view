/**
 * What a report may read for one client, split into its brands.
 *
 * A brand is a Notion board row title under the client ("Slots.lv", "Lucky Rebel" under OneAgency).
 * Rows with the same title are one brand — successive engagements re-list it — and its accounts are
 * the union of theirs. A campaign belongs to a brand when its account is listed by that brand alone;
 * on an account several brands list, the campaign name decides (`attributeCampaign`, the rule the
 * Notion budget job uses per row), and a name that matches none or several is left out of every
 * brand rather than counted twice. Client-level ownership (`ownedCampaignIds`) applies first, so a
 * brand never reaches another client's campaigns on a shared account.
 */
import { inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { attributeCampaign, brandVocab } from "@/lib/attribution";
import { OTHER_BRAND } from "@/lib/scheduled-report";
import { ownedCampaignIds } from "@/server/fns/campaign-attribution";
import { effectiveAccountIds } from "@/sync/jobs/clients";

export interface BrandOption {
  key: string;
  title: string;
  /** "Live" when any of its rows is live, else the first row's status. */
  status: string | null;
  accountIds: string[];
}

export interface ScopedCampaign {
  id: string;
  name: string;
  accountId: string;
  /** Brand key, or null when the name cannot settle a shared account. */
  brand: string | null;
}

export interface ClientScope {
  clientId: string;
  clientName: string;
  accountIds: string[];
  brands: BrandOption[];
  /** Every campaign on the client's accounts that the client owns. */
  campaigns: ScopedCampaign[];
  /** True when a shared account or an override makes `campaigns` a whitelist rather than "all". */
  restricted: boolean;
}

type ClientRow = typeof schema.clients.$inferSelect;

const brandKey = (title: string): string => title.trim().replace(/\s+/g, " ").toLowerCase();

/** The client's brands, from the board rows stored on `clients.raw`. Pure. */
export function clientBrands(
  client: Pick<ClientRow, "raw" | "notionAccountIds" | "manualAddIds" | "manualRemoveIds">,
): BrandOption[] {
  const effective = new Set(effectiveAccountIds(client));
  const byKey = new Map<string, BrandOption>();
  for (const p of Array.isArray(client.raw) ? client.raw : []) {
    if (!p || typeof p !== "object") continue;
    const title = "title" in p && typeof p.title === "string" ? p.title.trim() : "";
    if (!title) continue;
    const status = "status" in p && typeof p.status === "string" ? p.status : null;
    const listedIds: unknown[] =
      "accountIds" in p && Array.isArray(p.accountIds) ? p.accountIds : [];
    const ids = listedIds.filter((a): a is string => typeof a === "string" && effective.has(a));
    const key = brandKey(title);
    const b = byKey.get(key);
    if (!b) byKey.set(key, { key, title, status, accountIds: [...new Set(ids)] });
    else {
      b.accountIds = [...new Set([...b.accountIds, ...ids])];
      if (status === "Live") b.status = "Live";
    }
  }
  const listed = new Set([...byKey.values()].flatMap((b) => b.accountIds));
  const other = [...effective].filter((a) => !listed.has(a));
  const brands = [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title));
  if (other.length > 0)
    brands.push({
      key: OTHER_BRAND,
      title: "Other accounts (no board row)",
      status: null,
      accountIds: other,
    });
  return brands;
}

/** Attribute each campaign to a brand. Pure; `campaigns` must already be the client's own. */
export function attributeToBrands(
  brands: BrandOption[],
  campaigns: { id: string; name: string; accountId: string }[],
): ScopedCampaign[] {
  const claimants = new Map<string, string[]>();
  for (const b of brands)
    for (const a of b.accountIds) claimants.set(a, [...(claimants.get(a) ?? []), b.key]);
  const vocab = new Map(brands.map((b) => [b.key, brandVocab(b.key, b.title, [b.title])]));
  return campaigns.map((c) => {
    const keys = claimants.get(c.accountId) ?? [];
    const brand =
      keys.length <= 1
        ? (keys[0] ?? null)
        : attributeCampaign(
            c.name,
            keys.map((k) => vocab.get(k)!),
          );
    return { ...c, brand };
  });
}

export async function loadClientScope(client: ClientRow): Promise<ClientScope> {
  const accountIds = effectiveAccountIds(client);
  const [owned, rows] = await Promise.all([
    ownedCampaignIds(client.id, accountIds),
    accountIds.length
      ? db
          .select({
            id: schema.campaigns.id,
            name: schema.campaigns.name,
            accountId: schema.campaigns.accountId,
          })
          .from(schema.campaigns)
          .where(inArray(schema.campaigns.accountId, accountIds))
      : Promise.resolve([]),
  ]);
  const own = owned ? new Set(owned) : null;
  const brands = clientBrands(client);
  return {
    clientId: client.id,
    clientName: client.name,
    accountIds,
    brands,
    campaigns: attributeToBrands(
      brands,
      rows.filter((c) => !own || own.has(c.id)).sort((a, b) => a.name.localeCompare(b.name)),
    ),
    restricted: own !== null,
  };
}

export interface NarrowedScope {
  accountIds: string[];
  /** Whitelist for the engine; null = every campaign of `accountIds`. Empty = nothing in scope. */
  campaignIds: string[] | null;
  /** campaign id → brand title, for a Brand column. */
  brandOf: Map<string, string>;
  /** Human label: "OneAgency" or "OneAgency › Slots.lv, Lucky Rebel". */
  subject: string;
}

/** Apply a recipe's brand and campaign picks to a client scope. Pure. */
export function narrowScope(
  scope: ClientScope,
  brandKeys: string[],
  campaignIds: string[],
): NarrowedScope {
  const titleOf = new Map(scope.brands.map((b) => [b.key, b.title]));
  const brandOf = new Map<string, string>();
  for (const c of scope.campaigns) if (c.brand) brandOf.set(c.id, titleOf.get(c.brand) ?? c.brand);

  const picked = new Set(brandKeys.filter((k) => titleOf.has(k)));
  const picks = new Set(campaignIds);
  const accountIds =
    picked.size === 0
      ? scope.accountIds
      : [...new Set(scope.brands.filter((b) => picked.has(b.key)).flatMap((b) => b.accountIds))];
  const list = scope.campaigns
    .filter((c) => picked.size === 0 || (c.brand !== null && picked.has(c.brand)))
    .filter((c) => picks.size === 0 || picks.has(c.id))
    .map((c) => c.id);
  // No brand and no campaign pick: the client's own scope, which is "every campaign" unless a shared
  // account forces a whitelist — exactly what the Report Builder sends.
  const unfiltered = picked.size === 0 && picks.size === 0 && !scope.restricted;
  const subject =
    picked.size === 0
      ? scope.clientName
      : `${scope.clientName} › ${[...picked].map((k) => titleOf.get(k)).join(", ")}`;
  return { accountIds, campaignIds: unfiltered ? null : list, brandOf, subject };
}
