import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { addDays } from "@/lib/range";
import { LIVE_STATUSES } from "@/notion/parse";
import { brandAccountIds, clientProjects, projectSelection } from "@/portal/brand-accounts";
import { effectiveAccountIds } from "@/sync/jobs/clients";
import { audit, requireAdmin } from "./auth";
import { ownedCampaignIds } from "./campaign-attribution";

/**
 * The staff side of the client portal: what a brand is, what it is charged, and who may see it.
 *
 * Everything the portal shows a client is curated here and nowhere else — a campaign without an
 * alias is invisible, a user without a grant sees nothing, and the commission history is what turns
 * the agency's raw spend into the client-facing figure. None of it is reachable from the portal
 * itself: `requireAdmin()` opens every function, and the ops that wrap them are named so that
 * `src/server/api/http.ts` cannot route a client token to them.
 *
 * Mutations return `{ok,error?}` instead of throwing, matching the infra registry: the admin screens
 * render that string inline, and a thrown validation error loses the reason.
 */

// ── Projects (Notion engagements) ──────────────────────────────────────────────────────────────

export interface ClientProjectView {
  pageId: string;
  /** The Notion row title, e.g. "betonline.ag (August/September)". */
  title: string;
  status: string | null;
  /** True while the engagement is current — see `LIVE_STATUSES`. */
  live: boolean;
  /** Accounts on this row that the client still effectively owns. */
  accountIds: string[];
  /** Accounts the row lists that are no longer the client's, so the count reads honestly. */
  droppedAccountCount: number;
  /** Campaigns this client owns across those accounts. */
  campaignCount: number;
}

/**
 * The client's projects, for the brand setup screen.
 *
 * This is what replaces picking ad accounts by hand. The Notion board already records, per
 * engagement, which accounts it runs on; the sync stores those rows at row grain for exactly this.
 * So the operator chooses a client, sees its engagements, and the accounts follow.
 *
 * `campaignCount` goes through `ownedCampaignIds()` rather than counting every campaign on the
 * accounts, because a recycled account carries another client's campaigns too and the number has to
 * mean "what this client would actually get".
 *
 * Rows are returned newest-status-first: live engagements at the top, then the rest in board order,
 * so the common case needs no reading. A row whose accounts have all been dropped from the client
 * is still returned — with `accountIds` empty — because hiding it would make the board and this
 * screen disagree about what exists.
 */
export async function fetchClientProjects(clientId: string): Promise<ClientProjectView[]> {
  await requireAdmin();
  const [client] = await db
    .select({
      notionAccountIds: schema.clients.notionAccountIds,
      manualAddIds: schema.clients.manualAddIds,
      manualRemoveIds: schema.clients.manualRemoveIds,
      raw: schema.clients.raw,
    })
    .from(schema.clients)
    .where(eq(schema.clients.id, clientId));
  if (!client) return [];

  const effective = new Set(effectiveAccountIds(client));
  const projects = clientProjects(client.raw);
  if (projects.length === 0) return [];

  const allAccountIds = [
    ...new Set(projects.flatMap((p) => p.accountIds).filter((id) => effective.has(id))),
  ];
  const owned = allAccountIds.length === 0 ? [] : await ownedCampaignIds(clientId, allAccountIds);
  const ownedSet = owned === null ? null : new Set(owned);
  const campaignRows =
    allAccountIds.length === 0
      ? []
      : await db
          .select({ id: schema.campaigns.id, accountId: schema.campaigns.accountId })
          .from(schema.campaigns)
          .where(inArray(schema.campaigns.accountId, allAccountIds));
  const campaignsByAccount = new Map<string, string[]>();
  for (const c of campaignRows) {
    const list = campaignsByAccount.get(c.accountId);
    if (list) list.push(c.id);
    else campaignsByAccount.set(c.accountId, [c.id]);
  }

  const views = projects.map((p, order): ClientProjectView & { order: number } => {
    const accountIds = p.accountIds.filter((id) => effective.has(id));
    const ids = accountIds
      .flatMap((a) => campaignsByAccount.get(a) ?? [])
      .filter((id) => ownedSet === null || ownedSet.has(id));
    return {
      pageId: p.pageId,
      title: p.title,
      status: p.status,
      live: p.status !== null && LIVE_STATUSES.includes(p.status),
      accountIds: [...new Set(accountIds)].sort(),
      droppedAccountCount: p.accountIds.length - accountIds.length,
      campaignCount: new Set(ids).size,
      order,
    };
  });

  return views
    .sort((a, b) => Number(b.live) - Number(a.live) || a.order - b.order)
    .map(({ order: _order, ...view }) => view);
}

