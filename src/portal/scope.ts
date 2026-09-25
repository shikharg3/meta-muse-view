import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ownedCampaignIds } from "@/server/fns/campaign-attribution";
import { brandAccountIds, coveredProjects, projectOfAccount } from "@/portal/brand-accounts";

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
  /** The ad previews' default page name for the brand's projects; null = use `name`. */
  pageName: string | null;
  /** The ad previews' default profile photo, a public https URL; null = initials. */
  pageAvatarUrl: string | null;
  /** Markup for campaigns whose project and own rate history set none. */
  defaultCommission: number | null;
  accountIds: string[];
}

/**
 * One Notion board row a visible campaign counts under, with its per-project overrides. A null
 * field inherits the brand's value; see `portal_project_settings`.
 */
export interface ScopedProject {
  pageId: string;
  title: string;
  brandId: string;
  pageName: string | null;
  pageAvatarUrl: string | null;
  commission: number | null;
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
  /**
   * The project each visible campaign counts under (`projectOfAccount`). Absent for a campaign on
   * an account no covered project lists — it inherits the brand's settings.
   */
  projectOf: Map<string, string>;
  /** The projects `projectOf` points at, by page id. */
  projects: Map<string, ScopedProject>;
}

const EMPTY_SCOPE = (actor: PortalActor): PortalScope => ({
  actor,
  brands: [],
  campaignIds: [],
  aliasOf: new Map(),
  brandOf: new Map(),
  projectOf: new Map(),
  projects: new Map(),
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
 * resolved through its client's ownership. A campaign or project grant is intersected with the
 * same ownership result rather than trusted directly: a grant left behind after an account was
 * recycled would otherwise hand a client a campaign that now belongs to somebody else.
 *
 * Only a `brand` grant opens a whole brand. A brand reached through a project or campaign grant
 * is resolved so those campaigns can be found, and nothing more — the sets are kept apart so that
 * reaching a brand can never be mistaken for being granted it.
 */
export async function portalScope(actor: PortalActor): Promise<PortalScope> {
  if (actor.status !== "approved") return EMPTY_SCOPE(actor);

  const grants = await db
    .select({
      scope: schema.portalGrants.scope,
      targetId: schema.portalGrants.targetId,
      parentId: schema.portalGrants.parentId,
    })
    .from(schema.portalGrants)
    .where(eq(schema.portalGrants.portalUserId, actor.id));
  if (grants.length === 0) return EMPTY_SCOPE(actor);

  const wholeBrands = new Set<string>();
  const campaigns = new Set<string>();
  const projects = new Map<string, Set<string>>();
  for (const g of grants) {
    if (g.scope === "brand") wholeBrands.add(g.targetId);
    else if (g.scope === "campaign") campaigns.add(g.targetId);
    else if (g.scope === "project" && g.parentId) {
      const set = projects.get(g.parentId);
      if (set) set.add(g.targetId);
      else projects.set(g.parentId, new Set([g.targetId]));
    }
  }

  const toResolve = new Set<string>([...wholeBrands, ...projects.keys()]);
  // A campaign grant implies its brand, which is only discoverable through the campaign's account.
  if (campaigns.size > 0) {
    const rows = await db
      .select({ brandId: schema.brandAccounts.brandId })
      .from(schema.campaigns)
      .innerJoin(
        schema.brandAccounts,
        eq(schema.brandAccounts.accountId, schema.campaigns.accountId),
      )
      .where(inArray(schema.campaigns.id, [...campaigns]));
    for (const r of rows) toResolve.add(r.brandId);
  }
  if (toResolve.size === 0) return EMPTY_SCOPE(actor);

  return brandScope(actor, [...toResolve], { wholeBrands, projects, campaigns });
}

/** How much of a brand a caller may see, when the brand itself was not granted outright. */
export interface GrantNarrowing {
  /** Brands granted outright — every campaign the brand owns is visible. */
  wholeBrands: ReadonlySet<string>;
  /** Project grants: brand id → the Notion page ids granted within it. */
  projects: ReadonlyMap<string, ReadonlySet<string>>;
  /** Campaigns granted individually, for a brand reached only through such a grant. */
  campaigns: ReadonlySet<string>;
}

/**
 * Which of one brand's campaigns a caller may see.
 *
 * Everything, for a brand granted outright; for any other brand, only campaigns granted
 * individually or counting under a project granted WITHIN THIS BRAND — a project grant held
 * through another brand opens nothing here. `projectId` is the campaign's project from
 * `projectOfAccount`, absent when no covered project lists its account, and such a campaign is
 * never reachable through a project grant.
 */
export function visibleUnderGrants(
  brandId: string,
  campaigns: readonly { id: string; projectId: string | undefined }[],
  narrowing: GrantNarrowing,
): string[] {
  if (narrowing.wholeBrands.has(brandId)) return campaigns.map((c) => c.id);
  const granted = narrowing.projects.get(brandId);
  return campaigns
    .filter(
      (c) =>
        narrowing.campaigns.has(c.id) ||
        (c.projectId !== undefined && granted !== undefined && granted.has(c.projectId)),
    )
    .map((c) => c.id);
}

/**
 * brands → accounts → owned campaigns → client-facing aliases, cut down to what the grants open.
 *
 * Split out of `portalScope` so the grant bookkeeping and the resolution read separately; the
 * ownership check and the alias gate live here, once.
 */
async function brandScope(
  actor: PortalActor,
  brandIds: string[],
  narrowing: GrantNarrowing,
): Promise<PortalScope> {
  if (brandIds.length === 0) return EMPTY_SCOPE(actor);

  const brandRows = await db
    .select()
    .from(schema.brands)
    .where(inArray(schema.brands.id, brandIds));
  if (brandRows.length === 0) return EMPTY_SCOPE(actor);

  // The `brand_accounts` rows are a NARROWING override, not the mapping — see
  // `src/portal/brand-accounts.ts`. Normally there are none and the accounts come entirely from
  // the client's Notion board rows.
  const overrideRows = await db
    .select({ brandId: schema.brandAccounts.brandId, accountId: schema.brandAccounts.accountId })
    .from(schema.brandAccounts)
    .where(
      inArray(
        schema.brandAccounts.brandId,
        brandRows.map((b) => b.id),
      ),
    );
  const overridesByBrand = new Map<string, string[]>();
  for (const r of overrideRows) {
    const list = overridesByBrand.get(r.brandId);
    if (list) list.push(r.accountId);
    else overridesByBrand.set(r.brandId, [r.accountId]);
  }

  // One query for every client involved, rather than one per brand inside the loop below: two
  // brands on the same client is the normal case, and this used to re-read the same row each time.
  const clientRows = await db
    .select({
      id: schema.clients.id,
      notionAccountIds: schema.clients.notionAccountIds,
      manualAddIds: schema.clients.manualAddIds,
      manualRemoveIds: schema.clients.manualRemoveIds,
      raw: schema.clients.raw,
    })
    .from(schema.clients)
    .where(inArray(schema.clients.id, [...new Set(brandRows.map((b) => b.clientId))]));
  const clientById = new Map(clientRows.map((c) => [c.id, c]));

  const brands: ScopedBrand[] = [];
  const brandOf = new Map<string, string>();
  const visible = new Set<string>();
  // Meta's own campaign name, which is the default client-facing label. Collected here because the
  // campaigns are already being read per brand and re-querying them for the name would double the
  // round trips on the portal's hottest path.
  const metaName = new Map<string, string>();
  const projectOf = new Map<string, string>();
  const projectMeta = new Map<string, { title: string; brandId: string }>();
  for (const b of brandRows) {
    const clientRow = clientById.get(b.clientId);
    if (!clientRow) continue;

    // Resolved on every read, so a new engagement on the Notion board reaches the portal without
    // the brand being re-saved. `brandAccountIds` already intersects with the client's effective
    // accounts, so an account removed in the UI stays removed even if a stale board row lists it.
    const usable = brandAccountIds(b.projectIds, clientRow, overridesByBrand.get(b.id) ?? []);
    if (usable.length === 0) continue;

    const brand: ScopedBrand = {
      id: b.id,
      clientId: b.clientId,
      name: b.name,
      pageName: b.pageName,
      pageAvatarUrl: b.pageAvatarUrl,
      defaultCommission: b.defaultCommission,
      accountIds: usable,
    };
    const covered = coveredProjects(b.projectIds, clientRow.raw);
    const projectOfAcct = projectOfAccount(covered, usable);
    const titleOf = new Map(covered.map((p) => [p.pageId, p.title]));

    // null = "no ownership restriction needed", i.e. every campaign on these accounts is this
    // client's. Otherwise it is the explicit whitelist.
    const owned = await ownedCampaignIds(b.clientId, usable);
    const ownedSet = owned === null ? null : new Set(owned);

    const onAccounts = await db
      .select({
        id: schema.campaigns.id,
        name: schema.campaigns.name,
        accountId: schema.campaigns.accountId,
      })
      .from(schema.campaigns)
      .where(inArray(schema.campaigns.accountId, usable));
    for (const c of onAccounts) metaName.set(c.id, c.name);

    const ownedCampaigns = onAccounts
      .filter((c) => ownedSet === null || ownedSet.has(c.id))
      .map((c) => ({ id: c.id, projectId: projectOfAcct.get(c.accountId) }));
    const wanted = new Set(visibleUnderGrants(b.id, ownedCampaigns, narrowing));
    if (wanted.size === 0) continue;

    for (const c of ownedCampaigns) {
      if (!wanted.has(c.id)) continue;
      visible.add(c.id);
      brandOf.set(c.id, b.id);
      if (c.projectId === undefined) continue;
      projectOf.set(c.id, c.projectId);
      projectMeta.set(c.projectId, { title: titleOf.get(c.projectId) ?? "", brandId: b.id });
    }
    brands.push(brand);
  }

  if (visible.size === 0) return EMPTY_SCOPE(actor);

  // The client-facing name defaults to the Meta campaign name, and `portal_campaigns.alias` is an
  // override for when it is not good enough. That is the owner's call and it matches reality: most
  // of these names are already written for a human ("Welcome Offer Casino", "Betheboss CA").
  //
  // The cost is real and is handled in the admin screens rather than here: 99 of 627 names carry a
  // " - Copy" suffix, 38 are opaque ids, 13 are Meta's own placeholder text, and 4 name a
  // DIFFERENT client. `listCampaignPresentation` flags those so they get looked at; an operator
  // then either overrides the alias or sets `hidden`. What this function must not do is invent a
  // name or silently drop a campaign — a missing row now means "use the Meta name", not "hide".
  const presentation = await db
    .select({
      campaignId: schema.portalCampaigns.campaignId,
      alias: schema.portalCampaigns.alias,
      hidden: schema.portalCampaigns.hidden,
    })
    .from(schema.portalCampaigns)
    .where(inArray(schema.portalCampaigns.campaignId, [...visible]));

  const override = new Map(presentation.map((p) => [p.campaignId, p]));

  const aliasOf = new Map<string, string>();
  for (const id of visible) {
    const row = override.get(id);
    if (row?.hidden) continue; // the explicit opt-out, and now the only way to hide a campaign
    const name = row?.alias?.trim() || metaName.get(id)?.trim();
    // A campaign with neither an override nor a name on the Meta row has nothing to label it with,
    // so it stays out rather than rendering blank.
    if (name) aliasOf.set(id, name);
  }

  const campaignIds = [...visible].filter((id) => aliasOf.has(id));
  for (const id of [...brandOf.keys()]) if (!aliasOf.has(id)) brandOf.delete(id);
  for (const id of [...projectOf.keys()]) if (!aliasOf.has(id)) projectOf.delete(id);
  const keptBrands = new Set(brandOf.values());

  // Per-project overrides, one query for every project a visible campaign counts under.
  const pageIds = [...new Set(projectOf.values())];
  const settingsRows =
    pageIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.portalProjectSettings)
          .where(inArray(schema.portalProjectSettings.pageId, pageIds));
  const settingsOf = new Map(settingsRows.map((s) => [s.pageId, s]));
  const projects = new Map<string, ScopedProject>();
  for (const pageId of pageIds) {
    const meta = projectMeta.get(pageId);
    if (!meta) continue;
    const s = settingsOf.get(pageId);
    projects.set(pageId, {
      pageId,
      title: meta.title,
      brandId: meta.brandId,
      pageName: s?.pageName ?? null,
      pageAvatarUrl: s?.pageAvatarUrl ?? null,
      commission: s?.commission ?? null,
    });
  }

  return {
    actor,
    brands: brands.filter((b) => keptBrands.has(b.id)),
    campaignIds,
    aliasOf,
    brandOf,
    projectOf,
    projects,
  };
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
  const projectOf = new Map<string, string>();
  for (const id of kept) {
    const brandId = scope.brandOf.get(id);
    if (brandId !== undefined) brandOf.set(id, brandId);
    const alias = scope.aliasOf.get(id);
    if (alias !== undefined) aliasOf.set(id, alias);
    const pageId = scope.projectOf.get(id);
    if (pageId !== undefined) projectOf.set(id, pageId);
  }
  const pageIds = new Set(projectOf.values());
  return {
    actor: scope.actor,
    brands: scope.brands.filter((b) => wanted.has(b.id)),
    campaignIds,
    aliasOf,
    brandOf,
    projectOf,
    projects: new Map([...scope.projects].filter(([pageId]) => pageIds.has(pageId))),
  };
}

/**
 * The markup a campaign falls back to when it has no rate history of its own, for `markupRows`:
 * its project's commission, else its brand's default, else `fallback`. Inheritance runs one way —
 * a project only ever overrides its brand, never the other way round.
 */
export function defaultCommissionLookup(
  scope: PortalScope,
  fallback: number,
): (campaignId: string) => number {
  const byBrand = new Map<string, number>();
  for (const b of scope.brands) byBrand.set(b.id, b.defaultCommission ?? fallback);
  return (campaignId) => {
    const pageId = scope.projectOf.get(campaignId);
    const projectRate =
      pageId === undefined ? null : (scope.projects.get(pageId)?.commission ?? null);
    if (projectRate !== null) return projectRate;
    const brandId = scope.brandOf.get(campaignId);
    const rate = brandId === undefined ? undefined : byBrand.get(brandId);
    return rate ?? fallback;
  };
}

/** True when the actor may see this campaign. Ops that take a campaign id MUST check it. */
export const canSeeCampaign = (scope: PortalScope, campaignId: string): boolean =>
  scope.aliasOf.has(campaignId);
