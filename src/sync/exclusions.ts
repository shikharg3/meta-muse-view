import { and, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db/client";

/**
 * Campaigns this warehouse must not contain, and the machinery that keeps them out.
 *
 * One product line — "KP" / KyloPeptides — was removed on the operator's instruction. It had to go
 * at the source rather than be hidden in the dashboard: Meta re-serves those campaigns on every
 * hourly sync, so a read-side filter is a lie that has to be re-told forever, and the server-side
 * CSV export (`getExportCsv`) would have kept carrying them anyway. Two overlapping mechanisms:
 *
 * 1. **Ingest refuses them.** `structure`, `insights`, `breakdowns` and `activities` drop rows whose
 *    campaign is excluded, so an excluded campaign never lands in a table at all.
 * 2. **A sweep deletes whatever slipped.** `purgeExcluded` runs at the end of every cycle: it clears
 *    rows written before this shipped, a campaign renamed INTO the pattern, and any row whose parent
 *    an ingest filter could not see (ad-level breakdown rows carry no campaign id, for instance).
 *
 * `sync_exclusions` remembers the ids, and ONLY the ids — the point of the exercise is that the
 * excluded names do not live in this database. Ids are also the sturdier key: Meta ids are stable,
 * names get edited.
 */

/** The campaign ids the operator named, seeded so the sweep works before anything is recorded. */
export const SEED_EXCLUDED_CAMPAIGN_IDS: readonly string[] = [
  "120247205288170160", // "KP"          — act_1721192725763150
  "120251195505790276", // "KP"          — act_1080144117882318
  "120253598743190184", // "KP - Sales"  — act_1044655374822783
  "120254142945300745", // "KP - Sales"  — act_839316619145104
];

/**
 * Names that mean "this is the excluded product line", matched against campaign, ad-set and ad names
 * at ingest so a NEW campaign for it is refused without anyone editing this file.
 *
 * Deliberately narrow: `kp` matches only as a standalone token, so `KPI` — a real word in real
 * campaign names — is never swept up. `\b` is avoided because the same intent must also be expressed
 * in Postgres below, and POSIX has no `\b`; explicit classes keep the two spellings comparable.
 */
export const EXCLUDED_NAME = /kylo|peptide|(^|[^a-z0-9])kp([^a-z0-9]|$)/i;

/**
 * `EXCLUDED_NAME` in Postgres ARE syntax, for the set-based sweep. Change the two together.
 *
 * A divergence is not silent: ingest would admit a row the sweep then deletes at the end of the
 * cycle, or the sweep would leave a row that ingest refuses to refresh — both visible, neither quiet.
 */
export const EXCLUDED_NAME_SQL = "(kylo|peptide|(^|[^a-zA-Z0-9])[Kk][Pp]([^a-zA-Z0-9]|$))";

export type ExclusionKind = "campaign" | "adset" | "ad" | "account";

/** Every excluded id, by kind. String keys, read in loops — a plain lookup, not a Map. */
export type ExclusionMap = Record<string, ExclusionKind>;

export interface PurgeReport {
  campaigns: number;
  adSets: number;
  ads: number;
  adCreatives: number;
  insightRows: number;
  breakdownRows: number;
  activities: number;
  overrides: number;
  registered: number;
  /** Accounts whose every campaign was excluded: their account-level totals were that spend only. */
  emptiedAccounts: string[];
}

export const matchesExcludedName = (name: string | null | undefined): boolean =>
  typeof name === "string" && EXCLUDED_NAME.test(name);

// One database read per cycle rather than per row: the ingest filters ask for this lookup inside
// loops over thousands of Meta rows. `registerExclusions` folds new ids in, so a campaign refused
// during this run is already known when its insights arrive later in the same run.
const CACHE_MS = 60_000;
let cache: { at: number; ids: ExclusionMap } | null = null;

/** Every excluded id. Cheap to call; pass `fresh` when correctness beats the memo. */
export async function loadExclusions(fresh = false): Promise<ExclusionMap> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.ids;
  const rows = await db
    .select({ id: schema.syncExclusions.id, kind: schema.syncExclusions.kind })
    .from(schema.syncExclusions);
  const ids: ExclusionMap = {};
  for (const id of SEED_EXCLUDED_CAMPAIGN_IDS) ids[id] = "campaign";
  for (const row of rows) ids[row.id] = row.kind as ExclusionKind;
  cache = { at: Date.now(), ids };
  return ids;
}

