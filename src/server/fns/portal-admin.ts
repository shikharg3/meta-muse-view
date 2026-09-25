import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { addDays } from "@/lib/range";
import { LIVE_STATUSES } from "@/notion/parse";
import {
  brandAccountIds,
  clientProjects,
  coveredProjects,
  projectOfAccount,
  projectSelection,
} from "@/portal/brand-accounts";
import { PORTAL_DEFAULT_COMMISSION } from "@/portal/markup";
import { clientTokens, reviewName, type NameFlag } from "@/portal/name-review";
import { effectiveAccountIds } from "@/sync/jobs/clients";
import { audit, requireAdmin } from "./auth";
import { loadCampaignOwnership, ownedCampaignIds } from "./campaign-attribution";

/**
 * The staff side of the client portal: what a brand is, what it is charged, and who may see it.
 *
 * Everything the portal shows a client is curated here and nowhere else — a brand's projects decide
 * its ad accounts, a user without a grant sees nothing, and the commission history is what turns
 * the agency's raw spend into the client-facing figure. Campaign names default to Meta's own, so
 * this module's job there is to flag the ones that should not be shown as-is. None of it is
 * reachable from the portal itself: `requireAdmin()` opens every function, and the ops that wrap
 * them are named so that `src/server/api/http.ts` cannot route a client token to them.
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

/**
 * One Notion project a brand covers, with its per-project overrides — the admin console calls a
 * project a "brand" and a brand a "client".
 */
export interface BrandProjectView {
  pageId: string;
  title: string;
  status: string | null;
  live: boolean;
  /**
   * Campaigns that count under this project for this brand: those on its accounts, owned by the
   * brand's client, whose account no NEWER project of the brand also lists (`projectOfAccount`).
   */
  campaignIds: string[];
  /** Accounts this project lists that count under a newer project instead, so its settings lose. */
  sharedAccountIds: string[];
  /** Overrides; null inherits the brand's own value. */
  pageName: string | null;
  pageAvatarUrl: string | null;
  commission: number | null;
}

export interface BrandAdminView {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  /** The default page name ad previews show for this brand's projects; null = the brand name. */
  pageName: string | null;
  /** The default profile photo, a public https URL; null = initials. */
  pageAvatarUrl: string | null;
  /** Never null: a row created before the default was stored reads as `PORTAL_DEFAULT_COMMISSION`. */
  defaultCommission: number;
  /** Resolved on read from the project selection — not a stored mapping. */
  accountIds: string[];
  /** `null` = follows the client, including engagements it has not won yet. */
  projectIds: string[] | null;
  /** The projects this brand covers, in board order (newest first). */
  projects: BrandProjectView[];
  /** Projects on the client's Notion board in total. */
  projectCount: number;
  /** How many of those this brand covers. Equal to `projectCount` when it follows the client. */
  selectedProjectCount: number;
  /** Campaigns this brand's client owns on those accounts. */
  campaignCount: number;
  /** How many of those a client can see: every one not hidden (names default to Meta's own). */
  visibleCampaignCount: number;
  createdAt: string;
}

/**
 * Every brand, with the accounts its project selection resolves to and the counts that explain it.
 *
 * Accounts and project attribution are DERIVED here, exactly as `portalScope()` derives them,
 * rather than read back from a stored mapping — that is the point of `brands.project_ids`, and
 * computing it a second way here would let the admin screen and the portal disagree about what a
 * client can see or what rate a campaign is marked up at.
 *
 * The campaign counts go through `ownedCampaignIds()` per brand rather than a cheap
 * `accounts ⋈ campaigns` join: a recycled account is claimed by two clients, and the join would
 * credit each of them with the other's campaigns. Brands are a table of tens of rows, so the
 * per-brand round trip is affordable.
 */
