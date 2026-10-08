import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { addDays, windowFromDates, type DateWindow } from "@/lib/range";
import { forecastBudgetEnd, paceWindow, type BudgetForecast } from "@/lib/budget-forecast";
import type { Campaign } from "@/lib/types";
import {
  brandKey,
  brandName,
  claimOn,
  clipClaim,
  impliedUntil,
  isLive,
  planEngagements,
  type Claim,
  type EngagementRow,
  type PlacedBy,
  type UnplacedReason,
} from "@/lib/engagements";
import { boardRows } from "@/notion/parse";
import { boardDates, type BoardDates } from "@/server/board-dates";
import { effectiveAccountIds, getClientRow } from "@/sync/jobs/clients";
import { clientCampaignScope, loadCampaignOwnership } from "./campaign-attribution";
import { fetchCampaigns } from "./dashboard";

/**
 * A client's projects — one per Notion board row — with the campaigns that ran under each.
 *
 * The placement itself is `planEngagements` (src/lib/engagements.ts): a campaign's DAYS are filed,
 * not the campaign, because a reused ad account carries one brand's engagements month after month.
 * This module measures what that plan says: each project's campaign rows are measured over exactly
 * the days of the requested range that are that project's, so one campaign that ran across two
 * engagements is two rows with two partial sets of figures — and the projects plus the unmatched
 * remainder add up to the client, never more.
 *
 * `placements` are the campaigns filed by hand (`campaignId → pageId`). They live in the Base44
 * app, which sends them with every call; one naming a row this client does not have is ignored.
 */

/** A campaign row inside a project, measured over that project's share of the range. */
export interface ProjectCampaign extends Campaign {
  /** The days these figures cover. `partial`: fewer than the whole range — the campaign ran under
   *  another project (or none) on the rest. */
  window: { since: string; until: string; partial: boolean };
  placedBy: PlacedBy | null;
  unplacedReason: UnplacedReason | null;
}

export interface ClientProject {
  pageId: string;
  title: string;
  /** The brand the row belongs to: the shortest title among the rows that club with it. */
  brand: string;
  status: string | null;
  startDate: string | null;
  /** The board's `End Date (Estimated)` — a plan, shown for context. */
  plannedEndDate: string | null;
  /** The day before the next engagement on its accounts starts; null while it is the current one. */
  impliedEndDate: string | null;
  budget: number | null;
  accountIds: string[];
  campaigns: ProjectCampaign[];
  /** Spend on every day this row owns from its start through today, whatever the range — the figure
   *  its budget is measured against. Null without a start date. */
  spentSinceStart: number | null;
  /** The board calls this engagement current (`LIVE_STATUSES`). */
  live: boolean;
  /** A live engagement with a budget and a start: its burn rate over its own last complete days and
   *  when the budget runs out at it. Null for any other row — a runway for a finished engagement is
   *  a figure nobody needs. */
  forecast: BudgetForecast | null;
}

export interface ClientProjects {
  clientId: string;
  projects: ClientProject[];
  /** Campaign days no rule placed, with each row's reason. */
  unmatched: ProjectCampaign[];
  /** The live board read the dates came from. `error` set: there were no dates to split by. */
  board: { asOf: string | null; error: string | null };
}

interface OwnedCampaign {
  id: string;
  name: string;
  accountId: string;
  createdTime: Date | null;
}

const num = (v: unknown): number => Number(v ?? 0);
const ymd = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** A client's board rows, each with its own accounts and the start date the live board gives it. */
function engagementRows(raw: unknown, dates: BoardDates): EngagementRow[] {
  return boardRows(raw).map((row) => ({
    pageId: row.pageId,
    title: row.title,
    status: row.status,
    accountIds: row.accountIds,
    startDate: dates.byPage.get(row.pageId)?.startDate ?? null,
  }));
}

/** Each campaign's last day with spend, ever. Where a campaign with nothing in the range is listed. */
async function lastSpendDays(campaignIds?: string[]): Promise<Map<string, string>> {
  if (campaignIds && campaignIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: schema.insightsDaily.entityId,
      last: sql<string>`max(${schema.insightsDaily.date})::text`,
    })
    .from(schema.insightsDaily)
    .where(
      and(
        eq(schema.insightsDaily.level, "campaign"),
        gt(schema.insightsDaily.spend, 0),
        campaignIds ? inArray(schema.insightsDaily.entityId, campaignIds) : undefined,
      ),
    )
    .groupBy(schema.insightsDaily.entityId);
  return new Map(rows.map((r) => [r.id, r.last]));
}