/** Drop the memo — for tests, and after a purge changes the set. */
export function forgetExclusions(): void {
  cache = null;
}

/** Record ids as excluded. Idempotent, and the in-process memo is updated with them. */
export async function registerExclusions(
  entries: { id: string; kind: ExclusionKind; reason: string }[],
): Promise<number> {
  const rows = entries.filter((entry) => entry.id);
  if (!rows.length) return 0;
  await db
    .insert(schema.syncExclusions)
    .values(rows.map((r) => ({ id: r.id, kind: r.kind, reason: r.reason })))
    .onConflictDoNothing();
  if (cache) for (const r of rows) cache.ids[r.id] = r.kind;
  return rows.length;
}

/** Ids of one kind, for the sweep's own bookkeeping. */
export const excludedIdsOfKind = (known: ExclusionMap, kind: ExclusionKind): string[] =>
  Object.keys(known).filter((id) => known[id] === kind);

/**
 * True when this account's figures are nothing but excluded spend, so its ACCOUNT-level rows must go
 * too. Meta computes account totals itself — they carry no campaign id and cannot be filtered row by
 * row — and leaving them would show an ad account spending $88 with no campaign underneath it.
 *
 * The check is deliberately two-part (recorded AND no campaign of its own left) so that reusing one
 * of these ad accounts for real work restores its totals on the next cycle, with no edit here.
 */
export async function accountIsExcludedOnly(
  accountId: string,
  known: ExclusionMap,
): Promise<boolean> {
  if (known[accountId] !== "account") return false;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.accountId, accountId));
  return Number(row?.n ?? 0) === 0;
}

async function countRows(
  table: typeof schema.insightsDaily | typeof schema.insightsBreakdownDaily,
  where: SQL,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(where);
  return Number(row?.n ?? 0);
}

/**
 * Delete every trace of the excluded campaigns, and record their ids so ingest keeps refusing them.
 *
 * Order matters, and it is why this is code rather than a one-off migration: an insight row is keyed
 * by `(level, entity_id, date)` with no campaign column, so the ad sets and ads must be resolved
 * from the structure tables BEFORE those tables are emptied. Deleting the parents first orphans
 * hundreds of rows that nothing could ever identify again.
 */