export async function fetchBrands(): Promise<BrandAdminView[]> {
  await requireAdmin();
  const [brandRows, clientRows, overrideRows, hiddenRows, settingsRows] = await Promise.all([
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
      .select({ campaignId: schema.portalCampaigns.campaignId })
      .from(schema.portalCampaigns)
      .where(eq(schema.portalCampaigns.hidden, true)),
    db.select().from(schema.portalProjectSettings),
  ]);
  if (brandRows.length === 0) return [];

  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const settingsOf = new Map(settingsRows.map((s) => [s.pageId, s]));
  const hidden = new Set(hiddenRows.map((r) => r.campaignId));

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

  const views = await Promise.all(
    resolved.map(async ({ brand: b, client, accountIds }): Promise<BrandAdminView> => {
      const owned = accountIds.length === 0 ? [] : await ownedCampaignIds(b.clientId, accountIds);
      const ownedSet = owned === null ? null : new Set(owned);
      const isOwned = (id: string) => ownedSet === null || ownedSet.has(id);
      const ids = accountIds.flatMap((a) => campaignsByAccount.get(a) ?? []).filter(isOwned);

      const all = clientProjects(client?.raw);
      const selection = projectSelection(b.projectIds);
      const covered = coveredProjects(b.projectIds, client?.raw);
      const projectOfAcct = projectOfAccount(covered, accountIds);
      const usable = new Set(accountIds);

      const projects = covered.map((p): BrandProjectView => {
        const listed = [...new Set(p.accountIds.filter((a) => usable.has(a)))];
        const mine = listed.filter((a) => projectOfAcct.get(a) === p.pageId);
        const s = settingsOf.get(p.pageId);
        return {
          pageId: p.pageId,
          title: p.title,
          status: p.status,
          live: p.status !== null && LIVE_STATUSES.includes(p.status),
          campaignIds: mine.flatMap((a) => campaignsByAccount.get(a) ?? []).filter(isOwned),
          sharedAccountIds: listed.filter((a) => projectOfAcct.get(a) !== p.pageId).sort(),
          pageName: s?.pageName ?? null,
          pageAvatarUrl: s?.pageAvatarUrl ?? null,
          commission: s?.commission ?? null,
        };
      });

      return {
        id: b.id,
        clientId: b.clientId,
        clientName: client?.name ?? b.clientId,
        name: b.name,
        pageName: b.pageName,
        pageAvatarUrl: b.pageAvatarUrl,
        defaultCommission: b.defaultCommission ?? PORTAL_DEFAULT_COMMISSION,
        accountIds,
        projectIds: selection,
        projects,
        projectCount: all.length,
        selectedProjectCount: covered.length,
        campaignCount: ids.length,
        visibleCampaignCount: ids.filter((id) => !hidden.has(id)).length,
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
  /**
   * Client-facing name. No longer typed in by an operator: absent on create means the client's
   * own name (`clients.name`), absent on update means unchanged.
   */
  name?: string | null;
  /**
   * Markup for campaigns whose project and own history set none. Absent on create means
   * `PORTAL_DEFAULT_COMMISSION`, stored so the screen shows the real number; absent on update means
   * unchanged; `null` resets it to the default.
   */
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
  /**
   * The ad-preview identity: a page name and a profile photo URL. Like `projectIds`, absent means
   * "leave it alone" — a caller that predates these fields must not wipe them — while `null` or a
   * blank string clears them.
   */
  pageName?: string | null;
  pageAvatarUrl?: string | null;
}

/** Facebook's own limit on a page name, so a preview never shows a name Meta would refuse. */
const PAGE_NAME_MAX = 75;

type PageColumns = { pageName?: string | null; pageAvatarUrl?: string | null };

/**
 * Validate a brand's ad-preview identity and project it onto the columns a save should touch.
 *
 * Only keys the caller SENT appear in `fields` — that is what stops an absent key from writing
 * null over a stored page name. The photo must be https: the portal is served over TLS and draws it
 * in an `<img>`, so an http URL would be blocked as mixed content and show up, silently, as a
 * broken avatar on a client's screen.
 */
export function pageFields(
  input: Pick<UpsertBrandInput, "pageName" | "pageAvatarUrl">,
): { fields: PageColumns } | { error: string } {
  const fields: PageColumns = {};
  if (input.pageName !== undefined) {
    const pageName = input.pageName?.trim() || null;
    if (pageName && pageName.length > PAGE_NAME_MAX) {
      return { error: `Page name must be ${PAGE_NAME_MAX} characters or fewer` };
    }
    fields.pageName = pageName;
  }
  if (input.pageAvatarUrl !== undefined) {
    const url = input.pageAvatarUrl?.trim() || null;
    if (url) {
      let https = false;
      try {
        https = new URL(url).protocol === "https:";
      } catch {
        // Not a URL at all — refused below with the same sentence.
      }
      if (!https) return { error: "Profile photo must be an https:// image URL" };
    }
    fields.pageAvatarUrl = url;
  }
  return { fields };
}

/**
 * Create or update a brand.
 *
 * `client_id` is `ON DELETE RESTRICT`, so an unknown id would surface as a raw constraint violation;
 * it is checked first to answer with a sentence instead. A negative default commission is refused
 * because it would quietly *discount* the client below cost.
 */
export async function upsertBrand(
  input: UpsertBrandInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  await requireAdmin();
  const typedName = input.name?.trim() || null;
  if (
    input.defaultCommission != null &&
    !(Number.isFinite(input.defaultCommission) && input.defaultCommission >= 0)
  ) {
    return { ok: false, error: "Default commission cannot be negative" };
  }
  const page = pageFields(input);
  if ("error" in page) return { ok: false, error: page.error };

  const [client] = await db
    .select({ id: schema.clients.id, name: schema.clients.name })
    .from(schema.clients)
    .where(eq(schema.clients.id, input.clientId));
  if (!client) return { ok: false, error: `Unknown client "${input.clientId}"` };

  // Distinguished from `null` on purpose: `null` means "follow the client" and is a real setting,
  // while an absent key on an update means "do not touch the selection I already have".
  const selection = input.projectIds === undefined ? undefined : (input.projectIds ?? null);

  if (input.id) {
    const [existing] = await db
      .select({ id: schema.brands.id, name: schema.brands.name })
      .from(schema.brands)
      .where(eq(schema.brands.id, input.id));
    if (!existing) return { ok: false, error: "Brand not found" };

    const fields: Partial<typeof schema.brands.$inferInsert> = {
      clientId: input.clientId,
      ...page.fields,
    };
    if (typedName) fields.name = typedName;
    if (input.defaultCommission !== undefined) {
      fields.defaultCommission = input.defaultCommission ?? PORTAL_DEFAULT_COMMISSION;
    }
    if (selection !== undefined) fields.projectIds = selection;
    await db.update(schema.brands).set(fields).where(eq(schema.brands.id, input.id));
    await audit("portal.brand.update", `${typedName ?? existing.name} (${input.id})`);
    return { ok: true, id: input.id };
  }

  const id = randomUUID();
  const name = typedName ?? client.name;
  await db.insert(schema.brands).values({
    id,
    clientId: input.clientId,
    name,
    defaultCommission: input.defaultCommission ?? PORTAL_DEFAULT_COMMISSION,
    projectIds: selection ?? null,
    ...page.fields,
  });
  await audit("portal.brand.create", `${name} (${id})`);
  return { ok: true, id };
}

export interface SaveProjectSettingsInput {
  /** The Notion page id of the project (a board row). */
  pageId: string;
  /** Absent = unchanged, null or blank = inherit the brand's value again. */
  pageName?: string | null;
  pageAvatarUrl?: string | null;
  commission?: number | null;
}

/**
 * Set a project's own ad page and/or commission, overriding the brand's defaults for the campaigns
 * that count under it (see `projectOfAccount`).
 *
 * Only keys the caller sent are touched, as for brands. The project must be a row on some client's
 * board — found through `clients.raw` — which is also where the row's client id comes from, so a
 * settings row can never be filed under the wrong client. A row whose every override is cleared is
 * kept rather than deleted: it is inert (all nulls inherit) and deleting would race a concurrent save.
 */
export async function upsertProjectSettings(
  input: SaveProjectSettingsInput,
): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const page = pageFields(input);
  if ("error" in page) return { ok: false, error: page.error };
  if (input.commission != null && !(Number.isFinite(input.commission) && input.commission >= 0)) {
    return { ok: false, error: "Commission cannot be negative" };
  }

  const clientRows = await db
    .select({ id: schema.clients.id, raw: schema.clients.raw })
    .from(schema.clients)
    .where(sql`${schema.clients.raw} @> ${JSON.stringify([{ pageId: input.pageId }])}::jsonb`);
  const owner = clientRows.find((c) =>
    clientProjects(c.raw).some((p) => p.pageId === input.pageId),
  );
  if (!owner) return { ok: false, error: "That brand is not on any client's Notion board" };
  const title =
    clientProjects(owner.raw).find((p) => p.pageId === input.pageId)?.title ?? input.pageId;

  const fields: Partial<typeof schema.portalProjectSettings.$inferInsert> = { ...page.fields };
  if (input.commission !== undefined) fields.commission = input.commission;

  await db
    .insert(schema.portalProjectSettings)
    .values({ pageId: input.pageId, clientId: owner.id, ...fields })
    .onConflictDoUpdate({
      target: schema.portalProjectSettings.pageId,
      set: { ...fields, clientId: owner.id, updatedAt: new Date() },
    });
  await audit("portal.project.update", `${title} (${input.pageId})`);
  return { ok: true };
}

/**
 * Delete a brand, its account mapping and every grant that pointed at it — whole-brand grants and
 * the project grants held through it.
 *
 * `brand_accounts` cascades, but `portal_grants.target_id` and `parent_id` deliberately carry no FK
 * (they are polymorphic), so nothing in the database cleans those up. A leftover grant is not
 * merely untidy: it keeps naming a target the access list can no longer resolve, and it becomes
 * live access again the moment that id exists once more — a restored row or a re-imported export
 * is enough.
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
    .where(
      or(
        and(eq(schema.portalGrants.scope, "brand"), eq(schema.portalGrants.targetId, input.id)),
        and(eq(schema.portalGrants.scope, "project"), eq(schema.portalGrants.parentId, input.id)),
      ),
    )
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

/** One campaign as the renamer screen needs it: what a client sees, where it came from, and why it might need a look. */
export interface CampaignPresentationView {
  campaignId: string;
  /** Meta's own campaign name — the default client-facing label. */
  metaName: string;
  accountId: string;
  /** The operator's override, or null when the Meta name is being used. */
  alias: string | null;
  /** What a client actually sees. */
  effectiveName: string;
  source: "meta" | "custom";
  hidden: boolean;
  /** Empty for a name that is fine as-is. See `src/portal/name-review.ts`. */
  flags: NameFlag[];
  /** The other client's name when `mentions-other-client` fired, so the row can say who. */
  mentionsClient: string | null;
  updatedAt: string | null;
}

/**
 * Every campaign with the name a client would see, for the bulk renamer.
 *
 * Driven by `campaigns`, not by `portal_campaigns`: the default name is Meta's, so a campaign with
 * no override row is the NORMAL case and has to appear in this list — it is the thing most likely
 * to need renaming. The old version read the override table alone and therefore listed only the
 * campaigns already dealt with.
 *
 * Ownership comes from `loadCampaignOwnership()` rather than the account, because a shared account
 * is claimed by several clients and comparing a name against the wrong owner would flag a campaign
 * for naming its own client.
 */
export async function fetchCampaignPresentation(
  input: { campaignIds?: string[] } = {},
): Promise<CampaignPresentationView[]> {
  await requireAdmin();
  const ids = input.campaignIds;
  if (ids && ids.length === 0) return [];

  const [campaignRows, overrideRows, clientRows, ownership] = await Promise.all([
    db
      .select({
        id: schema.campaigns.id,
        name: schema.campaigns.name,
        accountId: schema.campaigns.accountId,
      })
      .from(schema.campaigns)
      .where(ids ? inArray(schema.campaigns.id, ids) : undefined),
    db
      .select({
        campaignId: schema.portalCampaigns.campaignId,
        alias: schema.portalCampaigns.alias,
        hidden: schema.portalCampaigns.hidden,
        updatedAt: schema.portalCampaigns.updatedAt,
      })
      .from(schema.portalCampaigns),
    db
      .select({ id: schema.clients.id, name: schema.clients.name })
      .from(schema.clients)
      .where(isNull(schema.clients.removedAt)),
    loadCampaignOwnership(),
  ]);

  const overrideBy = new Map(overrideRows.map((r) => [r.campaignId, r]));
  const tokens = clientTokens(clientRows);

  return campaignRows
    .map((c): CampaignPresentationView => {
      const row = overrideBy.get(c.id);
      const alias = row?.alias?.trim() || null;
      const review = reviewName(c.name, ownership.ownerOf(c), tokens);
      return {
        campaignId: c.id,
        metaName: c.name,
        accountId: c.accountId,
        alias,
        effectiveName: alias ?? c.name,
        source: alias ? "custom" : "meta",
        hidden: row?.hidden ?? false,
        // An override replaces the name, so the Meta name's problems stop being the client's
        // problem — except naming another client, which an operator should still be told about
        // because the Meta-side name is what the media buyer sees and it is still wrong there.
        flags: alias ? review.flags.filter((f) => f === "mentions-other-client") : review.flags,
        mentionsClient: review.mentionsClient,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      };
    })
    .sort(
      (a, b) => b.flags.length - a.flags.length || a.effectiveName.localeCompare(b.effectiveName),
    );
}

/**
 * Override a campaign's client-facing name, or hide it.
 *
 * `alias: null` clears the override and falls back to Meta's name — it no longer withdraws the
 * campaign, because the Meta name is the default. `hidden: true` is the only way to keep a
 * campaign out of the portal.
 *
 * The campaign id is checked against `campaigns` — the column has no FK, so a typo would otherwise
 * be stored as a row that can never match anything.
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

export interface BulkPresentationItem {
  campaignId: string;
  /** null clears the override and falls back to Meta's name. */
  alias: string | null;
  hidden: boolean;
}

/**
 * Apply a whole screen's worth of renames at once.
 *
 * The renamer lists every campaign of a brand, so saving row by row would be dozens of round trips
 * and could leave the screen half-applied if one failed. Everything goes in one transaction: either
 * the operator's edits all land or none do, and there is no state where some campaigns show a new
 * name and others the old one.
 *
 * Unknown ids are rejected up front rather than skipped. Silently dropping one would report success
 * for a rename that never happened, and the operator's next reload would show the old name with no
 * explanation.
 */
export async function bulkCampaignPresentation(input: {
  items: BulkPresentationItem[];
}): Promise<{ ok: boolean; error?: string; updated?: number }> {
  const user = await requireAdmin();
  const items = input.items;
  if (items.length === 0) return { ok: true, updated: 0 };

  const ids = [...new Set(items.map((i) => i.campaignId))];
  if (ids.length !== items.length) {
    return { ok: false, error: "The same campaign appears twice" };
  }

  const known = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.id, ids));
  if (known.length !== ids.length) {
    const found = new Set(known.map((k) => k.id));
    const missing = ids.filter((id) => !found.has(id));
    return {
      ok: false,
      error: `Unknown campaign${missing.length > 1 ? "s" : ""}: ${missing.slice(0, 3).join(", ")}`,
    };
  }

  const now = new Date();
  const rows = items.map((i) => ({
    campaignId: i.campaignId,
    alias: i.alias?.trim() || null,
    hidden: i.hidden,
    updatedBy: user.id,
    updatedAt: now,
  }));

  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
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
    }
  });

  const renamed = rows.filter((r) => r.alias !== null).length;
  const hiddenCount = rows.filter((r) => r.hidden).length;
  await audit(
    "portal.campaign.presentation.bulk",
    `${rows.length} campaigns: ${renamed} renamed, ${hiddenCount} hidden`,
  );
  return { ok: true, updated: rows.length };
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