/** Claims grouped by campaign. Each campaign's claims tile all of time (see `planEngagements`). */
const byCampaign = (claims: Claim[]): Map<string, Claim[]> => {
  const out = new Map<string, Claim[]>();
  for (const c of claims) {
    const list = out.get(c.campaignId);
    if (list) list.push(c);
    else out.set(c.campaignId, [c]);
  }
  return out;
};

/**
 * The row a campaign belongs to when a single answer is needed: the one it last spent under, or
 * the one it was created under when it never spent. Null when that day is in no row.
 */
function currentPage(
  claims: Claim[],
  lastSpend: string | undefined,
  created: string | null,
): string | null {
  const day = lastSpend ?? created;
  return day ? (claimOn(claims, day)?.pageId ?? null) : null;
}

/**
 * Each row's spend between its own bounds (`from`, and `until` or open), summed over exactly the
 * days its claims hold. One query: the spans travel as a single jsonb parameter (drizzle would
 * expand a JS array into placeholders).
 */
async function spendWithin(
  claims: Claim[],
  bounds: ReadonlyMap<string, { from: string; until: string | null }>,
): Promise<Map<string, number>> {
  const spans = claims.flatMap((c) => {
    const bound = c.pageId ? bounds.get(c.pageId) : undefined;
    if (!c.pageId || !bound) return [];
    // Only from the engagement's own start: a hand-filed campaign's earlier spend is not this budget's.
    const since = c.since !== null && c.since > bound.from ? c.since : bound.from;
    const until =
      bound.until === null
        ? c.until
        : c.until !== null && c.until < bound.until
          ? c.until
          : bound.until;
    if (until !== null && until < since) return [];
    return [{ page_id: c.pageId, campaign_id: c.campaignId, since, until }];
  });
  if (!spans.length) return new Map();
  const result = await db.execute(sql`
    select s.page_id, coalesce(sum(d.spend), 0) as spend
    from jsonb_to_recordset(${JSON.stringify(spans)}::jsonb)
      as s(page_id text, campaign_id text, since date, until date)
    join insights_daily d
      on d.level = 'campaign' and d.entity_id = s.campaign_id
     and d.date >= s.since and (s.until is null or d.date <= s.until)
    group by s.page_id
  `);
  const out = new Map<string, number>();
  for (const r of result as unknown as { page_id: string; spend: number }[]) {
    out.set(r.page_id, Math.round(num(r.spend) * 100) / 100);
  }
  return out;
}