// ── Brands ─────────────────────────────────────────────────────────────────────────────────────

export interface BrandAdminView {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  website: string | null;
  monthlyBudget: number | null;
  defaultCommission: number | null;
  /** Resolved on read from the project selection — not a stored mapping. */
  accountIds: string[];
  /** `null` = follows the client, including engagements it has not won yet. */
  projectIds: string[] | null;
  /** Projects on the client's Notion board in total. */
  projectCount: number;
  /** How many of those this brand covers. Equal to `projectCount` when it follows the client. */
  selectedProjectCount: number;
  /** Campaigns this brand's client owns on those accounts. */
  campaignCount: number;
  /** How many of those a client can actually see — i.e. how much of the brand has been curated. */
  visibleCampaignCount: number;
  createdAt: string;
}

/**
 * Every brand, with the accounts its project selection resolves to and the counts that explain it.
 *
 * Accounts are DERIVED here, exactly as `portalScope()` derives them, rather than read back from a
 * stored mapping — that is the point of `brands.project_ids`, and computing it a second way here
 * would let the admin screen and the portal disagree about what a client can see.
 *
 * The campaign counts go through `ownedCampaignIds()` per brand rather than a cheap
 * `accounts ⋈ campaigns` join: a recycled account is claimed by two clients, and the join would
 * credit each of them with the other's campaigns. Brands are a table of tens of rows, so the
 * per-brand round trip is affordable.
 */
export async function fetchBrands(): Promise<BrandAdminView[]> {
  await requireAdmin();
  const [brandRows, clientRows, overrideRows, presentationRows] = await Promise.all([
    db.select().from(schema.brands),
    db
      .select({
        id: schema.clients.id,
        name: schema.clients.name,
        notionAccountIds: schema.clients.notionAccountIds,
        manualAddIds: schema.clients.manualAddIds,
        manualRemoveIds: schema.clients.manualRemoveIds,
        raw: schema.clients.raw,
      })
      .from(schema.clients),
    db.select().from(schema.brandAccounts),
    db
      .select({
        campaignId: schema.portalCampaigns.campaignId,
        alias: schema.portalCampaigns.alias,
        hidden: schema.portalCampaigns.hidden,
      })
      .from(schema.portalCampaigns),
  ]);
  if (brandRows.length === 0) return [];

  const clientById = new Map(clientRows.map((c) => [c.id, c]));

  const overridesByBrand = new Map<string, string[]>();
  for (const m of overrideRows) {
    const list = overridesByBrand.get(m.brandId);
    if (list) list.push(m.accountId);
    else overridesByBrand.set(m.brandId, [m.accountId]);
  }

  // Resolve first: the campaign lookup below needs the union of every brand's accounts, and that
  // is only known once each project selection has been applied.
  const resolved = brandRows.map((b) => {
    const client = clientById.get(b.clientId);
    return {
      brand: b,
      client,
      accountIds: client
        ? brandAccountIds(b.projectIds, client, overridesByBrand.get(b.id) ?? []).sort()
        : [],
    };
  });

  const allAccountIds = [...new Set(resolved.flatMap((r) => r.accountIds))];
  const campaignRows =
    allAccountIds.length === 0
      ? []
      : await db
          .select({ id: schema.campaigns.id, accountId: schema.campaigns.accountId })
          .from(schema.campaigns)
          .where(inArray(schema.campaigns.accountId, allAccountIds));
  const campaignsByAccount = new Map<string, string[]>();
  for (const c of campaignRows) {
    const list = campaignsByAccount.get(c.accountId);
    if (list) list.push(c.id);
    else campaignsByAccount.set(c.accountId, [c.id]);
  }

  const visible = new Set(
    presentationRows.filter((p) => p.alias && !p.hidden).map((p) => p.campaignId),
  );

  const views = await Promise.all(
    resolved.map(async ({ brand: b, client, accountIds }): Promise<BrandAdminView> => {
      const owned = accountIds.length === 0 ? [] : await ownedCampaignIds(b.clientId, accountIds);
      const ownedSet = owned === null ? null : new Set(owned);
      const ids = accountIds
        .flatMap((a) => campaignsByAccount.get(a) ?? [])
        .filter((id) => ownedSet === null || ownedSet.has(id));

      const projects = clientProjects(client?.raw);
      const selection = projectSelection(b.projectIds);
      const selectedIds = new Set(selection ?? []);

      return {
        id: b.id,
        clientId: b.clientId,
        clientName: client?.name ?? b.clientId,
        name: b.name,
        website: b.website,
        monthlyBudget: b.monthlyBudget,
        defaultCommission: b.defaultCommission,
        accountIds,
        projectIds: selection,
        projectCount: projects.length,
        selectedProjectCount:
          selection === null
            ? projects.length
            : projects.filter((p) => selectedIds.has(p.pageId)).length,
        campaignCount: ids.length,
        visibleCampaignCount: ids.filter((id) => visible.has(id)).length,
        createdAt: b.createdAt.toISOString(),
      };
    }),
  );

  return views.sort(
    (a, b) => a.clientName.localeCompare(b.clientName) || a.name.localeCompare(b.name),
  );
}