export async function purgeExcluded(): Promise<PurgeReport> {
  const known = await loadExclusions(true);
  const recorded = excludedIdsOfKind(known, "campaign");

  // Campaigns: the recorded ids, plus anything resident whose name matches (a rename INTO the set).
  const campaignRows = await db
    .select({ id: schema.campaigns.id, accountId: schema.campaigns.accountId })
    .from(schema.campaigns)
    .where(
      sql`${schema.campaigns.id} = ANY(${recorded}) OR ${schema.campaigns.name} ~* ${EXCLUDED_NAME_SQL}`,
    );
  const campaignIds = [...new Set([...recorded, ...campaignRows.map((r) => r.id)])];

  // Ad sets and ads: by parentage AND by their own names — an ad set called "KyloPeptides" under a
  // differently-named campaign is exactly what parentage alone misses.
  const adSetRows = await db
    .select({ id: schema.adSets.id })
    .from(schema.adSets)
    .where(
      sql`${schema.adSets.campaignId} = ANY(${campaignIds}) OR ${schema.adSets.name} ~* ${EXCLUDED_NAME_SQL}`,
    );
  const adSetIds = [
    ...new Set([...adSetRows.map((r) => r.id), ...excludedIdsOfKind(known, "adset")]),
  ];

  const adRows = await db
    .select({ id: schema.ads.id, creativeId: schema.ads.creativeId })
    .from(schema.ads)
    .where(
      sql`${schema.ads.adSetId} = ANY(${adSetIds}) OR ${schema.ads.name} ~* ${EXCLUDED_NAME_SQL}`,
    );
  const adIds = [...new Set([...adRows.map((r) => r.id), ...excludedIdsOfKind(known, "ad")])];

  // Accounts whose entire campaign list is excluded — see `accountIsExcludedOnly`. Accounts already
  // recorded are re-checked rather than trusted: once a real campaign appears on one of them, its
  // account-level rows stop being swept and start being kept again, with no edit to this file.
  const emptiedAccounts: string[] = [];
  const accountCandidates = new Set([
    ...campaignRows.map((r) => r.accountId),
    ...excludedIdsOfKind(known, "account"),
  ]);
  for (const accountId of accountCandidates) {
    const [survivor] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.accountId, accountId),
          notInArray(schema.campaigns.id, campaignIds),
        ),
      );
    if (Number(survivor?.n ?? 0) === 0) emptiedAccounts.push(accountId);
  }

  // Creatives are shared objects: only drop the ones no surviving ad still points at.
  const candidates = [
    ...new Set(adRows.map((r) => r.creativeId).filter((id): id is string => Boolean(id))),
  ];
  const stillUsed = candidates.length
    ? await db
        .select({ id: schema.ads.creativeId })
        .from(schema.ads)
        .where(
          and(
            inArray(schema.ads.creativeId, candidates),
            notInArray(schema.ads.id, adIds.length ? adIds : [""]),
          ),
        )
    : [];
  const keep = new Set(stillUsed.map((r) => r.id).filter((id): id is string => Boolean(id)));
  const creativeIds = candidates.filter((id) => !keep.has(id));

  // Bare column names: `level`, `entity_id` and `account_id` are spelled the same in both insight
  // tables, so one predicate serves both instead of two near-copies drifting apart.
  const entityWhere = sql`
    (level = 'campaign' AND entity_id = ANY(${campaignIds}))
    OR (level = 'adset' AND entity_id = ANY(${adSetIds}))
    OR (level = 'ad' AND entity_id = ANY(${adIds}))
    OR (level = 'account' AND account_id = ANY(${emptiedAccounts}))`;
  const allIds = [...campaignIds, ...adSetIds, ...adIds];
  const activityWhere = sql`${schema.metaActivities.objectId} = ANY(${allIds}) OR (${schema.metaActivities.raw}->>'object_name') ~* ${EXCLUDED_NAME_SQL}`;

  const insightRows = await countRows(schema.insightsDaily, entityWhere);
  const breakdownRows = await countRows(schema.insightsBreakdownDaily, entityWhere);
  const [activityCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.metaActivities)
    .where(activityWhere);
  const [overrideCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.campaignClientOverrides)
    .where(sql`${schema.campaignClientOverrides.campaignId} = ANY(${campaignIds})`);

  // Children first, parents last.
  await db.delete(schema.insightsDaily).where(entityWhere);
  await db.delete(schema.insightsBreakdownDaily).where(entityWhere);
  await db.delete(schema.metaActivities).where(activityWhere);
  if (creativeIds.length)
    await db.delete(schema.adCreatives).where(inArray(schema.adCreatives.id, creativeIds));
  if (adIds.length) await db.delete(schema.ads).where(inArray(schema.ads.id, adIds));
  if (adSetIds.length) await db.delete(schema.adSets).where(inArray(schema.adSets.id, adSetIds));
  if (campaignIds.length) {
    await db
      .delete(schema.campaignClientOverrides)
      .where(inArray(schema.campaignClientOverrides.campaignId, campaignIds));
    await db.delete(schema.campaigns).where(inArray(schema.campaigns.id, campaignIds));
  }

  // Record what was found, so the ingest filters keep refusing it once the names are gone from this
  // database and only ids are left to match on.
  const registered = await registerExclusions([
    ...campaignIds.map((id) => ({ id, kind: "campaign" as const, reason: "purge" })),
    ...adSetIds.map((id) => ({ id, kind: "adset" as const, reason: "purge" })),
    ...adIds.map((id) => ({ id, kind: "ad" as const, reason: "purge" })),
    ...emptiedAccounts.map((id) => ({ id, kind: "account" as const, reason: "purge" })),
  ]);
  forgetExclusions();

  // Counts are what this call DELETED, not what it knows about: the recorded ids stay in the
  // predicates forever, so reporting their length would claim four campaigns removed on every
  // cycle. A quiet sweep is supposed to read as all zeroes.
  return {
    campaigns: campaignRows.length,
    adSets: adSetRows.length,
    ads: adRows.length,
    adCreatives: creativeIds.length,
    insightRows,
    breakdownRows,
    activities: Number(activityCount?.n ?? 0),
    overrides: Number(overrideCount?.n ?? 0),
    registered,
    emptiedAccounts,
  };
}
