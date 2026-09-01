/**
 * Budget: the CONTRACT side of the business.
 *
 * Two different numbers are called "budget" here and they must never be conflated:
 *
 * - The **contract** — `Budget ($)`, `Actual Start Date` and `End Date (Estimated)` on the Notion
 *   campaigns board. What the client agreed to and when it was meant to run. Human-owned; Meta knows
 *   nothing about it.
 * - The **delivery budget** — Meta's per-campaign daily/lifetime budget. What the ad accounts are
 *   configured to spend.
 *
 * Spend, on both sides, comes from our synced Meta insights. Pacing is the comparison of the three:
 * what was contracted, what delivery is set to, and what actually went out the door.
 */
import {
  fetchClientBudgets,
  fetchClientBudgetPacing,
  fetchClientDetail,
  type ClientBudgetPacing,
} from "@/server/fns/clients";
import {
  budgetRemaining,
  targetDailyBudget,
  SPEND_WINDOW_DAYS,
  TARGET_BUDGET_DAYS,
} from "@/sync/jobs/notion-budget";
import { PACE_DAYS } from "@/lib/budget-forecast";
import { LIVE_STATUSES } from "@/notion/parse";
import { windowFromDays } from "@/lib/range";
import { isResolveError, resolveClient, type AgentTool } from "./kit";

type Verdict = "on_track" | "underspending" | "overspending" | "not_tracked";

/** How far the recent pace may sit either side of the target daily budget before it is a problem. */
const PACE_TOLERANCE = 0.15;
/** How far the forecast burn-out date may sit either side of the planned end date before it is. */
const END_SLACK_DAYS = 7;

const cents = (n: number): number => Math.round(n * 100) / 100;

/** Whole days from `a` to `b` (negative = `b` is earlier). Both YYYY-MM-DD, UTC. */
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

const todayYmd = (): string => new Date().toISOString().slice(0, 10);

const money = (n: number): string => `$${cents(n).toLocaleString("en-US")}`;