export async function fetchClientProjects(
  id: string,
  w: DateWindow,
  placements: ReadonlyMap<string, string>,
): Promise<ClientProjects | null> {
  const row = await getClientRow(id);
  if (!row) return null;
  const effective = effectiveAccountIds(row);
  // Ownership first, exactly as `fetchClientDetail` resolves it: a project can only hold campaigns
  // its client owns, so a shared account's other-client campaigns never reach the planner.
  const [scope, dates] = await Promise.all([clientCampaignScope(id, effective), boardDates()]);
  const accountIds = [...new Set([...effective, ...scope.extraAccountIds])];
  const excluded = new Set(scope.excludedCampaignIds);
  const owned: OwnedCampaign[] = accountIds.length
    ? (
        await db
          .select({
            id: schema.campaigns.id,
            name: schema.campaigns.name,
            accountId: schema.campaigns.accountId,
            createdTime: schema.campaigns.createdTime,
          })
          .from(schema.campaigns)
          .where(inArray(schema.campaigns.accountId, accountIds))
      ).filter((c) => !excluded.has(c.id))
    : [];

  const rows = engagementRows(row.raw, dates);
  const claims = planEngagements(rows, owned, placements);
  const claimsOf = byCampaign(claims);
  const accountOf = new Map(owned.map((c) => [c.id, c.accountId]));

  // Every distinct slice of the range some claim covers, measured once each with the accounts that
  // have a campaign in it. The whole range is always measured: it is where a campaign with nothing
  // in the range gets its (zero) row, and in the usual case — a range inside one engagement — the
  // only slice there is.
  const spanKey = (s: { since: string; until: string }): string => `${s.since}|${s.until}`;
  const whole = { since: w.since, until: w.until };
  const slices = new Map([[spanKey(whole), { ...whole, accounts: new Set(accountIds) }]]);
  for (const c of claims) {
    const span = clipClaim(c, w.since, w.until);
    const accountId = accountOf.get(c.campaignId);
    if (!span || !accountId) continue;
    const slice = slices.get(spanKey(span)) ?? { ...span, accounts: new Set<string>() };
    slice.accounts.add(accountId);
    slices.set(spanKey(span), slice);
  }
  // Budgets are measured from each engagement's own start, and paced over its own last complete
  // days (`paceWindow` never reaches back before the start: a recycled account carries the previous
  // engagement's spend).
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = addDays(today, -1);
  const starts = new Map<string, { from: string; until: string | null }>();
  const paces = new Map<string, { from: string; until: string | null; days: number }>();
  for (const r of rows) {
    if (!r.startDate) continue;
    starts.set(r.pageId, { from: r.startDate, until: null });
    const pw = isLive(r) ? paceWindow({ startDate: r.startDate, until: yesterday }) : null;
    if (pw) paces.set(r.pageId, { from: pw.from, until: yesterday, days: pw.days });
  }
  const [measured, lastSpend, sinceStart, paceSpend] = await Promise.all([
    Promise.all(
      [...slices.values()].map(async (slice) => {
        const list = await fetchCampaigns(windowFromDates(slice.since, slice.until), [
          ...slice.accounts,
        ]);
        return [spanKey(slice), new Map(list.map((c) => [c.id, c]))] as const;
      }),
    ).then((entries) => new Map(entries)),
    lastSpendDays(owned.map((c) => c.id)),
    spendWithin(claims, starts),
    spendWithin(claims, paces),
  ]);

  const projects = new Map<string, ClientProject>(
    rows.map((r) => {
      const siblings = rows.filter((other) => brandKey(other.title) === brandKey(r.title));
      const board = dates.byPage.get(r.pageId);
      const budget = board?.budget ?? null;
      const spent = r.startDate ? (sinceStart.get(r.pageId) ?? 0) : null;
      const pace = paces.get(r.pageId);
      return [
        r.pageId,
        {
          pageId: r.pageId,
          title: r.title,
          brand: siblings.length ? brandName(siblings) : r.title,
          status: r.status,
          startDate: r.startDate,
          plannedEndDate: board?.endDate ?? null,
          impliedEndDate: impliedUntil(r, rows),
          budget,
          accountIds: r.accountIds,
          campaigns: [],
          spentSinceStart: spent,
          live: isLive(r),
          forecast:
            isLive(r) && budget !== null && spent !== null
              ? pace
                ? forecastBudgetEnd({
                    total: budget,
                    spent,
                    dailyPace: (paceSpend.get(r.pageId) ?? 0) / pace.days,
                    today,
                  })
                : {
                    projectedEndDate: null,
                    dailyPace: 0,
                    daysRemaining: null,
                    reason: "too few complete days since it started",
                  }
              : null,
        },
      ];
    }),
  );
  const unmatched: ProjectCampaign[] = [];
  const put = (c: Claim, campaign: Campaign, span: { since: string; until: string }): void => {
    const entry: ProjectCampaign = {
      ...campaign,
      window: { ...span, partial: span.since !== w.since || span.until !== w.until },
      placedBy: c.placedBy,
      unplacedReason: c.reason,
    };
    const project = c.pageId ? projects.get(c.pageId) : undefined;
    if (project) project.campaigns.push(entry);
    else unmatched.push(entry);
  };

  const delivered = new Set<string>();
  for (const c of claims) {
    const span = clipClaim(c, w.since, w.until);
    if (!span) continue;
    const campaign = measured.get(spanKey(span))?.get(c.campaignId);
    if (!campaign || (campaign.spend <= 0 && campaign.impressions <= 0)) continue;
    put(c, campaign, span);
    delivered.add(c.campaignId);
  }
  // Nothing delivered in the range: listed once, at zero, under the row it last ran under (made
  // under, if it never ran) — a paused campaign stays findable under its project.
  const zero = measured.get(spanKey(whole));
  for (const campaign of owned) {
    if (delivered.has(campaign.id)) continue;
    const measuredRow = zero?.get(campaign.id);
    const own = claimsOf.get(campaign.id) ?? [];
    const day = lastSpend.get(campaign.id) ?? ymd(campaign.createdTime) ?? w.until;
    const home = claimOn(own, day);
    if (measuredRow && home) put(home, measuredRow, whole);
  }

  const bySpend = (a: Campaign, b: Campaign): number => b.spend - a.spend;
  for (const project of projects.values()) project.campaigns.sort(bySpend);
  unmatched.sort(bySpend);
  return {
    clientId: row.id,
    projects: [...projects.values()],
    unmatched,
    board: { asOf: dates.asOf, error: dates.error },
  };
}

// ── The whole book, without figures ────────────────────────────────────────────────────────────

export interface ProjectMapEntry {
  pageId: string;
  title: string;
  status: string | null;
  startDate: string | null;
  impliedEndDate: string | null;
}

