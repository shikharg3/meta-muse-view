import { inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { effectiveAccountIds } from "@/sync/jobs/clients";
import { brandTitles } from "@/notion/parse";
import { attributeCampaign, brandVocab, type BrandVocab } from "@/lib/attribution";

/**
 * How much of a contested account belongs to one client.
 *
 * An ad account reused for a different client over time is referenced by BOTH clients in Notion, so
 * account-based attribution alone shows each client the other's campaigns (e.g. acrpoker.eu picking
 * up SweatBet's spend). On such accounts we split by campaign name; everywhere else nothing changes.
 */
export interface ClientCampaignScope {
  /** This client's accounts that another current client also claims. */
  contestedAccountIds: string[];
  /** Campaigns on those accounts that attribute to a DIFFERENT client. */
  excludedCampaignIds: string[];
  /** Accounts with at least one excluded campaign: their totals MUST come from campaign-level rows,
   *  since account-level rows can't be split. Other accounts keep the cheaper account-level path. */
  splitAccountIds: string[];
  /** True when nothing is excluded — callers can take their original fast path. */
  clean: boolean;
}

const EMPTY: ClientCampaignScope = {
  contestedAccountIds: [],
  excludedCampaignIds: [],
  splitAccountIds: [],
  clean: true,
};

/**
 * Resolve which campaigns on `accountIds` do NOT belong to `clientId`. A campaign whose name matches
 * no contender (or matches several equally) is left in place, so ambiguity degrades to today's
 * behaviour instead of silently dropping spend.
 */
export async function clientCampaignScope(
  clientId: string,
  accountIds: string[],
): Promise<ClientCampaignScope> {
  if (accountIds.length === 0) return EMPTY;
  const clients = await db.select().from(schema.clients).where(isNull(schema.clients.removedAt));

  // account -> every current client claiming it
  const claims = new Map<string, string[]>();
  for (const c of clients) {
    for (const aid of effectiveAccountIds(c)) {
      const list = claims.get(aid);
      if (list) list.push(c.id);
      else claims.set(aid, [c.id]);
    }
  }
  const contestedAccountIds = accountIds.filter((aid) => (claims.get(aid)?.length ?? 0) > 1);
  if (contestedAccountIds.length === 0) return EMPTY;

  const vocabById = new Map<string, BrandVocab>(
    clients.map((c) => [c.id, brandVocab(c.id, c.name, brandTitles(c.raw))]),
  );
  const campaigns = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      accountId: schema.campaigns.accountId,
    })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.accountId, contestedAccountIds));

  const excludedCampaignIds: string[] = [];
  const splitAccounts = new Set<string>();
  for (const cp of campaigns) {
    const contenders = (claims.get(cp.accountId) ?? [])
      .map((id) => vocabById.get(id))
      .filter((v): v is BrandVocab => v !== undefined);
    const owner = attributeCampaign(cp.name, contenders);
    if (owner !== null && owner !== clientId) {
      excludedCampaignIds.push(cp.id);
      splitAccounts.add(cp.accountId);
    }
  }
  return {
    contestedAccountIds,
    excludedCampaignIds,
    splitAccountIds: [...splitAccounts],
    clean: excludedCampaignIds.length === 0,
  };
}

/**
 * The campaigns on `accountIds` that belong to this client, or null when nothing is contested (no
 * restriction needed). Shaped as a WHITELIST so callers can hand it straight to the existing
 * `campaignIds` scoping that reports and ad-set queries already honour for every dimension.
 */
export async function ownedCampaignIds(
  clientId: string,
  accountIds: string[],
): Promise<string[] | null> {
  const scope = await clientCampaignScope(clientId, accountIds);
  if (scope.clean) return null;
  const excluded = new Set(scope.excludedCampaignIds);
  const rows = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.accountId, accountIds));
  return rows.map((r) => r.id).filter((id) => !excluded.has(id));
}