/** Strip nulls so a 40-row list does not spend a third of its tokens on `"plannedEndDate": null`. */
function compact(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

interface Pacing {
  total: number | null;
  spent: number;
  startDate: string | null;
  plannedEndDate: string | null;
  dailyPace: number;
  projectedEndDate: string | null;
  daysRemaining: number | null;
  forecastReason: string | null;
}

/**
 * Is this engagement spending its contract at the right rate, and why.
 *
 * The planned end date decides it whenever both dates exist — "the money runs out three weeks before
 * the campaign is meant to stop" is the commercially meaningful statement, and it already folds in
 * how much has been spent so far. Only when the board records no end date does this fall back to
 * comparing the recent pace against the contract spread over `TARGET_BUDGET_DAYS`.
 */
function verdictFor(p: Pacing, today: string): { verdict: Verdict; reason: string } {
  if (p.total === null || !(p.total > 0))
    return {
      verdict: "not_tracked",
      reason:
        "No budget is recorded for this engagement on the Notion campaigns board, so there is nothing to pace against.",
    };
  if (p.startDate === null)
    return {
      verdict: "not_tracked",
      reason: `A budget of ${money(p.total)} is recorded but the board has no start date, so spend against the contract cannot be measured (these ad accounts carry previous engagements, and counting their lifetime spend would be wrong).`,
    };

  const remaining = p.total - p.spent;
  if (remaining <= 0) {
    const over = remaining < 0 ? ` and is ${money(-remaining)} over` : "";
    if (p.plannedEndDate !== null && p.plannedEndDate <= today)
      return {
        verdict: "on_track",
        reason: `The contract is fully delivered${over}: ${money(p.spent)} of ${money(p.total)} spent, past the planned end date of ${p.plannedEndDate}.`,
      };
    const early =
      p.plannedEndDate !== null
        ? ` — ${daysBetween(today, p.plannedEndDate)} days before the planned end of ${p.plannedEndDate}`
        : "";
    return {
      verdict: "overspending",
      reason: `The budget is exhausted${over}: ${money(p.spent)} spent against ${money(p.total)}${early}. Delivery is either already stopped or spending money nobody contracted.`,
    };
  }

  if (p.dailyPace <= 0)
    return {
      verdict: "underspending",
      reason: `Nothing was spent in the last ${PACE_DAYS} days while ${money(remaining)} of the ${money(p.total)} contract is still unspent${p.plannedEndDate !== null ? ` and the planned end is ${p.plannedEndDate}` : ""}. Delivery has stalled — check account status and campaign delivery.`,
    };

  if (p.plannedEndDate !== null && p.projectedEndDate !== null) {
    const drift = daysBetween(p.plannedEndDate, p.projectedEndDate);
    if (drift < -END_SLACK_DAYS)
      return {
        verdict: "overspending",
        reason: `At ${money(p.dailyPace)}/day the remaining ${money(remaining)} runs out on ${p.projectedEndDate}, ${-drift} days BEFORE the planned end of ${p.plannedEndDate}. Slow delivery down or the contract needs topping up.`,
      };
    if (drift > END_SLACK_DAYS)
      return {
        verdict: "underspending",
        reason: `At ${money(p.dailyPace)}/day the remaining ${money(remaining)} lasts until ${p.projectedEndDate}, ${drift} days AFTER the planned end of ${p.plannedEndDate}. The contract will not be delivered on time at this rate.`,
      };
    return {
      verdict: "on_track",
      reason: `At ${money(p.dailyPace)}/day the remaining ${money(remaining)} runs out on ${p.projectedEndDate}, within ${END_SLACK_DAYS} days of the planned end of ${p.plannedEndDate}.`,
    };
  }

  const target = targetDailyBudget(p.total);
  if (target === null || target <= 0)
    return {
      verdict: "on_track",
      reason: `Spending ${money(p.dailyPace)}/day with ${money(remaining)} of ${money(p.total)} left; no planned end date is recorded, so there is nothing to be late or early against.`,
    };
  const ratio = p.dailyPace / target;
  const versus = `${money(p.dailyPace)}/day against a target of ${money(target)}/day (the ${money(p.total)} contract spread over ${TARGET_BUDGET_DAYS} days). No planned end date is recorded, so this is judged on rate alone.`;
  if (ratio > 1 + PACE_TOLERANCE)
    return {
      verdict: "overspending",
      reason: `Spending ${Math.round((ratio - 1) * 100)}% above target: ${versus}`,
    };
  if (ratio < 1 - PACE_TOLERANCE)
    return {
      verdict: "underspending",
      reason: `Spending ${Math.round((1 - ratio) * 100)}% below target: ${versus}`,
    };
  return { verdict: "on_track", reason: `Spending ${versus}` };
}

const SOURCE_NOTE =
  "Budget, start date and planned end date come from the Notion campaigns board (the CONTRACT, entered by the team). Spend, pace and the forecast come from synced Meta insights.";

export const getBudgetPacing: AgentTool = {
  label: "budget pacing",
  definition: {
    name: "get_budget_pacing",
    description:
      "Is ONE client spending its contracted budget at the right rate? Returns `contract` (total budget $, spent since the engagement's start date, remaining, startDate, plannedEndDate), `pace` (dailyPace = $/day over the last 14 complete days, targetDailyBudget = the contract spread over 30 days), `forecast` (projectedEndDate = when the remaining budget runs out at the current pace, daysRemaining, and a reason when no date could be produced), and `verdict`: on_track / underspending / overspending / not_tracked, each with a plain-English `reason` you can relay verbatim. The budget, start date and planned end date are the CONTRACT and come from the Notion campaigns board; spend and pace come from synced Meta insights. Use this for 'is X pacing correctly', 'when does X's budget run out', 'is X under/overspending', 'how much of X's budget is left'. For the per-CAMPAIGN daily budgets Meta is configured to deliver, use get_campaign_budgets instead; to sweep every client at once, use list_budget_risks.",
    input_schema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          description:
            "Client name/id, or a Notion campaign/brand name grouped under one. Fuzzy-matched.",
        },
      },
      required: ["client"],
    },
  },
  async run(input) {
    const resolved = await resolveClient(String(input.client ?? ""));
    if (isResolveError(resolved)) return resolved;
    // The contract is recorded per CLIENT, so the figures are never scoped to a matched brand's own
    // accounts: a brand's share of spend measured against the whole client's budget is a nonsense.
    const detail = await fetchClientDetail(resolved.id, windowFromDays(PACE_DAYS));
    if (!detail) return { error: `Client "${resolved.name}" has no data.` };

    const b = detail.budget;
    const today = todayYmd();
    const { verdict, reason } = verdictFor(b, today);
    const target = targetDailyBudget(b.total);
    return {
      client: detail.name,
      status: detail.status,
      ...(resolved.matchedBrand
        ? {
            matchedBrand: resolved.matchedBrand,
            brandNote: `The contract budget is recorded per client, so these figures cover ALL of "${detail.name}"${resolved.siblingBrands?.length ? `, including ${resolved.siblingBrands.join(", ")}` : ""} — not "${resolved.matchedBrand}" alone. Say so.`,
          }
        : {}),
      contract: {
        total: b.total,
        spent: cents(b.spent),
        remaining: budgetRemaining(b.total, b.startDate === null ? null : b.spent),
        startDate: b.startDate,
        plannedEndDate: b.plannedEndDate,
        daysToPlannedEnd: b.plannedEndDate === null ? null : daysBetween(today, b.plannedEndDate),
      },
      pace: {
        dailyPace: cents(b.dailyPace),
        paceWindowDays: PACE_DAYS,
        targetDailyBudget: target,
        targetBasis: `the contracted total spread over ${TARGET_BUDGET_DAYS} days`,
      },
      forecast: {
        projectedEndDate: b.projectedEndDate,
        daysRemaining: b.daysRemaining,
        reason: b.forecastReason,
      },
      verdict,
      reason,
      source: SOURCE_NOTE,
    };
  },
};