export type PortalGrantScope = "brand" | "project" | "campaign";
export type PortalUserStatus = "pending" | "approved" | "rejected";

export interface PortalGrantView {
  id: string;
  scope: PortalGrantScope;
  /** A brand id, a Notion page id (project) or a campaign id. */
  targetId: string;
  /** For a project grant, the brand it is held through; null otherwise. */
  parentId: string | null;
  /**
   * Brand name, project title, or a campaign's client-facing name. Null when the target no longer
   * exists — including a project its brand no longer covers.
   */
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
    db
      .select({
        id: schema.brands.id,
        name: schema.brands.name,
        clientId: schema.brands.clientId,
        projectIds: schema.brands.projectIds,
      })
      .from(schema.brands),
    db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users),
  ]);

  const campaignTargets = [
    ...new Set(grantRows.filter((g) => g.scope === "campaign").map((g) => g.targetId)),
  ];
  const [aliasRows, campaignRows] =
    campaignTargets.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              campaignId: schema.portalCampaigns.campaignId,
              alias: schema.portalCampaigns.alias,
            })
            .from(schema.portalCampaigns)
            .where(inArray(schema.portalCampaigns.campaignId, campaignTargets)),
          db
            .select({ id: schema.campaigns.id, name: schema.campaigns.name })
            .from(schema.campaigns)
            .where(inArray(schema.campaigns.id, campaignTargets)),
        ]);

  // A project grant is named by its row title, read from the owning client's board through the
  // brand it is held by — and only while that brand still covers it, so a grant the scope would
  // ignore reads as dangling here too.
  const parentIds = new Set(
    grantRows.filter((g) => g.scope === "project" && g.parentId).map((g) => g.parentId),
  );
  const brandById = new Map(brandRows.map((b) => [b.id, b]));
  const ownerIds = [
    ...new Set(
      [...parentIds]
        .map((id) => brandById.get(id ?? "")?.clientId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const ownerRows =
    ownerIds.length === 0
      ? []
      : await db
          .select({ id: schema.clients.id, raw: schema.clients.raw })
          .from(schema.clients)
          .where(inArray(schema.clients.id, ownerIds));
  const rawOf = new Map(ownerRows.map((c) => [c.id, c.raw]));
  const projectTitle = (brandId: string | null, pageId: string): string | null => {
    const brand = brandById.get(brandId ?? "");
    if (!brand) return null;
    const p = coveredProjects(brand.projectIds, rawOf.get(brand.clientId)).find(
      (x) => x.pageId === pageId,
    );
    return p ? p.title || pageId : null;
  };

  const campaignName = new Map(campaignRows.map((c) => [c.id, c.name]));
  for (const a of aliasRows) if (a.alias) campaignName.set(a.campaignId, a.alias);
  const staffEmail = new Map(staffRows.map((u) => [u.id, u.email]));

  const grantsByUser = new Map<string, PortalGrantView[]>();
  for (const g of grantRows) {
    const scope: PortalGrantScope =
      g.scope === "campaign" ? "campaign" : g.scope === "project" ? "project" : "brand";
    const targetName =
      scope === "brand"
        ? brandById.get(g.targetId)?.name
        : scope === "project"
          ? projectTitle(g.parentId, g.targetId)
          : campaignName.get(g.targetId);
    const view: PortalGrantView = {
      id: g.id,
      scope,
      targetId: g.targetId,
      parentId: scope === "project" ? g.parentId : null,
      targetName: targetName ?? null,
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
 * Give a portal user a brand, one project within a brand, or a single campaign.
 *
 * Idempotent: `portal_grants_unique` already forbids a duplicate, so re-granting is a no-op rather
 * than an error the operator has to read. The target is checked because `target_id` has no FK and a
 * grant for something that does not exist is silently ignored when the scope resolves — the operator
 * would be told access was given and the client would still see nothing. For a project that means
 * the brand (`parentId`) must exist and currently cover the project.
 */
export async function addPortalGrant(input: {
  portalUserId: string;
  scope: PortalGrantScope;
  targetId: string;
  parentId?: string | null;
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
  } else if (input.scope === "project") {
    if (!input.parentId)
      return { ok: false, error: "A brand grant needs the client it belongs to" };
    const [brand] = await db
      .select({
        projectIds: schema.brands.projectIds,
        raw: schema.clients.raw,
      })
      .from(schema.brands)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.brands.clientId))
      .where(eq(schema.brands.id, input.parentId));
    if (!brand) return { ok: false, error: "Client not found" };
    if (!coveredProjects(brand.projectIds, brand.raw).some((p) => p.pageId === input.targetId)) {
      return { ok: false, error: "That brand is not one this client covers" };
    }
    // `portal_grants_unique` is (user, scope, target), so the same board row held through a second
    // client would be swallowed by `onConflictDoNothing` below and reported as granted. Say so.
    const [held] = await db
      .select({ parentId: schema.portalGrants.parentId })
      .from(schema.portalGrants)
      .where(
        and(
          eq(schema.portalGrants.portalUserId, input.portalUserId),
          eq(schema.portalGrants.scope, "project"),
          eq(schema.portalGrants.targetId, input.targetId),
        ),
      );
    if (held && held.parentId !== input.parentId) {
      return {
        ok: false,
        error: "This person already has that brand through another client. Revoke that first.",
      };
    }
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
      parentId: input.scope === "project" ? (input.parentId ?? null) : null,
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
