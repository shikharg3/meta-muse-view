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
  /** True when nothing is excluded or added — callers can take their original fast path. */
  clean: boolean;
}

const EMPTY: ClientCampaignScope = {
  contestedAccountIds: [],
  excludedCampaignIds: [],
  splitAccountIds: [],
  extraAccountIds: [],
  clean: true,
};

/**
 * Resolve which campaigns on (or moved into) `accountIds` belong to `clientId`. A campaign whose name
 * matches no contender — and has no override — is left in place, so ambiguity degrades to plain
 * account attribution instead of silently dropping spend.
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
  for (const c of clients) {
    for (const aid of effectiveAccountIds(c)) {
      const list = claims.get(aid);
      if (list) list.push(c.id);
      else claims.set(aid, [c.id]);
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
    return attributeCampaign(
      cp.name,
      claimants.map((id) => vocabById.get(id)).filter((v): v is BrandVocab => v !== undefined),
    );
  };

  const excluded = new Set<string>();
  const splitAccounts = new Set<string>();
  const extraAccounts = new Set<string>();
  const movedIn = new Set(movedInIds);

  for (const cp of campaigns) {
    const owner = ownerOf(cp);
    if (owned.has(cp.accountId)) {
      // A campaign on one of this client's accounts: drop it when it belongs to someone else.
      if (owner !== null && owner !== clientId) {
        excluded.add(cp.id);
        splitAccounts.add(cp.accountId);
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
