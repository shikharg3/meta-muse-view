import {
  fetchOverview,
  fetchOverviewEvents,
  searchEntities,
  fetchAdEntities,
} from "@/server/fns/dashboard";
import { fetchAccountDirectory, fetchActiveCampaigns } from "@/server/fns/clients";
import { WINDOW_PROPS, isResolveError, resolveAdScope, toolWindow, type AgentTool } from "./kit";

export const getOverview: AgentTool = {
  label: "overview",
  definition: {
    name: "get_overview",
    description:
      "Business-wide performance across all accounts: total KPIs, period-over-period deltas, the full de-duplicated conversion `events` list, and the top accounts and campaigns by spend.",
    input_schema: { type: "object", properties: { ...WINDOW_PROPS } },
  },
  async run(input) {
    const w = toolWindow(input);
    const [o, events] = await Promise.all([fetchOverview(w), fetchOverviewEvents(w)]);
    return {
      kpis: o.kpis,
      deltas: o.deltas,
      events,
      topAccounts: o.topAccounts.slice(0, 10).map((a) => ({
        name: a.name,
        spend: a.spend,
        ctr: a.ctr,
        cpc: a.cpc,
        status: a.status,
      })),
      topCampaigns: o.topCampaigns.slice(0, 10).map((c) => ({
        name: c.name,
        account: c.accountName,
        spend: c.spend,
        ctr: c.ctr,
        cpc: c.cpc,
      })),
    };
  },
};

export const listActiveCampaigns: AgentTool = {
  label: "active campaigns",
  definition: {
    name: "list_active_campaigns",
    description:
      "Full breakdown of EVERY campaign that spent more than $0 over the window (default last 30 days), sorted by spend. Each row carries: owning ad account and its Meta account status (ACTIVE / PAUSED / DISABLED = suspended, with reason), owning client, campaign status, spend, dailyAvgSpend (spend ÷ days), dailyBudget (the daily TARGET budget in $ — campaign CBO budget or summed active ad-set budgets), impressions, clicks, CTR, CPC, objective results, and `events` (the FULL de-duplicated conversion breakdown: purchases, registrations, leads, …). Use this for ANY request to break down / summarize the active (spending) campaigns — it returns everything in ONE call. NEVER loop get_client_stats per client.",
    input_schema: { type: "object", properties: { ...WINDOW_PROPS } },
  },
  run: async (input) => await fetchActiveCampaigns(toolWindow(input)),
};

export const searchEntitiesTool: AgentTool = {
  label: "search",
  definition: {
    name: "search_entities",
    description:
      "Find ad accounts, campaigns, and Notion brands by name/id substring. Returns matching `accounts`, `campaigns`, and `brands` — a brand is a Notion campaign-row title mapped to the agency client that groups it (e.g. brand 'Lucky Rebel' → client 'OneAgency'). Use when a name is not itself a client and might be a specific campaign, account, or a brand grouped under an agency client.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  run: async (input) => await searchEntities(String(input.query ?? "")),
};

export const listAccounts: AgentTool = {
  label: "accounts",
  definition: {
    name: "list_accounts",
    description:
      "Returns `{ mappingSyncedAt, unsyncedActiveAccounts, accounts }`. `accounts` lists EVERY ad account with its Meta status — ACTIVE, PAUSED, or DISABLED (DISABLED = suspended/disabled by Meta, with the disable reason and `disabledSince`) — the CURRENT client that owns it, that client's Notion board status, and `isActiveAccount`: TRUE only when the account is the client's designated Notion 'Active Account ID'. `unsyncedActiveAccounts` lists designated Active Account IDs our Meta token CANNOT see.",
    input_schema: { type: "object", properties: {} },
  },
  run: async () => await fetchAccountDirectory(),
};

export const getAdSets: AgentTool = {
  label: "ad sets",
  definition: {
    name: "get_ad_sets",
    description:
      "Ad-set-level (or ad-level) performance for a client, campaign, or ad account: one row per ad set (or ad) with spend, impressions, CTR, CPC, the objective result, AND the full conversion/event breakdown for THAT ad set. Use this for ANY question at ad-set or ad grain. Advertisers often name each ad set after what it targets (commonly one US state per ad set); when the user asks 'per state' (or per whatever the ad sets are named), pass group_by_name=true to SUM ad sets that share a name across campaigns into ONE row each — more reliable than the region/geo breakdown. Set level='ad' for per-ad (creative) rows.",
    input_schema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description:
            "Client, campaign, or ad-account name/id. Fuzzy-matched — a client resolves to all its ad sets; a campaign to just its own.",
        },
        level: {
          type: "string",
          enum: ["adset", "ad"],
          description: "Grain: 'adset' (default) or 'ad'.",
        },
        group_by_name: {
          type: "boolean",
          description:
            "Sum entities that share a name (e.g. state-named ad sets across campaigns → one row per state, with combined conversions). Default false.",
        },
        ...WINDOW_PROPS,
      },
      required: ["subject"],
    },
  },
  async run(input) {
    const resolved = await resolveAdScope(String(input.subject ?? ""));
    if (isResolveError(resolved)) return resolved;
    const level = input.level === "ad" ? "ad" : "adset";
    const groupByName = Boolean(input.group_by_name);
    const rows = await fetchAdEntities(resolved.scope, level, toolWindow(input), { groupByName });
    if (rows.length === 0)
      return {
        subject: resolved.label,
        level,
        note: `No ${level} data found for ${resolved.label} in this window.`,
      };
    return {
      subject: resolved.label,
      level,
      groupedByName: groupByName,
      count: rows.length,
      [level === "ad" ? "ads" : "adSets"]: rows.slice(0, 60),
      ...(rows.length > 60 ? { truncated: `showing top 60 of ${rows.length} by spend` } : {}),
    };
  },
};