/** Base rank per verdict; the tie-break within a band is 0-999, so bands never interleave. */
const URGENCY_BASE: Record<Verdict, number> = {
  overspending: 3000,
  underspending: 2000,
  not_tracked: 1000,
  on_track: 0,
};

const clamp = (n: number): number => Math.max(0, Math.min(999, Math.round(n)));

/**
 * Sort key: burning out soonest first, then furthest behind schedule, then the biggest daily spend
 * with no contract recorded at all.
 */
function urgency(v: Verdict, r: ClientBudgetPacing): number {
  if (v === "overspending") return URGENCY_BASE[v] + 999 - clamp(r.daysRemaining ?? 0);
  if (v === "underspending") {
    // No forecast (nothing spent recently) is as late as it gets — the contract is going nowhere.
    const late =
      r.plannedEndDate !== null && r.projectedEndDate !== null
        ? daysBetween(r.plannedEndDate, r.projectedEndDate)
        : 999;
    return URGENCY_BASE[v] + clamp(late);
  }
  if (v === "not_tracked") return URGENCY_BASE[v] + clamp(r.dailyPace);
  return 0;
}

const MAX_RISK_ROWS = 40;

export const listBudgetRisks: AgentTool = {
  label: "budget risks",
  definition: {
    name: "list_budget_risks",
    description:
      "Sweeps EVERY client's contracted budget in one call and returns only the ones that need attention, most urgent first: budgets that will burn out well BEFORE the planned end date (overspending), budgets that will not be delivered by then or have stopped spending entirely (underspending), and live clients with NO budget recorded at all (not_tracked). This is the answer to 'which clients need attention', 'who is off-pace', 'whose budget is about to run out', 'who is underspending'. Each row carries client, Notion status, verdict, a plain-English reason, budget, spent, remaining, dailyPace ($/day over the last 14 complete days), plannedEndDate, projectedEndDate and daysRemaining, plus counts of how many clients were scanned and how many are on track. Budgets come from the Notion campaigns board (the contract); spend and pace come from synced Meta insights. Spend here is summed at AD-ACCOUNT level, so a client sharing an account with another client can be overstated — call get_budget_pacing for the precise, attribution-aware figure on any single client before quoting numbers back.",
    input_schema: {
      type: "object",
      properties: {
        include_inactive: {
          type: "boolean",
          description:
            "Also scan engagements that are finished, not started, or no longer on the Notion board. Default false — those are not this week's problem.",
        },
        verdict: {
          type: "string",
          enum: ["overspending", "underspending", "not_tracked"],
          description: "Return only this kind of risk. Default: all three.",
        },
      },
    },
  },
  async run(input) {
    const all = await fetchClientBudgetPacing();
    const includeInactive = Boolean(input.include_inactive);
    const only = typeof input.verdict === "string" ? input.verdict : null;
    const today = todayYmd();

    const live = all.filter(
      (c) => includeInactive || (c.removedAt === null && LIVE_STATUSES.includes(c.status ?? "")),
    );
    if (live.length === 0)
      return {
        scanned: 0,
        note: includeInactive
          ? "No clients are synced yet. Configure Notion in Settings."
          : "No engagement is currently live on the Notion campaigns board. Pass include_inactive=true to scan finished and not-yet-started ones too.",
      };

    const judged = live.map((c) => ({ client: c, ...verdictFor(c, today) }));
    const onTrack = judged.filter((j) => j.verdict === "on_track").length;
    const risks = judged
      .filter((j) => j.verdict !== "on_track" && (only === null || j.verdict === only))
      .sort((a, b) => urgency(b.verdict, b.client) - urgency(a.verdict, a.client));

    const rows = risks.slice(0, MAX_RISK_ROWS).map((j) =>
      compact({
        client: j.client.name,
        status: j.client.status,
        verdict: j.verdict,
        reason: j.reason,
        budget: j.client.total,
        // Spend is only meaningful measured from the engagement's own start date.
        spent: j.client.startDate === null ? null : j.client.spent,
        remaining: j.client.remaining,
        dailyPace: j.client.dailyPace,
        targetDailyBudget: targetDailyBudget(j.client.total),
        startDate: j.client.startDate,
        plannedEndDate: j.client.plannedEndDate,
        projectedEndDate: j.client.projectedEndDate,
        daysRemaining: j.client.daysRemaining,
      }),
    );

    return {
      scanned: live.length,
      onTrack,
      atRisk: risks.length,
      ...(risks.length > MAX_RISK_ROWS
        ? { truncated: `showing the ${MAX_RISK_ROWS} most urgent of ${risks.length}` }
        : {}),
      ...(risks.length === 0
        ? { note: `All ${live.length} live engagements are pacing on track.` }
        : {}),
      risks: rows,
      source: SOURCE_NOTE,
    };
  },
};

