import { attributeCampaign, brandVocab, normalizeName, type BrandVocab } from "@/lib/attribution";
import { addDays } from "@/lib/range";
import { LIVE_STATUSES } from "@/notion/parse";

/**
 * Which of a client's Notion board rows each of its campaigns ran under, day by day.
 *
 * A client's board rows are its PROJECTS: a brand (OneAgency's Slots.lv, Cafe Casino, Lucky Rebel),
 * a one-off engagement ("BOL HTML5 Casino Ad Campaign"), or one month of a brand booked monthly —
 * "wildcasino.ag (September/October)". Campaign names carry the brand at best and never the month,
 * and one reused ad account carries month after month: on the live book 47% of the spend on such
 * accounts landed outside the engagement the campaign was created in ("Wild #5" ran Feb → Aug on one
 * account across five engagements). So a campaign is not filed under one row: each of its DAYS is.
 *
 * The ladder, first rule that decides wins:
 *
 *   1. **Filed by hand** (`placements`) — the whole campaign, every day, under that row. It exists
 *      for the campaign the rules below get wrong.
 *   2. **Brand.** Rows club into a brand by title before "(" — the sync's own `clientKey` rule, so
 *      the monthly re-cuts of one brand are one brand. The campaign's ad account decides when only
 *      one brand's rows list it; several brands on one account (or an account no row lists, i.e. a
 *      manual add) fall to the server's brand-name matcher, then to the shorthand pass below; a
 *      client with one brand needs no deciding.
 *   3. **Engagement, by date.** Among that brand's rows listing the account (all its rows when none
 *      does), each day belongs to the row with the latest start on or before it — the next
 *      engagement on an account is what ends the last one. `End Date (Estimated)` is a plan and is
 *      never used to cut spend off. Days before the first start belong to no row.
 *   4. Rows the board gives no start: one is the answer; several fall to whichever is live, then to
 *      the name, else nobody.
 *
 * Nothing is dropped. What no rule places is returned as an unplaced claim with its reason, because
 * spend belonging to nobody is a thing an operator must see and settle.
 */

/** A client's board row, as the planner needs it. */
export interface EngagementRow {
  pageId: string;
  title: string;
  status: string | null;
  /** The row's OWN ad accounts (Active + Other), not the client's union. */
  accountIds: string[];
  /** YYYY-MM-DD, or null when the board records no start. */
  startDate: string | null;
}

export interface PlanCampaign {
  id: string;
  name: string;
  accountId: string;
}

/** How a campaign's brand was decided — shown so a surprising placement can be explained. */
export type PlacedBy = "hand" | "account" | "name" | "only";

export type UnplacedReason =
  /** Its account and its name point at no brand of this client (or at several equally). */
  | "no_brand"
  /** It spent before the first engagement on its account started. */
  | "before_start"
  /** Several of the brand's rows on its account start the same day (or have no start), and neither
   *  status nor name picks one. */
  | "ambiguous";

/** One campaign's days [since, until] (inclusive; null = unbounded) and the row they belong to. */
export interface Claim {
  campaignId: string;
  pageId: string | null;
  since: string | null;
  until: string | null;
  placedBy: PlacedBy | null;
  reason: UnplacedReason | null;
}

/**
 * The brand a row belongs to: its title before "(", normalized — so "LuckyRebel" / "Lucky Rebel"
 * and "wildcasino.ag (June/July 2026)" / "wildcasino.ag (May/June 2026))" each club. A title that is
 * all parenthesis keeps its whole text rather than becoming no brand at all.
 */
export const brandKey = (title: string): string =>
  normalizeName(title.split("(")[0]) || normalizeName(title);

const isLive = (row: EngagementRow): boolean =>
  row.status !== null && LIVE_STATUSES.includes(row.status);

/** The shortest title of a brand's rows: the brand without an engagement window on it. */
export const brandName = (rows: EngagementRow[]): string =>
  rows.reduce((best, row) => (row.title.length < best.length ? row.title : best), rows[0].title);

