import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { inPortalContext } from "@/portal/context";
import { ownedCampaignIds } from "@/server/fns/campaign-attribution";
import { effectiveAccountIds } from "@/sync/jobs/clients";

/**
 * Who is asking, and exactly what they may see.
 *
 * This module is the portal's entire authorisation model. Every `portal*` op resolves its scope
 * here and queries strictly inside it; no op is allowed to take a brand or campaign id from the
 * request and trust it.
 *
 * ## The chain
 *
 *   portal_users.email  ->  portal_grants  ->  brands  ->  brand_accounts  ->  owned campaigns
 *
 * The last hop is the one that is easy to get wrong. An ad account is regularly shared between
 * clients and recycled onto the next one, so "every campaign on this brand's accounts" is NOT this
 * brand's campaigns — it can include a previous or concurrent client's. `ownedCampaignIds()`
 * already encodes the agency's ownership ladder (manual override, then brand-name attribution, then
 * sole claimant) and every other surface resolves ownership through it, so the portal does too
 * rather than reinventing an account-based shortcut that would leak across clients.
 *
 * ## The output is a whitelist
 *
 * `portalScope()` returns concrete campaign ids, never a filter to be applied later. Ops then read
 * `insights_daily WHERE level = 'campaign' AND entity_id IN (scope.campaignIds)`, which fails
 * closed: an empty scope returns no rows instead of every row.
 */

/** A resolved portal login. Deliberately carries no role — every portal user is a client. */
export interface PortalActor {
  id: string;
  email: string;
  name: string | null;
  status: string;
}

/** One brand as the portal presents it, with the accounts and client it resolves through. */
export interface ScopedBrand {
  id: string;
  clientId: string;
  name: string;
  website: string | null;
  monthlyBudget: number | null;
  /** Brand-level markup fallback for campaigns with no rate history. */
  defaultCommission: number | null;
  accountIds: string[];
}

export interface PortalScope {
  actor: PortalActor;
  brands: ScopedBrand[];
  /** Every campaign this user may see, across every brand. The whitelist ops must query inside. */
  campaignIds: string[];
  /** Client-facing name per visible campaign. Internal Meta names never appear here. */
  aliasOf: Map<string, string>;
  /** Owning brand per visible campaign, for grouping and labelling. */
  brandOf: Map<string, string>;
}

const EMPTY_SCOPE = (actor: PortalActor): PortalScope => ({
  actor,
  brands: [],
  campaignIds: [],
  aliasOf: new Map(),
  brandOf: new Map(),
});

/**
 * Resolve the email the portal proxy asserted.
 *
 * Returns null for an unknown address — and creates nothing. This is the deliberate difference from
 * the staff API's `provisionFederatedUser()`, which auto-creates a `pending` row for any email it
 * is handed. That is right for staff, where an admin is watching the Users page and an unapproved
 * row grants nothing; it is wrong here, because a client-facing app would quietly fill the table
 * with every address that ever signed up on Base44. A portal user is created by an operator
 * inviting them, never by the caller's own assertion.
 */
export async function resolvePortalActor(email: string): Promise<PortalActor | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const [row] = await db
    .select({
      id: schema.portalUsers.id,
      email: schema.portalUsers.email,
      name: schema.portalUsers.name,
      status: schema.portalUsers.status,
    })
    .from(schema.portalUsers)
    .where(eq(schema.portalUsers.email, e));
  return row ?? null;
}

/** Record that the actor was seen. Best-effort: a failed touch must never fail the request. */
export async function touchPortalActor(id: string): Promise<void> {
  try {
    await db
      .update(schema.portalUsers)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.portalUsers.id, id));
  } catch (e) {
    console.error("[portal] lastSeenAt touch failed", e);
  }
}

/**
 * Everything `actor` may see.
 *
 * Grants are read first, then the brands they point at are loaded and each brand's campaigns are
 * resolved through its client's ownership. A campaign grant is intersected with the same ownership
 * result rather than trusted directly: a grant left behind after an account was recycled would
 * otherwise hand a client a campaign that now belongs to somebody else.
 */
export async function portalScope(actor: PortalActor): Promise<PortalScope> {
  if (actor.status !== "approved") return EMPTY_SCOPE(actor);

  const grants = await db
    .select({ scope: schema.portalGrants.scope, targetId: schema.portalGrants.targetId })
    .from(schema.portalGrants)
    .where(eq(schema.portalGrants.portalUserId, actor.id));
  if (grants.length === 0) return EMPTY_SCOPE(actor);

  const grantedBrandIds = new Set<string>();
  const grantedCampaignIds = new Set<string>();
  for (const g of grants) {
    if (g.scope === "brand") grantedBrandIds.add(g.targetId);
    else if (g.scope === "campaign") grantedCampaignIds.add(g.targetId);
  }

  // A campaign grant implies its brand, which is only discoverable through the campaign's account.
  if (grantedCampaignIds.size > 0) {
    const rows = await db
      .select({ brandId: schema.brandAccounts.brandId })
      .from(schema.campaigns)
      .innerJoin(
        schema.brandAccounts,
        eq(schema.brandAccounts.accountId, schema.campaigns.accountId),
      )
      .where(inArray(schema.campaigns.id, [...grantedCampaignIds]));
    for (const r of rows) grantedBrandIds.add(r.brandId);
  }
  if (grantedBrandIds.size === 0) return EMPTY_SCOPE(actor);

  return brandScope(actor, [...grantedBrandIds], {
    wholeBrands: grantedBrandIds,
    campaigns: grantedCampaignIds,
  });
}

