import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ownedCampaignIds } from "@/server/fns/campaign-attribution";
import {
  brandAccountIds,
  clientProjects,
  coveredProjects,
  groupId,
  projectGroups,
  projectOfAccount,
} from "@/portal/brand-accounts";
import {
  defaultRateOn,
  loadDefaultCommissions,
  type DefaultCommissionPeriod,
  type DefaultRateLookup,
} from "@/portal/markup";

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
  /** The ad previews' default page name for the brand's groups; null = use `name`. */
  pageName: string | null;
  /** The ad previews' default profile photo, a public https URL; null = initials. */
  pageAvatarUrl: string | null;
  /**
   * The Client default's dated schedule (`commission_defaults`), oldest first — what a campaign
   * day falls back to when neither the campaign nor its Brand has an entry in force. Empty = the
   * agency default throughout.
   */
  commission: DefaultCommissionPeriod[];
  accountIds: string[];
}

/**
 * One Brand — a group of an owner's board rows (`projectGroups`) — that a visible campaign counts
 * under, with its own settings. A null field inherits the brand's value; see `portal_group_settings`.
 */
export interface ScopedGroup {
  /** Global: `<owner clients.id>:<key>` (`groupId`). */
  id: string;
  key: string;
  clientId: string;
  /** The `brands` row it was reached through. */
  brandId: string;
  name: string;
  pageName: string | null;
  pageAvatarUrl: string | null;
  /** Its own dated commission schedule, oldest first. Empty = the Client's throughout. */
  commission: DefaultCommissionPeriod[];
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
   * The group each visible campaign counts under: the group of the newest covered board row
   * listing its account (`projectOfAccount`). Absent for a campaign on an account no covered row
   * lists — it inherits the brand's settings.
   */
  groupOf: Map<string, string>;
  /** The groups `groupOf` points at, by global id. */
  groups: Map<string, ScopedGroup>;
}

const EMPTY_SCOPE = (actor: PortalActor): PortalScope => ({
  actor,
  brands: [],
  campaignIds: [],
  aliasOf: new Map(),
  brandOf: new Map(),
  groupOf: new Map(),
  groups: new Map(),
});

/** What grouping an owner's board rows needs from the database, per owner (`clients.id`). */
export interface GroupInputs {
  /** Page id → group key, for rows an admin moved. */
  overrides: Map<string, Map<string, string>>;
  /** Group key → that group's settings row. */
  settings: Map<string, Map<string, typeof schema.portalGroupSettings.$inferSelect>>;
}

/** Load the row moves and group settings of the given owners, in two queries. */
export async function loadGroupInputs(clientIds: string[]): Promise<GroupInputs> {
  const inputs: GroupInputs = { overrides: new Map(), settings: new Map() };
  if (clientIds.length === 0) return inputs;
  const [moves, settings] = await Promise.all([
    db
      .select({
        pageId: schema.portalProjectSettings.pageId,
        clientId: schema.portalProjectSettings.clientId,
        groupKey: schema.portalProjectSettings.groupKey,
      })
      .from(schema.portalProjectSettings)
      .where(inArray(schema.portalProjectSettings.clientId, clientIds)),
    db
      .select()
      .from(schema.portalGroupSettings)
      .where(inArray(schema.portalGroupSettings.clientId, clientIds)),
  ]);
  for (const m of moves) {
    if (!m.groupKey) continue;
    let map = inputs.overrides.get(m.clientId);
    if (!map) inputs.overrides.set(m.clientId, (map = new Map()));
    map.set(m.pageId, m.groupKey);
  }
  for (const s of settings) {
    let map = inputs.settings.get(s.clientId);
    if (!map) inputs.settings.set(s.clientId, (map = new Map()));
    map.set(s.groupKey, s);
  }
  return inputs;
}