export interface ClientProjectMap {
  id: string;
  name: string;
  projects: ProjectMapEntry[];
  /** pageId → every campaign that ever spent under that row. What a project filter or a report's
   *  project chip selects: a campaign that served two engagements belongs to both. */
  members: Record<string, string[]>;
  /** campaignId → the row it last spent under (or was made under). Absent: no row holds it. */
  current: Record<string, string>;
}

export interface ProjectMap {
  clients: ClientProjectMap[];
  board: { asOf: string | null; error: string | null };
}

/**
 * Every client's projects and which campaigns belong to each, for the surfaces that name a
 * campaign's project without its figures: the top-bar project filter, the creative cards, the report
 * builder's project chips. Same ownership ladder and same plan as `fetchClientProjects`, over the
 * campaigns' whole lives rather than a range, so the answer does not move with the date picker.
 */
export async function fetchProjectMap(
  placements: ReadonlyMap<string, string>,
): Promise<ProjectMap> {
  const [clients, ownership, dates, campaigns, lastSpend] = await Promise.all([
    db.select().from(schema.clients).where(isNull(schema.clients.removedAt)),
    loadCampaignOwnership(),
    boardDates(),
    db
      .select({
        id: schema.campaigns.id,
        name: schema.campaigns.name,
        accountId: schema.campaigns.accountId,
        createdTime: schema.campaigns.createdTime,
      })
      .from(schema.campaigns),
    lastSpendDays(),
  ]);

  const byOwner = new Map<string, OwnedCampaign[]>();
  for (const campaign of campaigns) {
    const owner = ownership.ownerOf(campaign);
    if (!owner) continue;
    const list = byOwner.get(owner);
    if (list) list.push(campaign);
    else byOwner.set(owner, [campaign]);
  }

  const planned = clients.map((client) => {
    const rows = engagementRows(client.raw, dates);
    const owned = byOwner.get(client.id) ?? [];
    return { client, rows, owned, claims: planEngagements(rows, owned, placements) };
  });

  // Membership needs a spend check only where a campaign's life is split between claims; a single
  // placed claim holds every day of it, so "ever spent" is already known from `lastSpend`.
  const split = planned.flatMap(({ claims }) => {
    const groups = byCampaign(claims);
    return claims.filter(
      (c) => c.pageId && lastSpend.has(c.campaignId) && (groups.get(c.campaignId)?.length ?? 0) > 1,
    );
  });
  const spentUnder = new Set<string>();
  if (split.length) {
    const spans = split.map((c) => ({
      page_id: c.pageId,
      campaign_id: c.campaignId,
      since: c.since,
      until: c.until,
    }));
    const result = await db.execute(sql`
      select s.page_id, s.campaign_id
      from jsonb_to_recordset(${JSON.stringify(spans)}::jsonb)
        as s(page_id text, campaign_id text, since date, until date)
      where exists (
        select 1 from insights_daily d
        where d.level = 'campaign' and d.entity_id = s.campaign_id and d.spend > 0
          and (s.since is null or d.date >= s.since) and (s.until is null or d.date <= s.until)
      )
    `);
    for (const r of result as unknown as { page_id: string; campaign_id: string }[]) {
      spentUnder.add(`${r.page_id}:${r.campaign_id}`);
    }
  }

  return {
    clients: planned.map(({ client, rows, owned, claims }) => {
      const groups = byCampaign(claims);
      const members: Record<string, string[]> = {};
      const current: Record<string, string> = {};
      for (const campaign of owned) {
        const own = groups.get(campaign.id) ?? [];
        const page = currentPage(own, lastSpend.get(campaign.id), ymd(campaign.createdTime));
        if (page) current[campaign.id] = page;
        for (const c of own) {
          if (!c.pageId) continue;
          const spent =
            own.length === 1
              ? lastSpend.has(campaign.id)
              : spentUnder.has(`${c.pageId}:${campaign.id}`);
          // A campaign that never spent still belongs where it was made, or a fresh campaign would
          // be in no project's filter until its first dollar.
          if (spent || (!lastSpend.has(campaign.id) && c.pageId === page)) {
            (members[c.pageId] ??= []).push(campaign.id);
          }
        }
      }
      return {
        id: client.id,
        name: client.name,
        projects: rows.map((r) => ({
          pageId: r.pageId,
          title: r.title,
          status: r.status,
          startDate: r.startDate,
          impliedEndDate: impliedUntil(r, rows),
        })),
        members,
        current,
      };
    }),
    board: { asOf: dates.asOf, error: dates.error },
  };
}