const MAX_CAMPAIGN_ROWS = 40;

/** How this campaign's delivery compares with the daily budget it is configured to spend. */
function delivery(dailyBudget: number | null, recentDaily: number): string {
  if (dailyBudget === null || dailyBudget <= 0) return "no_daily_budget_on_campaign"; // budget lives on its ad sets (ABO) or is a lifetime budget
  const ratio = recentDaily / dailyBudget;
  if (ratio < 0.05) return "not_delivering";
  if (ratio < 0.7) return "under_delivering";
  if (ratio > 1.3) return "over_delivering";
  return "on_budget";
}

export const getCampaignBudgets: AgentTool = {
  label: "campaign budgets",
  definition: {
    name: "get_campaign_budgets",
    description: `Per-campaign delivery budgets for one client, so you can spot campaigns whose budget and actual delivery disagree. One row per campaign: status, dailyBudget (the $/day Meta is CONFIGURED to spend on that campaign; null when the campaign holds no daily budget of its own — the budget sits on its ad sets, or it is a lifetime budget), recentDailySpend (actual average $/day over the last ${SPEND_WINDOW_DAYS} days), lifetimeSpend, and a \`delivery\` flag comparing the two: on_budget, under_delivering, not_delivering, over_delivering, or no_daily_budget_on_campaign. Sorted by lifetime spend. Totals for the client are included. These are META's delivery budgets — for the CONTRACTED engagement budget and whether the client is pacing against it, use get_budget_pacing. For the ad-set-level budgets behind a no_daily_budget_on_campaign row, use get_ad_sets.`,
    input_schema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          description:
            "Client name/id, or a Notion campaign/brand name grouped under one. Fuzzy-matched.",
        },
      },
      required: ["client"],
    },
  },
  async run(input) {
    const resolved = await resolveClient(String(input.client ?? ""));
    if (isResolveError(resolved)) return resolved;
    const campaigns = await fetchClientBudgets(resolved.id);
    if (campaigns.length === 0)
      return {
        client: resolved.name,
        note: `No campaigns are attributed to "${resolved.name}" — it may have no ad accounts mapped, or every campaign on its shared accounts belongs to another client.`,
      };

    const rows = campaigns.slice(0, MAX_CAMPAIGN_ROWS).map((c) => ({
      campaign: c.name,
      status: c.status,
      dailyBudget: c.dailyBudget === null ? null : cents(c.dailyBudget),
      recentDailySpend: cents(c.recentDaily),
      lifetimeSpend: cents(c.spent),
      delivery: delivery(c.dailyBudget, c.recentDaily),
    }));

    const active = campaigns.filter((c) => c.status === "ACTIVE");
    return {
      client: resolved.name,
      ...(resolved.matchedBrand
        ? {
            matchedBrand: resolved.matchedBrand,
            brandNote: `Campaigns cover all of client "${resolved.name}"${resolved.siblingBrands?.length ? `, including ${resolved.siblingBrands.join(", ")}` : ""}, not "${resolved.matchedBrand}" alone.`,
          }
        : {}),
      campaignCount: campaigns.length,
      activeCampaigns: active.length,
      // Only ACTIVE campaigns can spend, so a paused campaign's configured budget is not money at risk.
      activeDailyBudget: cents(active.reduce((n, c) => n + (c.dailyBudget ?? 0), 0)),
      recentDailySpend: cents(campaigns.reduce((n, c) => n + c.recentDaily, 0)),
      recentSpendWindowDays: SPEND_WINDOW_DAYS,
      lifetimeSpend: cents(campaigns.reduce((n, c) => n + c.spent, 0)),
      campaigns: rows,
      ...(campaigns.length > MAX_CAMPAIGN_ROWS
        ? {
            truncated: `showing the top ${MAX_CAMPAIGN_ROWS} of ${campaigns.length} by lifetime spend`,
          }
        : {}),
      note: "dailyBudget is what Meta is configured to spend per day; it is unrelated to the client's contracted budget on the Notion board (see get_budget_pacing). A campaign with a daily budget but no recent spend is not delivering — check its ad account status with list_accounts.",
    };
  },
};

/** Notion contract budget, pacing against target, and burn-out forecasting. */
export const budgetTools: AgentTool[] = [getBudgetPacing, listBudgetRisks, getCampaignBudgets];