/** The admin-set names of one owner's groups, as `projectGroups` takes them. */
export function groupNames(inputs: GroupInputs, clientId: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const [key, s] of inputs.settings.get(clientId) ?? []) if (s.name) names.set(key, s.name);
  return names;
}

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
 * resolved through its client's ownership. A campaign or group grant is intersected with the
 * same ownership result rather than trusted directly: a grant left behind after an account was
 * recycled would otherwise hand a client a campaign that now belongs to somebody else.
 *
 * Only a `brand` grant opens a whole brand. A brand reached through a group or campaign grant
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
  const groups = new Map<string, Set<string>>();
  for (const g of grants) {
    if (g.scope === "brand") wholeBrands.add(g.targetId);
    else if (g.scope === "campaign") campaigns.add(g.targetId);
    else if (g.scope === "group" && g.parentId) {
      const set = groups.get(g.parentId);
      if (set) set.add(g.targetId);
      else groups.set(g.parentId, new Set([g.targetId]));
    }
  }

  const toResolve = new Set<string>([...wholeBrands, ...groups.keys()]);
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

  return brandScope(actor, [...toResolve], { wholeBrands, groups, campaigns });
}

/** How much of a brand a caller may see, when the brand itself was not granted outright. */
export interface GrantNarrowing {
  /** Brands granted outright — every campaign the brand owns is visible. */
  wholeBrands: ReadonlySet<string>;
  /** Group grants: brand id → the group ids granted within it. */
  groups: ReadonlyMap<string, ReadonlySet<string>>;
  /** Campaigns granted individually, for a brand reached only through such a grant. */
  campaigns: ReadonlySet<string>;
}

/**
 * Which of one brand's campaigns a caller may see.
 *
 * Everything, for a brand granted outright; for any other brand, only campaigns granted
 * individually or counting under a group granted WITHIN THIS BRAND — a group grant held through
 * another brand opens nothing here. `groupId` is the campaign's group, absent when no covered row
 * lists its account, and such a campaign is never reachable through a group grant.
 */