export interface UpsertBrandInput {
  /** Absent, null or empty means create — the edit form sends `""` for a new row. */
  id?: string | null;
  clientId: string;
  name: string;
  website?: string | null;
  monthlyBudget?: number | null;
  defaultCommission?: number | null;
  /**
   * Which of the client's Notion projects this brand covers.
   *
   * Three distinct values, and the difference matters:
   * - `null` — follow the client, now and in future. The default for a new brand.
   * - `string[]` — exactly these page ids.
   * - absent (`undefined`) — leave an existing brand's selection alone. Only meaningful on update.
   *
   * JSON carries the first two and drops the third, so the wire format expresses all three.
   */
  projectIds?: string[] | null;
}

/**
 * Create or update a brand.
 *
 * `client_id` is `ON DELETE RESTRICT`, so an unknown id would surface as a raw constraint violation;
 * it is checked first to answer with a sentence instead. Both money fields reject negatives because
 * a negative default commission would quietly *discount* the client below cost.
 */
export async function upsertBrand(
  input: UpsertBrandInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  await requireAdmin();
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name is required" };
  if (input.monthlyBudget != null && !(input.monthlyBudget >= 0)) {
    return { ok: false, error: "Monthly budget cannot be negative" };
  }
  if (input.defaultCommission != null && !(input.defaultCommission >= 0)) {
    return { ok: false, error: "Default commission cannot be negative" };
  }

  const [client] = await db
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(eq(schema.clients.id, input.clientId));
  if (!client) return { ok: false, error: `Unknown client "${input.clientId}"` };

  const fields = {
    clientId: input.clientId,
    name,
    website: input.website?.trim() || null,
    monthlyBudget: input.monthlyBudget ?? null,
    defaultCommission: input.defaultCommission ?? null,
  };
  // Distinguished from `null` on purpose: `null` means "follow the client" and is a real setting,
  // while an absent key on an update means "do not touch the selection I already have".
  const selection = input.projectIds === undefined ? undefined : (input.projectIds ?? null);

  if (input.id) {
    const [existing] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(eq(schema.brands.id, input.id));
    if (!existing) return { ok: false, error: "Brand not found" };

    await db
      .update(schema.brands)
      .set(selection === undefined ? fields : { ...fields, projectIds: selection })
      .where(eq(schema.brands.id, input.id));
    await audit("portal.brand.update", `${name} (${input.id})`);
    return { ok: true, id: input.id };
  }

  const id = randomUUID();
  await db.insert(schema.brands).values({ ...fields, id, projectIds: selection ?? null });
  await audit("portal.brand.create", `${name} (${id})`);
  return { ok: true, id };
}

/**
 * Delete a brand, its account mapping and every grant that pointed at it.
 *
 * `brand_accounts` cascades, but `portal_grants.target_id` deliberately carries no FK (it is
 * polymorphic over brands and campaigns), so nothing in the database cleans those up. A leftover
 * grant is not merely untidy: it keeps naming a target the access list can no longer resolve, and
 * it becomes live access again the moment that id exists once more — a restored row or a re-imported
 * export is enough.
 */