// ── The shorthand pass ─────────────────────────────────────────────────────────────────────────
//
// Run ONLY when the server's matcher placed nothing, and only among one client's own brands — it
// can never move spend between clients. Campaign names carry shorthands the matcher cannot see:
// "SLV Prospecting TOF" is Slots.lv, "LR Prospecting TOF" is Lucky Rebel, "Cafe" is CafeCasino — 39
// of OneAgency's 39 campaigns were unplaceable without it. Deliberately narrow, because a wrong
// guess files a campaign under the wrong brand: the campaign's LEADING word only; equal to a title's
// initials, a prefix of it either way, or an in-order subsequence starting at its first letter; and
// a UNIQUE winner. It is not added to `@/lib/attribution`, which decides which CLIENT owns a
// campaign and must stay exactly as strict as it is.

const initialsOf = (title: string): string =>
  title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("");

const leadingSubsequence = (token: string, key: string): boolean => {
  if (token.length < 3 || key[0] !== token[0]) return false;
  let index = 0;
  for (const character of key) if (character === token[index]) index += 1;
  return index === token.length;
};

function shorthandOwner(
  campaignName: string,
  brands: { key: string; titles: string[] }[],
): string | null {
  const lead = (campaignName.toLowerCase().match(/[a-z0-9]+/) ?? [""])[0];
  const whole = normalizeName(campaignName);
  if (lead.length < 3 && whole.length < 4) return null;
  const hits = brands.filter((brand) =>
    brand.titles.some((title) => {
      const key = brandKey(title);
      if (!key) return false;
      if (lead.length >= 2 && lead === initialsOf(title)) return true;
      if (whole.length >= 4 && (key.startsWith(whole) || whole.startsWith(key))) return true;
      return lead.length >= 3 && (key.startsWith(lead) || leadingSubsequence(lead, key));
    }),
  );
  return hits.length === 1 ? hits[0].key : null;
}

// ── The plan ───────────────────────────────────────────────────────────────────────────────────

const claim = (
  campaignId: string,
  pageId: string,
  since: string | null,
  until: string | null,
  placedBy: PlacedBy,
): Claim => ({ campaignId, pageId, since, until, placedBy, reason: null });

const unplaced = (
  campaignId: string,
  since: string | null,
  until: string | null,
  reason: UnplacedReason,
): Claim => ({ campaignId, pageId: null, since, until, placedBy: null, reason });

/** One row out of several that share a start (or have none): live first, then the name, else none. */
function pickRow(campaign: PlanCampaign, rows: EngagementRow[]): EngagementRow | null {
  if (rows.length === 1) return rows[0];
  const live = rows.filter(isLive);
  if (live.length === 1) return live[0];
  const byName = attributeCampaign(
    campaign.name,
    rows.map((row) => brandVocab(row.pageId, row.title, [row.title])),
  );
  return rows.find((row) => row.pageId === byName) ?? null;
}

/**
 * Split one campaign's days between its brand's rows.
 *
 * The candidates are the brand's rows that list the campaign's account — a brand's engagement on a
 * different account says nothing about this one. Only when none lists it (a campaign placed by name
 * or as the client's only brand, on an account added by hand) do all the brand's rows compete.
 */
function splitByStart(
  campaign: PlanCampaign,
  brandRows: EngagementRow[],
  placedBy: PlacedBy,
): Claim[] {
  const onAccount = brandRows.filter((row) => row.accountIds.includes(campaign.accountId));
  const candidates = onAccount.length ? onAccount : brandRows;
  const dated = candidates.filter((row) => row.startDate !== null);
  if (!dated.length) {
    const row = pickRow(campaign, candidates);
    return [
      row
        ? claim(campaign.id, row.pageId, null, null, placedBy)
        : unplaced(campaign.id, null, null, "ambiguous"),
    ];
  }
  // A dated row outranks an undated one on the same account: the undated one cannot be placed in time.
  const starts = [...new Set(dated.map((row) => row.startDate as string))].sort();
  const out: Claim[] = [unplaced(campaign.id, null, addDays(starts[0], -1), "before_start")];
  starts.forEach((start, index) => {
    const until = index + 1 < starts.length ? addDays(starts[index + 1], -1) : null;
    const row = pickRow(
      campaign,
      dated.filter((candidate) => candidate.startDate === start),
    );
    out.push(
      row
        ? claim(campaign.id, row.pageId, start, until, placedBy)
        : unplaced(campaign.id, start, until, "ambiguous"),
    );
  });
  return out;
}