/** How much of a brand a caller may see, when the brand itself was not granted outright. */
interface GrantNarrowing {
  /** Brands granted outright — every campaign the brand owns is visible. */
  wholeBrands: ReadonlySet<string>;
  /** Campaigns granted individually, for a brand reached only through such a grant. */
  campaigns: ReadonlySet<string>;
}

/**
 * brands → accounts → owned campaigns → client-facing aliases.
 *
 * Split out of `portalScope` so a STAFF caller can run the identical resolution over arbitrary
 * brands: an admin holds no `portal_grants`, so `portalScope` would hand the agency's own view of
 * a client report an empty scope. The grant layer is the only difference between the two callers,
 * and it is a parameter rather than a second copy of this function because a copy is what would
 * eventually disagree with this one about ownership or the alias gate.
 *
 * `narrowing === null` means "no grant layer at all", which is legitimate exactly once: for a
 * caller `requireAdmin()` has already cleared.
 */
async function brandScope(
  actor: PortalActor,
  brandIds: string[],
  narrowing: GrantNarrowing | null,
): Promise<PortalScope> {
  if (brandIds.length === 0) return EMPTY_SCOPE(actor);

  const brandRows = await db
    .select()
    .from(schema.brands)
    .where(inArray(schema.brands.id, brandIds));
  if (brandRows.length === 0) return EMPTY_SCOPE(actor);

  const accountRows = await db
    .select({ brandId: schema.brandAccounts.brandId, accountId: schema.brandAccounts.accountId })
    .from(schema.brandAccounts)
    .where(
      inArray(
        schema.brandAccounts.brandId,
        brandRows.map((b) => b.id),
      ),
    );
  const accountsByBrand = new Map<string, string[]>();
  for (const r of accountRows) {
    const list = accountsByBrand.get(r.brandId);
    if (list) list.push(r.accountId);
    else accountsByBrand.set(r.brandId, [r.accountId]);
  }

  const brands: ScopedBrand[] = [];
  const brandOf = new Map<string, string>();
  const visible = new Set<string>();

  for (const b of brandRows) {
    const accountIds = accountsByBrand.get(b.id) ?? [];
    if (accountIds.length === 0) continue;

    const brand: ScopedBrand = {
      id: b.id,
      clientId: b.clientId,
      name: b.name,
      website: b.website,
      monthlyBudget: b.monthlyBudget,
      defaultCommission: b.defaultCommission,
      accountIds,
    };

    // The client's own account list can be narrower than the brand mapping (an account removed in
    // the UI), so intersect before resolving ownership — otherwise a removed account's campaigns
    // come back through the brand.
    const clientRow = await db
      .select({
        notionAccountIds: schema.clients.notionAccountIds,
        manualAddIds: schema.clients.manualAddIds,
        manualRemoveIds: schema.clients.manualRemoveIds,
      })
      .from(schema.clients)
      .where(eq(schema.clients.id, b.clientId))
      .then((rows) => rows[0]);
    if (!clientRow) continue;
    const clientAccounts = new Set(effectiveAccountIds(clientRow));
    const usable = accountIds.filter((id) => clientAccounts.has(id));
    if (usable.length === 0) continue;

    // null = "no ownership restriction needed", i.e. every campaign on these accounts is this
    // client's. Otherwise it is the explicit whitelist.
    const owned = await ownedCampaignIds(b.clientId, usable);
    const ownedSet = owned === null ? null : new Set(owned);

    const onAccounts = await db
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(inArray(schema.campaigns.accountId, usable));

    const brandCampaignIds = onAccounts
      .map((c) => c.id)
      .filter((id) => ownedSet === null || ownedSet.has(id));

    const wanted =
      narrowing === null || narrowing.wholeBrands.has(b.id)
        ? brandCampaignIds
        : brandCampaignIds.filter((id) => narrowing.campaigns.has(id));
    if (wanted.length === 0) continue;

    for (const id of wanted) {
      visible.add(id);
      brandOf.set(id, b.id);
    }
    brands.push(brand);
  }

  if (visible.size === 0) return EMPTY_SCOPE(actor);

  // Final gate: a campaign is only shown once an operator has given it a client-facing alias.
  // Falling back to `campaigns.name` here would leak the internal naming convention, so an unnamed
  // or explicitly hidden campaign drops out of the scope entirely.
  const presentation = await db
    .select({
      campaignId: schema.portalCampaigns.campaignId,
      alias: schema.portalCampaigns.alias,
      hidden: schema.portalCampaigns.hidden,
    })
    .from(schema.portalCampaigns)
    .where(inArray(schema.portalCampaigns.campaignId, [...visible]));

  const aliasOf = new Map<string, string>();
  for (const p of presentation) {
    if (p.hidden || !p.alias) continue;
    aliasOf.set(p.campaignId, p.alias);
  }

  const campaignIds = [...visible].filter((id) => aliasOf.has(id));
  for (const id of [...brandOf.keys()]) if (!aliasOf.has(id)) brandOf.delete(id);
  const keptBrands = new Set(brandOf.values());

  return {
    actor,
    brands: brands.filter((b) => keptBrands.has(b.id)),
    campaignIds,
    aliasOf,
    brandOf,
  };
}

