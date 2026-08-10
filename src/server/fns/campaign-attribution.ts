import { inArray, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { effectiveAccountIds } from "@/sync/jobs/clients";
import { brandTitles } from "@/notion/parse";
import { attributeCampaign, brandVocab, type BrandVocab } from "@/lib/attribution";

/**
 * How much of a shared account belongs to one client.
 *
 * An ad account reused for a different client over time is referenced by BOTH clients in Notion, so
 * account-based attribution alone shows each client the other's campaigns (e.g. acrpoker.eu picking
 * up SweatBet's spend). Ownership is therefore resolved per campaign, in priority order:
 *   1. a manual override (operator correction) — always wins,
 *   2. brand-name attribution, when the account is contested by several current clients,
 *   3. the account's single claimant.
 */
export interface ClientCampaignScope {
  /** This client's accounts that another current client also claims. */
  contestedAccountIds: string[];
  /** Campaigns on this client's accounts that belong to a DIFFERENT client. */
  excludedCampaignIds: string[];
  /** Accounts whose totals MUST come from campaign-level rows, because account-level rows can't be
   *  split. Other accounts keep the cheaper account-level path. */
  splitAccountIds: string[];
  /** Accounts included ONLY because an override moved one of their campaigns to this client. */
  extraAccountIds: string[];
  /** Campaigns on this client's accounts that no rule could assign, so they count for nobody.
   *  Surface these: every one is spend that belongs to somebody and needs an override. */
  unattributedCampaignIds: string[];
  /** True when nothing is excluded or added — callers can take their original fast path. */
  clean: boolean;
}

const EMPTY: ClientCampaignScope = {
  contestedAccountIds: [],
  excludedCampaignIds: [],
  splitAccountIds: [],
  extraAccountIds: [],
  unattributedCampaignIds: [],
  clean: true,
};

/**
 * Resolve which campaigns on (or moved into) `accountIds` belong to `clientId`.
 *
 * Ownership ladder, first match wins:
 *   1. a manual override (operator correction),
 *   2. brand-name attribution,
 *   3. the single client that designates the account as its Notion "Active Account ID" — the others
 *      merely list it under "Other ad accounts",
 *   4. nobody: the campaign is excluded from EVERY claimant.
 *
 * Step 4 used to leave unmatched campaigns in place, which double-counted them into every claiming
 * client: asking for one client's totals returned another's spend as well. Excluding them makes each
 * client's figure defensible; `unattributedCampaignIds` carries what was dropped so it can be
 * surfaced and resolved with an override instead of silently vanishing.
 */
export async function clientCampaignScope(
  clientId: string,
  accountIds: string[],
): Promise<ClientCampaignScope> {
  const [clients, overrideRows] = await Promise.all([
    db.select().from(schema.clients).where(isNull(schema.clients.removedAt)),
    db.select().from(schema.campaignClientOverrides),
  ]);
  const overrideByCampaign = new Map(overrideRows.map((o) => [o.campaignId, o.clientId]));

  // account -> every current client claiming it
  const claims = new Map<string, string[]>();
  // account -> the clients that designate it their ACTIVE account (not just an "other" account).
  // On a contested account this is the tiebreaker names cannot provide.
  const activeClaims = new Map<string, string[]>();
  for (const c of clients) {
    for (const aid of effectiveAccountIds(c)) {
      const list = claims.get(aid);
      if (list) list.push(c.id);
      else claims.set(aid, [c.id]);
    }
    for (const aid of (c.notionActiveAccountIds as string[] | null) ?? []) {
      const list = activeClaims.get(aid);
      if (list) list.push(c.id);
      else activeClaims.set(aid, [c.id]);
    }
  }
  const owned = new Set(accountIds);
  const contestedAccountIds = accountIds.filter((aid) => (claims.get(aid)?.length ?? 0) > 1);
  const movedInIds = overrideRows.filter((o) => o.clientId === clientId).map((o) => o.campaignId);
  const overriddenIds = [...overrideByCampaign.keys()];

  // Nothing contested and no override touches this client -> plain account attribution is correct.
  if (contestedAccountIds.length === 0 && overrideRows.length === 0) return EMPTY;

  // Campaigns worth examining: those on contested accounts, plus any campaign an override touches
  // (an override can move a campaign OUT of an uncontested account, or IN from a foreign one).
  const candidateConds = [
    ...(contestedAccountIds.length
      ? [inArray(schema.campaigns.accountId, contestedAccountIds)]
      : []),
    ...(overriddenIds.length ? [inArray(schema.campaigns.id, overriddenIds)] : []),
  ];
  if (candidateConds.length === 0) return EMPTY;
  const campaigns = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      accountId: schema.campaigns.accountId,
    })
    .from(schema.campaigns)
    .where(candidateConds.length === 1 ? candidateConds[0] : or(...candidateConds));

  const vocabById = new Map<string, BrandVocab>(
    clients.map((c) => [c.id, brandVocab(c.id, c.name, brandTitles(c.raw))]),
  );
  const ownerOf = (cp: { id: string; name: string; accountId: string }): string | null => {
    const override = overrideByCampaign.get(cp.id);
    if (override) return override;
    const claimants = claims.get(cp.accountId) ?? [];
    if (claimants.length <= 1) return claimants[0] ?? null;
    const byName = attributeCampaign(
      cp.name,
      claimants.map((id) => vocabById.get(id)).filter((v): v is BrandVocab => v !== undefined),
    );
    if (byName) return byName;
    // Names failed. If exactly one claimant designates this as its ACTIVE account and the rest only
    // list it under "Other ad accounts", that is the board saying whose account it really is.
    const active = (activeClaims.get(cp.accountId) ?? []).filter((id) => claimants.includes(id));
    return active.length === 1 ? active[0] : null;
  };

  const excluded = new Set<string>();
  const unattributed = new Set<string>();
  const splitAccounts = new Set<string>();
  const extraAccounts = new Set<string>();
  const movedIn = new Set(movedInIds);

  for (const cp of campaigns) {
    const owner = ownerOf(cp);
    if (owned.has(cp.accountId)) {
      // A campaign on one of this client's accounts: drop it unless this client owns it. An
      // unowned campaign (owner === null) is dropped from everyone rather than counted by everyone.
      if (owner !== clientId) {
        excluded.add(cp.id);
        splitAccounts.add(cp.accountId);
        if (owner === null) unattributed.add(cp.id);
      }
    } else if (movedIn.has(cp.id)) {
      // Moved in from an account this client does not own: pull the account in, campaign-level only.
      extraAccounts.add(cp.accountId);
      splitAccounts.add(cp.accountId);
    }
  }
  // On a pulled-in account, everything EXCEPT the moved-in campaigns must be excluded — needs its
  // own pass, since the account set is only known after the loop above.
  if (extraAccounts.size > 0) {
    const siblings = await db
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(inArray(schema.campaigns.accountId, [...extraAccounts]));
    for (const cp of siblings) if (!movedIn.has(cp.id)) excluded.add(cp.id);
  }

  return {
    contestedAccountIds,
    excludedCampaignIds: [...excluded],
    splitAccountIds: [...splitAccounts],
    extraAccountIds: [...extraAccounts],
    unattributedCampaignIds: [...unattributed],
    clean: excluded.size === 0 && extraAccounts.size === 0,
  };
}

/**
 * The campaigns that belong to this client across its own accounts plus any pulled in by an override,
 * or null when no restriction is needed. Shaped as a WHITELIST so callers can hand it straight to the
 * existing `campaignIds` scoping that reports and ad-set queries already honour for every dimension.
 */
export async function ownedCampaignIds(
  clientId: string,
  accountIds: string[],
): Promise<string[] | null> {
  const scope = await clientCampaignScope(clientId, accountIds);
  if (scope.clean) return null;
  const excluded = new Set(scope.excludedCampaignIds);
  const all = [...new Set([...accountIds, ...scope.extraAccountIds])];
  if (all.length === 0) return [];
  const rows = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.accountId, all));
  return rows.map((r) => r.id).filter((id) => !excluded.has(id));
}