/**
 * Every campaign's claims, covering all of time with no gaps and no overlaps: each day of a
 * campaign belongs to exactly one claim, so summing a campaign's claims never double-counts it.
 */
export function planEngagements(
  rows: EngagementRow[],
  campaigns: PlanCampaign[],
  placements: ReadonlyMap<string, string> = new Map(),
): Claim[] {
  const named = rows.filter((row) => brandKey(row.title));
  const pages = new Set(named.map((row) => row.pageId));
  const byBrand = new Map<string, EngagementRow[]>();
  for (const row of named) {
    const key = brandKey(row.title);
    const list = byBrand.get(key);
    if (list) list.push(row);
    else byBrand.set(key, [row]);
  }
  const brands = [...byBrand].map(([key, brandRows]) => ({
    key,
    titles: brandRows.map((row) => row.title),
    vocab: brandVocab(
      key,
      brandName(brandRows),
      brandRows.map((row) => row.title),
    ),
  }));
  const brandsByAccount = new Map<string, Set<string>>();
  for (const row of named) {
    for (const accountId of row.accountIds) {
      const set = brandsByAccount.get(accountId) ?? new Set<string>();
      set.add(brandKey(row.title));
      brandsByAccount.set(accountId, set);
    }
  }

  const brandOf = (campaign: PlanCampaign): { key: string; placedBy: PlacedBy } | null => {
    const listing = brandsByAccount.get(campaign.accountId);
    if (listing?.size === 1) return { key: [...listing][0], placedBy: "account" };
    const pool = listing?.size ? brands.filter((brand) => listing.has(brand.key)) : brands;
    if (pool.length === 1) return { key: pool[0].key, placedBy: "only" };
    const vocabs: BrandVocab[] = pool.map((brand) => brand.vocab);
    const byName = attributeCampaign(campaign.name, vocabs) ?? shorthandOwner(campaign.name, pool);
    return byName ? { key: byName, placedBy: "name" } : null;
  };

  return campaigns.flatMap((campaign) => {
    const hand = placements.get(campaign.id);
    if (hand && pages.has(hand)) return [claim(campaign.id, hand, null, null, "hand")];
    const brand = brandOf(campaign);
    if (!brand) return [unplaced(campaign.id, null, null, "no_brand")];
    return splitByStart(campaign, byBrand.get(brand.key) ?? [], brand.placedBy);
  });
}

/** The part of a claim inside [since, until], or null when they do not meet. */
export function clipClaim(
  c: Claim,
  since: string,
  until: string,
): { since: string; until: string } | null {
  const from = c.since !== null && c.since > since ? c.since : since;
  const to = c.until !== null && c.until < until ? c.until : until;
  return from <= to ? { since: from, until: to } : null;
}

/** The claim holding `day`. Claims of one campaign tile all of time, so there is exactly one. */
export function claimOn(claims: Claim[], day: string): Claim | undefined {
  return claims.find(
    (c) => (c.since === null || c.since <= day) && (c.until === null || c.until >= day),
  );
}

/**
 * The day before a row's successor starts — the end of its run, as the board implies it: the next
 * engagement of the same brand that shares one of its accounts (any, for a row listing none). Null
 * for the current engagement and for a row with no start.
 */
export function impliedUntil(row: EngagementRow, rows: EngagementRow[]): string | null {
  if (!row.startDate) return null;
  const start = row.startDate;
  const key = brandKey(row.title);
  const shares = (other: EngagementRow): boolean =>
    !row.accountIds.length ||
    !other.accountIds.length ||
    other.accountIds.some((accountId) => row.accountIds.includes(accountId));
  const next = rows
    .filter(
      (other) =>
        other.pageId !== row.pageId &&
        brandKey(other.title) === key &&
        other.startDate !== null &&
        other.startDate > start &&
        shares(other),
    )
    .map((other) => other.startDate as string)
    .sort()[0];
  return next ? addDays(next, -1) : null;
}