export function visibleUnderGrants(
  brandId: string,
  campaigns: readonly { id: string; groupId: string | undefined }[],
  narrowing: GrantNarrowing,
): string[] {
  if (narrowing.wholeBrands.has(brandId)) return campaigns.map((c) => c.id);
  const granted = narrowing.groups.get(brandId);
  return campaigns
    .filter(
      (c) =>
        narrowing.campaigns.has(c.id) ||
        (c.groupId !== undefined && granted !== undefined && granted.has(c.groupId)),
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
  const ownerIds = [...new Set(brandRows.map((b) => b.clientId))];
  const [clientRows, inputs] = await Promise.all([
    db
      .select({
        id: schema.clients.id,
        notionAccountIds: schema.clients.notionAccountIds,
        manualAddIds: schema.clients.manualAddIds,
        manualRemoveIds: schema.clients.manualRemoveIds,
        raw: schema.clients.raw,
      })
      .from(schema.clients)
      .where(inArray(schema.clients.id, ownerIds)),
    loadGroupInputs(ownerIds),
  ]);
  const clientById = new Map(clientRows.map((c) => [c.id, c]));

  // Commission schedules are attached at the end, in one query for every brand and group kept.
  const brands: Omit<ScopedBrand, "commission">[] = [];
  // Meta's own campaign name, which is the default client-facing label. Collected here because the
  // campaigns are already being read per brand and re-querying them for the name would double the
  // round trips on the portal's hottest path.
  const metaName = new Map<string, string>();
  const claims: CampaignClaim[] = [];
  for (const b of brandRows) {
    const clientRow = clientById.get(b.clientId);
    if (!clientRow) continue;

    // Resolved on every read, so a new engagement on the Notion board reaches the portal without
    // the brand being re-saved. `brandAccountIds` already intersects with the client's effective
    // accounts, so an account removed in the UI stays removed even if a stale board row lists it.
    const usable = brandAccountIds(b.projectIds, clientRow, overridesByBrand.get(b.id) ?? []);
    if (usable.length === 0) continue;

    const brand: Omit<ScopedBrand, "commission"> = {
      id: b.id,
      clientId: b.clientId,
      name: b.name,
      pageName: b.pageName,
      pageAvatarUrl: b.pageAvatarUrl,
      accountIds: usable,
    };
    // Groups are formed over the owner's WHOLE board, so a Brand has the same members and name in
    // every client that covers part of it; attribution then only looks at the rows this one covers.
    const groupOfPage = new Map<string, { key: string; name: string }>();
    const all = clientProjects(clientRow.raw);
    const overrides = inputs.overrides.get(b.clientId);
    for (const g of projectGroups(all, overrides, groupNames(inputs, b.clientId))) {
      for (const p of g.projects) groupOfPage.set(p.pageId, { key: g.key, name: g.name });
    }
    const projectOfAcct = projectOfAccount(coveredProjects(b.projectIds, clientRow.raw), usable);

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
      .map((c) => {
        const pageId = projectOfAcct.get(c.accountId);
        const g = pageId === undefined ? undefined : groupOfPage.get(pageId);
        return { id: c.id, group: g, groupId: g && groupId(b.clientId, g.key) };
      });
    const wanted = new Set(visibleUnderGrants(b.id, ownedCampaigns, narrowing));
    if (wanted.size === 0) continue;

    claims.push({
      brandId: b.id,
      clientId: b.clientId,
      name: b.name,
      campaigns: ownedCampaigns.filter((c) => wanted.has(c.id)),
    });
    brands.push(brand);
  }

  const { brandOf, groupOf, groupMeta } = claimCampaigns(claims);
  const visible = new Set(brandOf.keys());
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
  //
  // The commission schedules ride along in the same round trip: every brand and group met above
  // is a superset of the ones kept, and loading a few extra rows is cheaper than a second wait.
  const [presentation, commissions] = await Promise.all([
    db
      .select({
        campaignId: schema.portalCampaigns.campaignId,
        alias: schema.portalCampaigns.alias,
        hidden: schema.portalCampaigns.hidden,
      })
      .from(schema.portalCampaigns)
      .where(inArray(schema.portalCampaigns.campaignId, [...visible])),
    loadDefaultCommissions({ brandIds: brands.map((b) => b.id), groupIds: [...groupMeta.keys()] }),
  ]);

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
  for (const id of [...groupOf.keys()]) if (!aliasOf.has(id)) groupOf.delete(id);
  const keptBrands = new Set(brandOf.values());

  const groups = new Map<string, ScopedGroup>();
  for (const id of new Set(groupOf.values())) {
    const meta = groupMeta.get(id);
    if (!meta) continue;
    const s = inputs.settings.get(meta.clientId)?.get(meta.key);
    groups.set(id, {
      id,
      ...meta,
      pageName: s?.pageName ?? null,
      pageAvatarUrl: s?.pageAvatarUrl ?? null,
      commission: commissions.group.get(id) ?? [],
    });
  }

  return {
    actor,
    brands: brands
      .filter((b) => keptBrands.has(b.id))
      .map((b) => ({ ...b, commission: commissions.brand.get(b.id) ?? [] })),
    campaignIds,
    aliasOf,
    brandOf,
    groupOf,
    groups,
  };
}

/** One `brands` row's visible campaigns, each with the Brand (group) it counts under there. */
export interface CampaignClaim {
  brandId: string;
  /** The owner (`clients.id`). */
  clientId: string;
  name: string;
  campaigns: readonly {
    id: string;
    group: { key: string; name: string } | undefined;
    groupId: string | undefined;
  }[];
}

/**
 * Give each campaign exactly one client — and with it one Brand — when several of the caller's
 * clients cover it (two `brands` rows of one owner over the same accounts): the first by name, then
 * id, whatever order the rows were read in.
 *
 * The client decides the commission default a campaign's inherited days are billed at, so the
 * choice must be stable across page loads (heap order is not) and must be the one the staff
 * commission dialog prices its timeline through (`campaignOwners`, same order). The Brand is taken
 * from the same client, so a campaign never pairs one client's Brand with another's default.
 */
export function claimCampaigns(claims: readonly CampaignClaim[]): {
  brandOf: Map<string, string>;
  groupOf: Map<string, string>;
  groupMeta: Map<string, { key: string; clientId: string; brandId: string; name: string }>;
} {
  const brandOf = new Map<string, string>();
  const groupOf = new Map<string, string>();
  const groupMeta = new Map<
    string,
    { key: string; clientId: string; brandId: string; name: string }
  >();
  const ordered = [...claims].sort((a, b) =>
    byNameThenId({ id: a.brandId, name: a.name }, { id: b.brandId, name: b.name }),
  );
  for (const claim of ordered) {
    for (const c of claim.campaigns) {
      if (brandOf.has(c.id)) continue;
      brandOf.set(c.id, claim.brandId);
      if (!c.group || !c.groupId) continue;
      groupOf.set(c.id, c.groupId);
      if (groupMeta.has(c.groupId)) continue;
      groupMeta.set(c.groupId, {
        key: c.group.key,
        clientId: claim.clientId,
        brandId: claim.brandId,
        name: c.group.name,
      });
    }
  }
  return { brandOf, groupOf, groupMeta };
}

/**
 * The portal's "brand" for a campaign — what a customer picks under "All your brands".
 *
 * A customer's brands are the Brands the admin console shows: groups of an owner's board rows
 * (`groupOf`, global id). A campaign on an account that no covered row lists (a manual addition)
 * falls back to its `brands` row, so EVERY visible campaign has exactly one portal brand and the
 * brands' figures always add up to "All your brands".
 */
export function portalBrandOf(
  scope: Pick<PortalScope, "groupOf" | "brandOf">,
  campaignId: string,
): string | undefined {
  return scope.groupOf.get(campaignId) ?? scope.brandOf.get(campaignId);
}

/** One brand a customer can switch between, and the client (`brands.id`) it is shown under. */
export interface PortalBrandEntry {
  id: string;
  name: string;
  /**
   * The `brands` row the brand is reached through — the customer's "client". For the fallback
   * entry (campaigns under no board row) it equals `id`, which is how the portal tells the two
   * apart and labels the fallback as that client's other campaigns.
   */
  clientId: string;
}

/**
 * The brands a customer can switch between: one per portal brand holding a visible campaign,
 * named by its group's name (or, for the fallback, by the client's name), sorted by name. A group
 * reached through two of the customer's clients appears once — it is keyed by its global id.
 *
 * Such a group is listed under the first of those clients by name (then id), not under whichever
 * client's campaigns happened to be read first: `campaignIds` follows database order, and a brand
 * hopping between clients from one page load to the next would be worse than either choice. The
 * client is taken from the visible campaigns (`brandOf`) rather than `ScopedGroup.brandId`, which
 * can name a client whose every campaign was later dropped for want of a name.
 */
export function portalBrands(scope: PortalScope): PortalBrandEntry[] {
  const clientById = new Map(scope.brands.map((b) => [b.id, b]));
  const entries = new Map<string, PortalBrandEntry>();
  for (const id of scope.campaignIds) {
    const key = portalBrandOf(scope, id);
    const client = clientById.get(scope.brandOf.get(id) ?? "");
    if (key === undefined || !client) continue;
    const seen = entries.get(key);
    if (seen) {
      const current = clientById.get(seen.clientId);
      if (current && byNameThenId(client, current) < 0) seen.clientId = client.id;
      continue;
    }
    const name = scope.groups.get(key)?.name ?? (key === client.id ? client.name : undefined);
    if (name) entries.set(key, { id: key, name, clientId: client.id });
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const byNameThenId = (a: { id: string; name: string }, b: { id: string; name: string }): number =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * The clients `brands` are listed under, sorted by name — only those some brand belongs to, as an
 * id and a name. `ScopedBrand` also carries ad accounts and commission; neither may leave here.
 */
export function portalClients(
  scope: PortalScope,
  brands: readonly PortalBrandEntry[],
): { id: string; name: string }[] {
  const used = new Set(brands.map((b) => b.clientId));
  return scope.brands
    .filter((b) => used.has(b.id))
    .map((b) => ({ id: b.id, name: b.name }))
    .sort(byNameThenId);
}

/**
 * Narrow a resolved scope to the portal brands (`portalBrandOf`) the caller asked for.
 *
 * The request's ids are treated as a FILTER over what the user already has, never as a lookup: an
 * id the user was not granted contributes nothing instead of widening the scope. An empty or absent
 * selection — or one naming nothing in scope, such as a saved selection from before brands were
 * groups — means "everything in scope", which is what "All your brands" sends.
 *
 * The clients (`brands`) of the kept campaigns stay in the narrowed scope, because commission and
 * the ad page still inherit from them.
 */
export function narrowToPortalBrands(
  scope: PortalScope,
  brandIds: string[] | undefined,
): PortalScope {
  if (!brandIds || brandIds.length === 0) return scope;
  const inScope = new Set(scope.campaignIds.map((id) => portalBrandOf(scope, id)));
  const wanted = new Set(brandIds.filter((id) => inScope.has(id)));
  if (wanted.size === 0) return scope;

  const campaignIds = scope.campaignIds.filter((id) => {
    const key = portalBrandOf(scope, id);
    return key !== undefined && wanted.has(key);
  });
  const brandOf = new Map<string, string>();
  const aliasOf = new Map<string, string>();
  const groupOf = new Map<string, string>();
  for (const id of campaignIds) {
    const brandId = scope.brandOf.get(id);
    if (brandId !== undefined) brandOf.set(id, brandId);
    const alias = scope.aliasOf.get(id);
    if (alias !== undefined) aliasOf.set(id, alias);
    const gid = scope.groupOf.get(id);
    if (gid !== undefined) groupOf.set(id, gid);
  }
  const clientIds = new Set(brandOf.values());
  const groupIds = new Set(groupOf.values());
  return {
    actor: scope.actor,
    brands: scope.brands.filter((b) => clientIds.has(b.id)),
    campaignIds,
    aliasOf,
    brandOf,
    groupOf,
    groups: new Map([...scope.groups].filter(([id]) => groupIds.has(id))),
  };
}

/**
 * What a campaign-day is billed at when the campaign has no entry of its own in force that day,
 * for `markupRows`: its group's (Brand's) rate on that date, else its brand's (Client's) default on
 * that date, else `fallback`. Each level is a dated schedule and is read AS IT STOOD ON THE DAY, so
 * a default changed from some date re-prices nothing before it. Inheritance runs one way — a group
 * only ever overrides its brand, never the other way round — and `markup.ts`'s `commissionOn` is
 * the same order with the source attached, for the staff screens.
 */
export function defaultCommissionLookup(scope: PortalScope, fallback: number): DefaultRateLookup {
  const byBrand = new Map(scope.brands.map((b) => [b.id, b.commission]));
  return (campaignId, date) => {
    const gid = scope.groupOf.get(campaignId);
    const groupRate =
      gid === undefined ? null : defaultRateOn(scope.groups.get(gid)?.commission, date);
    if (groupRate !== null) return groupRate;
    const brandId = scope.brandOf.get(campaignId);
    return (brandId === undefined ? null : defaultRateOn(byBrand.get(brandId), date)) ?? fallback;
  };
}

/** True when the actor may see this campaign. Ops that take a campaign id MUST check it. */
export const canSeeCampaign = (scope: PortalScope, campaignId: string): boolean =>
  scope.aliasOf.has(campaignId);