/**
 * Every visible campaign of the requested brands, with no grant layer — for STAFF callers only.
 *
 * The agency's own copy of a client-facing report has to resolve brands the caller was never
 * granted, because a member of staff is granted nothing: `portal_grants` is the customer's table.
 * So this is the one entry point that takes brand ids as a LOOKUP rather than a filter, and the
 * only safe caller is an op that has already called `requireAdmin()`.
 *
 * An empty selection means every brand the agency has, which is the agency-wide report. The alias
 * gate still applies: the point of the staff copy is to see exactly what the customer sees.
 *
 * `actor` never reaches a response from here — it exists because a scope is defined relative to
 * somebody — so staff callers pass a synthetic one built from their own identity.
 *
 * It refuses outright on the portal transport. That check is not defence in depth: this function
 * is exported from the same module every `portal*` op imports for `portalScope` and
 * `narrowToBrands`, so the single most likely way it gets misused is a future portal op reaching
 * for it by autocomplete and silently returning every brand the agency has. A doc comment does not
 * survive that; a throw does.
 */
export async function agencyBrandScope(
  actor: PortalActor,
  brandIds: string[] | undefined,
): Promise<PortalScope> {
  if (inPortalContext()) {
    throw new Error(
      "agencyBrandScope() was called on the portal transport — it bypasses portal_grants and is " +
        "admin-only. A portal op must use portalScope() + narrowToBrands().",
    );
  }
  const ids =
    brandIds && brandIds.length > 0
      ? brandIds
      : (await db.select({ id: schema.brands.id }).from(schema.brands)).map((b) => b.id);
  return brandScope(actor, ids, null);
}

/**
 * Narrow a resolved scope to the brands the caller asked for.
 *
 * The request's brand ids are treated as a FILTER over what the user already has, never as a
 * lookup: an id the user was not granted contributes nothing instead of widening the scope. An
 * empty or absent selection means "everything in scope", which is what the portal's "All your
 * brands" default sends.
 */
export function narrowToBrands(scope: PortalScope, brandIds: string[] | undefined): PortalScope {
  if (!brandIds || brandIds.length === 0) return scope;
  const wanted = new Set(brandIds.filter((id) => scope.brands.some((b) => b.id === id)));
  if (wanted.size === 0) return scope;

  const campaignIds = scope.campaignIds.filter((id) => {
    const brandId = scope.brandOf.get(id);
    return brandId !== undefined && wanted.has(brandId);
  });
  const kept = new Set(campaignIds);
  const brandOf = new Map<string, string>();
  const aliasOf = new Map<string, string>();
  for (const id of kept) {
    const brandId = scope.brandOf.get(id);
    if (brandId !== undefined) brandOf.set(id, brandId);
    const alias = scope.aliasOf.get(id);
    if (alias !== undefined) aliasOf.set(id, alias);
  }
  return {
    actor: scope.actor,
    brands: scope.brands.filter((b) => wanted.has(b.id)),
    campaignIds,
    aliasOf,
    brandOf,
  };
}

/** Brand-level markup fallback per campaign, for `markupRows`. */
export function defaultCommissionLookup(
  scope: PortalScope,
  fallback: number,
): (campaignId: string) => number {
  const byBrand = new Map<string, number>();
  for (const b of scope.brands) byBrand.set(b.id, b.defaultCommission ?? fallback);
  return (campaignId) => {
    const brandId = scope.brandOf.get(campaignId);
    const rate = brandId === undefined ? undefined : byBrand.get(brandId);
    return rate ?? fallback;
  };
}

/** True when the actor may see this campaign. Ops that take a campaign id MUST check it. */
export const canSeeCampaign = (scope: PortalScope, campaignId: string): boolean =>
  scope.aliasOf.has(campaignId);