export async function removeBrand(input: { id: string }): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const [existing] = await db
    .select({ name: schema.brands.name })
    .from(schema.brands)
    .where(eq(schema.brands.id, input.id));
  if (!existing) return { ok: false, error: "Brand not found" };

  const removed = await db
    .delete(schema.portalGrants)
    .where(and(eq(schema.portalGrants.scope, "brand"), eq(schema.portalGrants.targetId, input.id)))
    .returning({ id: schema.portalGrants.id });
  await db.delete(schema.brands).where(eq(schema.brands.id, input.id));

  await audit(
    "portal.brand.delete",
    `${existing.name} (${input.id}), ${removed.length} grant(s) revoked`,
  );
  return { ok: true };
}

/**
 * Replace a brand's ad-account mapping.
 *
 * Accounts are not checked for existence on purpose: `accounts` is sync-owned and a row disappears
 * whenever Meta stops returning it, so requiring one would make an operator unable to map an account
 * before its first sync — and would delete the mapping later for a reason that has nothing to do
 * with the brand.
 */
export async function replaceBrandAccounts(input: {
  brandId: string;
  accountIds: string[];
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const [existing] = await db
    .select({ name: schema.brands.name })
    .from(schema.brands)
    .where(eq(schema.brands.id, input.brandId));
  if (!existing) return { ok: false, error: "Brand not found" };

  const accountIds = [...new Set(input.accountIds)];
  await db.transaction(async (tx) => {
    await tx.delete(schema.brandAccounts).where(eq(schema.brandAccounts.brandId, input.brandId));
    if (accountIds.length > 0) {
      await tx
        .insert(schema.brandAccounts)
        .values(accountIds.map((accountId) => ({ brandId: input.brandId, accountId })));
    }
  });

  await audit(
    "portal.brand.accounts",
    `${existing.name} (${input.brandId}): ${accountIds.join(", ") || "none"}`,
  );
  return { ok: true };
}

// ── Campaign presentation ──────────────────────────────────────────────────────────────────────

/** One curated campaign, exactly as stored. Absent rows stay absent — see `fetchCampaignPresentation`. */
export interface CampaignPresentationView {
  campaignId: string;
  alias: string | null;
  hidden: boolean;
  updatedAt: string;
}

/**
 * Read back what `upsertCampaignPresentation` stored, for the admin screen that curates it.
 *
 * Campaigns with no row are simply missing from the result rather than defaulted to
 * `{alias: campaigns.name}`: the absence IS the state the operator has to see ("not named, so no
 * client can see it"), and synthesising the internal name as an alias is the exact leak the table
 * exists to prevent — a screen that showed it would invite one Save to publish it verbatim.
 */
export async function fetchCampaignPresentation(
  input: { campaignIds?: string[] } = {},
): Promise<CampaignPresentationView[]> {
  await requireAdmin();
  const ids = input.campaignIds;
  if (ids && ids.length === 0) return [];
  const rows = await db
    .select({
      campaignId: schema.portalCampaigns.campaignId,
      alias: schema.portalCampaigns.alias,
      hidden: schema.portalCampaigns.hidden,
      updatedAt: schema.portalCampaigns.updatedAt,
    })
    .from(schema.portalCampaigns)
    .where(ids ? inArray(schema.portalCampaigns.campaignId, ids) : undefined);
  return rows.map((r) => ({
    campaignId: r.campaignId,
    alias: r.alias,
    hidden: r.hidden,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/**
 * Name a campaign for the client, or hide it again.
 *
 * This is what makes a campaign appear at all: `portalScope()` drops every campaign without a row
 * here, because falling back to `campaigns.name` would leak the internal naming convention
 * (`LP_UKIE_ABO_PUR_0625` names the account, objective and buying strategy). Clearing the alias is
 * therefore a valid way to withdraw a campaign, and `hidden` withdraws one that keeps its name.
 *
 * The campaign id is checked against `campaigns` — the column has no FK, so a typo would otherwise
 * be stored as a row that can never match anything and reads as "named, but still not showing".
 */
export async function upsertCampaignPresentation(input: {
  campaignId: string;
  alias: string | null;
  hidden: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const [campaign] = await db
    .select({ name: schema.campaigns.name })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, input.campaignId));
  if (!campaign) return { ok: false, error: `Unknown campaign "${input.campaignId}"` };

  const alias = input.alias?.trim() || null;
  const row = {
    campaignId: input.campaignId,
    alias,
    hidden: input.hidden,
    updatedBy: user.id,
    updatedAt: new Date(),
  };
  await db
    .insert(schema.portalCampaigns)
    .values(row)
    .onConflictDoUpdate({
      target: schema.portalCampaigns.campaignId,
      set: {
        alias: row.alias,
        hidden: row.hidden,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      },
    });

  await audit(
    "portal.campaign.presentation",
    `${input.campaignId}: ${alias ? `"${alias}"` : "no alias"}${input.hidden ? ", hidden" : ""}`,
  );
  return { ok: true };
}

// ── Commission ─────────────────────────────────────────────────────────────────────────────────

/** One stored rate, with the end date the next period implies. */
export interface CommissionPeriodView {
  fromDate: string;
  /** Day before the next period starts; null while this is the rate currently in force. */
  toDate: string | null;
  rate: number;
  /**
   * True for the earliest period, which also covers every date BEFORE `fromDate`. That is what
   * `rateOn()` does, and the UI must say so rather than imply the campaign was un-marked-up until
   * somebody first set a rate.
   */
  openStart: boolean;
  setByEmail: string | null;
  createdAt: string;
}

/** One stored rate as the table holds it, before the neighbouring rows give it an end. */
interface CommissionRow {
  fromDate: string;
  rate: number;
  setByEmail: string | null;
  createdAt: Date;
}

/**
 * Close each period against the next one's start.
 *
 * Pure and exported so the off-by-one has a seam: `toDate` is the day BEFORE the next period
 * begins, because a row stored `from_date = 2026-03-01` charges the new rate ON the 1st. Sorted
 * here rather than in SQL since the derivation depends on the order, and a lexical sort of
 * `YYYY-MM-DD` is the chronological one.
 */
export function commissionPeriods(rows: CommissionRow[]): CommissionPeriodView[] {
  const sorted = [...rows].sort((a, b) => a.fromDate.localeCompare(b.fromDate));
  return sorted.map((r, i) => ({
    fromDate: r.fromDate,
    toDate: i + 1 < sorted.length ? addDays(sorted[i + 1].fromDate, -1) : null,
    rate: r.rate,
    openStart: i === 0,
    setByEmail: r.setByEmail,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function fetchCampaignCommission(input: {
  campaignId: string;
}): Promise<CommissionPeriodView[]> {
  await requireAdmin();
  const rows = await db
    .select({
      fromDate: schema.campaignCommissions.fromDate,
      rate: schema.campaignCommissions.rate,
      createdAt: schema.campaignCommissions.createdAt,
      setByEmail: schema.users.email,
    })
    .from(schema.campaignCommissions)
    .leftJoin(schema.users, eq(schema.users.id, schema.campaignCommissions.setBy))
    .where(eq(schema.campaignCommissions.campaignId, input.campaignId));

  return commissionPeriods(rows.map((r) => ({ ...r, fromDate: String(r.fromDate) })));
}

/**
 * Set the rate that applies from `fromDate` onwards.
 *
 * One row per `(campaign, from_date)`, so re-sending a date corrects that period instead of adding
 * a second, contradictory one — overlapping periods are unrepresentable by design.
 */
export async function upsertCampaignCommission(input: {
  campaignId: string;
  fromDate: string;
  rate: number;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  // A negative rate would mark spend DOWN, i.e. bill the client less than the agency paid Meta.
  if (!Number.isFinite(input.rate) || input.rate < 0) {
    return { ok: false, error: "Commission cannot be negative" };
  }
  const [campaign] = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, input.campaignId));
  if (!campaign) return { ok: false, error: `Unknown campaign "${input.campaignId}"` };

  await db
    .insert(schema.campaignCommissions)
    .values({
      campaignId: input.campaignId,
      fromDate: input.fromDate,
      rate: input.rate,
      setBy: user.id,
    })
    .onConflictDoUpdate({
      target: [schema.campaignCommissions.campaignId, schema.campaignCommissions.fromDate],
      set: { rate: input.rate, setBy: user.id },
    });

  await audit(
    "portal.commission.set",
    `${input.campaignId} from ${input.fromDate}: ${input.rate}%`,
  );
  return { ok: true };
}

/**
 * Drop one period.
 *
 * Deleting the earliest one does not leave its dates un-marked-up: the next period becomes the
 * earliest and `rateOn()` extends it backwards. Deleting the only period falls the campaign back to
 * its brand default.
 */
export async function removeCampaignCommission(input: {
  campaignId: string;
  fromDate: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const removed = await db
    .delete(schema.campaignCommissions)
    .where(
      and(
        eq(schema.campaignCommissions.campaignId, input.campaignId),
        eq(schema.campaignCommissions.fromDate, input.fromDate),
      ),
    )
    .returning({ rate: schema.campaignCommissions.rate });
  if (removed.length === 0) return { ok: false, error: "No rate set from that date" };

  await audit(
    "portal.commission.delete",
    `${input.campaignId} from ${input.fromDate} (was ${removed[0].rate}%)`,
  );
  return { ok: true };
}

// ── Portal users and access ────────────────────────────────────────────────────────────────────

export type PortalGrantScope = "brand" | "campaign";
export type PortalUserStatus = "pending" | "approved" | "rejected";

export interface PortalGrantView {
  id: string;
  scope: PortalGrantScope;
  targetId: string;
  /** Brand name, or a campaign's client-facing alias. Null when the target no longer exists. */
  targetName: string | null;
  createdAt: string;
}

export interface PortalUserView {
  id: string;
  email: string;
  name: string | null;
  status: string;
  grants: PortalGrantView[];
  invitedByEmail: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

/**
 * Every portal login with its grants named.
 *
 * Grants are resolved to names rather than left as opaque ids because `target_id` has no FK: a
 * grant can outlive its target, and an access list that shows a bare UUID hides exactly the rows an
 * operator needs to clean up. A campaign is shown by its alias — the internal name is what the
 * portal exists to keep hidden, so it is not the label to reach for here either.
 */
export async function fetchPortalUsers(): Promise<PortalUserView[]> {
  await requireAdmin();
  const [userRows, grantRows, brandRows, staffRows] = await Promise.all([
    db.select().from(schema.portalUsers),
    db.select().from(schema.portalGrants),
    db.select({ id: schema.brands.id, name: schema.brands.name }).from(schema.brands),
    db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users),
  ]);

  const campaignTargets = [
    ...new Set(grantRows.filter((g) => g.scope === "campaign").map((g) => g.targetId)),
  ];
  const aliasRows =
    campaignTargets.length === 0
      ? []
      : await db
          .select({
            campaignId: schema.portalCampaigns.campaignId,
            alias: schema.portalCampaigns.alias,
          })
          .from(schema.portalCampaigns)
          .where(inArray(schema.portalCampaigns.campaignId, campaignTargets));

  const brandName = new Map(brandRows.map((b) => [b.id, b.name]));
  const aliasName = new Map(aliasRows.filter((a) => a.alias).map((a) => [a.campaignId, a.alias]));
  const staffEmail = new Map(staffRows.map((u) => [u.id, u.email]));

  const grantsByUser = new Map<string, PortalGrantView[]>();
  for (const g of grantRows) {
    const scope: PortalGrantScope = g.scope === "campaign" ? "campaign" : "brand";
    const view: PortalGrantView = {
      id: g.id,
      scope,
      targetId: g.targetId,
      targetName:
        (scope === "brand" ? brandName.get(g.targetId) : aliasName.get(g.targetId)) ?? null,
      createdAt: g.createdAt.toISOString(),
    };
    const list = grantsByUser.get(g.portalUserId);
    if (list) list.push(view);
    else grantsByUser.set(g.portalUserId, [view]);
  }

  return userRows
    .map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      status: u.status,
      grants: (grantsByUser.get(u.id) ?? []).sort(
        (a, b) =>
          a.scope.localeCompare(b.scope) || (a.targetName ?? "").localeCompare(b.targetName ?? ""),
      ),
      invitedByEmail: u.invitedBy ? (staffEmail.get(u.invitedBy) ?? null) : null,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * Create a portal login.
 *
 * Invitation is the ONLY way one comes into existence — the portal transport refuses an email it
 * does not already know rather than provisioning it, so this function is the whole front door. The
 * row starts `pending`, which grants nothing at all, not even a read.
 */
export async function createPortalUser(input: {
  email: string;
  name?: string | null;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  const admin = await requireAdmin();
  // The transport lowercases the asserted address before looking it up, so a mixed-case row here
  // would simply never match and would read as "invited, but cannot get in".
  const email = input.email.trim().toLowerCase();
  if (!email) return { ok: false, error: "Email is required" };

  const [existing] = await db
    .select({ id: schema.portalUsers.id })
    .from(schema.portalUsers)
    .where(eq(schema.portalUsers.email, email));
  if (existing) return { ok: false, error: `${email} already has a portal account` };

  const id = randomUUID();
  await db.insert(schema.portalUsers).values({
    id,
    email,
    name: input.name?.trim() || null,
    status: "pending",
    invitedBy: admin.id,
  });
  await audit("portal.user.invite", email);
  return { ok: true, id };
}

export async function updatePortalUserStatus(input: {
  id: string;
  status: PortalUserStatus;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const [existing] = await db
    .select({ email: schema.portalUsers.email })
    .from(schema.portalUsers)
    .where(eq(schema.portalUsers.id, input.id));
  if (!existing) return { ok: false, error: "Portal user not found" };

  await db
    .update(schema.portalUsers)
    .set({ status: input.status })
    .where(eq(schema.portalUsers.id, input.id));
  await audit("portal.user.status", `${existing.email} -> ${input.status}`);
  return { ok: true };
}

/** Delete a portal login. Its grants go with it — `portal_grants.portal_user_id` cascades. */
export async function removePortalUser(input: {
  id: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const [existing] = await db
    .select({ email: schema.portalUsers.email })
    .from(schema.portalUsers)
    .where(eq(schema.portalUsers.id, input.id));
  if (!existing) return { ok: false, error: "Portal user not found" };

  await db.delete(schema.portalUsers).where(eq(schema.portalUsers.id, input.id));
  await audit("portal.user.delete", existing.email);
  return { ok: true };
}

/**
 * Give a portal user a brand or a single campaign.
 *
 * Idempotent: `portal_grants_unique` already forbids a duplicate, so re-granting is a no-op rather
 * than an error the operator has to read. The target is checked because `target_id` has no FK and a
 * grant for something that does not exist is silently ignored when the scope resolves — the operator
 * would be told access was given and the client would still see nothing.
 */
export async function addPortalGrant(input: {
  portalUserId: string;
  scope: PortalGrantScope;
  targetId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const admin = await requireAdmin();
  const [user] = await db
    .select({ email: schema.portalUsers.email })
    .from(schema.portalUsers)
    .where(eq(schema.portalUsers.id, input.portalUserId));
  if (!user) return { ok: false, error: "Portal user not found" };

  if (input.scope === "brand") {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(eq(schema.brands.id, input.targetId));
    if (!brand) return { ok: false, error: "Brand not found" };
  } else {
    const [campaign] = await db
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, input.targetId));
    if (!campaign) return { ok: false, error: `Unknown campaign "${input.targetId}"` };
  }

  await db
    .insert(schema.portalGrants)
    .values({
      id: randomUUID(),
      portalUserId: input.portalUserId,
      scope: input.scope,
      targetId: input.targetId,
      grantedBy: admin.id,
    })
    .onConflictDoNothing();

  await audit("portal.access.grant", `${user.email}: ${input.scope} ${input.targetId}`);
  return { ok: true };
}

export async function removePortalGrant(input: {
  id: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const removed = await db
    .delete(schema.portalGrants)
    .where(eq(schema.portalGrants.id, input.id))
    .returning({
      portalUserId: schema.portalGrants.portalUserId,
      scope: schema.portalGrants.scope,
      targetId: schema.portalGrants.targetId,
    });
  if (removed.length === 0) return { ok: false, error: "Grant not found" };

  const [user] = await db
    .select({ email: schema.portalUsers.email })
    .from(schema.portalUsers)
    .where(eq(schema.portalUsers.id, removed[0].portalUserId));
  await audit(
    "portal.access.revoke",
    `${user?.email ?? removed[0].portalUserId}: ${removed[0].scope} ${removed[0].targetId}`,
  );
  return { ok: true };
}
