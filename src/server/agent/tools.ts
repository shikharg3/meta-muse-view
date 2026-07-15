import {
  fetchClients,
  fetchClientsRanked,
  fetchClientDetail,
  fetchAccountDirectory,
  fetchActiveCampaigns,
} from "@/server/fns/clients";
import {
  fetchOverview,
  fetchOverviewEvents,
  searchEntities,
  fetchAdEntities,
  resolveAdScopeSubject,
  type AdScope,
} from "@/server/fns/dashboard";
import { getClientRow, effectiveAccountIds } from "@/sync/jobs/clients";
import { runReport, resolveRange, normalizeColumns, normalizeBreakdown } from "./report";
import type { AnthropicTool } from "./anthropic";
import { windowFromDays, windowFromDates, isYmd, type DateWindow } from "@/lib/range";

// Insights are only backfilled ~90 days; clamp so the model can't ask beyond data.
const MAX_DAYS = 90;
function clampDays(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, MAX_DAYS);
}

/**
 * Window for the aggregate tools. `days` is a TRAILING window ending today (days=1 = today only),
 * so it can't express a specific past day. When both `since` and `until` are valid YYYY-MM-DD it
 * takes precedence — the model passes since=until=<date> for a single day (e.g. yesterday).
 */
function toolWindow(input: Record<string, unknown>): DateWindow {
  if (isYmd(input.since) && isYmd(input.until)) {
    return windowFromDates(String(input.since), String(input.until));
  }
  return windowFromDays(clampDays(input.days));
}

export const TOOLS: AnthropicTool[] = [
  {
    name: "list_clients",
    description:
      "List all clients with their Notion board status (the `status` field — e.g. Live, Paused, Full Budget Finished — is the client's status on the Notion campaigns board), ad-account count, spend, and objective-aware results over the last N days (default 30), sorted by spend (highest first). Use this single call to answer ranking questions like 'which client spent/performed the most/least' — do NOT call get_client_stats for every client.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description:
            "Trailing window ending TODAY (default 30, max 90). days=1 = today only — for a specific past day use since+until instead.",
        },
        since: {
          type: "string",
          description:
            "Start date YYYY-MM-DD. Provide with `until` for a specific day or range (yesterday = since=until=that date). Takes precedence over days.",
        },
        until: { type: "string", description: "End date YYYY-MM-DD inclusive (use with since)." },
      },
    },
  },
  {
    name: "get_client_stats",
    description:
      "Performance for one client (or ONE of its Notion campaigns/brands): overall KPIs (spend, impressions, clicks, CTR, CPC); a per-account breakdown where each account carries its Meta `status` (ACTIVE or DISABLED) and `disableReason`; and their Meta campaigns (status, spend, CTR, CPC, results). The client-level `status` is the Notion board status. `client` is fuzzy-matched by client name OR by a Notion campaign/brand name grouped under it (e.g. 'Lucky Rebel', 'Farside'). When matched by brand and that Notion row has its own ad accounts, figures are AUTOMATICALLY scoped to just that campaign's accounts (result carries `matchedBrand` + `brandNote` — relay the note); if the row has no accounts, figures cover the whole client and the brandNote says so.",
    input_schema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          description: "Client name or partial name, e.g. 'Wild' or 'Playw3'.",
        },
        days: {
          type: "integer",
          description:
            "Trailing window ending TODAY (default 30, max 90). days=1 = today only — for a specific past day use since+until.",
        },
        since: {
          type: "string",
          description: "Start date YYYY-MM-DD (yesterday = since=until=that date); overrides days.",
        },
        until: { type: "string", description: "End date YYYY-MM-DD inclusive (use with since)." },
      },
      required: ["client"],
    },
  },
  {
    name: "get_overview",
    description:
      "Business-wide performance across all accounts: total KPIs, period-over-period deltas, and the top accounts and campaigns by spend.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description:
            "Trailing window ending TODAY (default 30, max 90). days=1 = today only — for a specific past day use since+until.",
        },
        since: {
          type: "string",
          description: "Start date YYYY-MM-DD (yesterday = since=until=that date); overrides days.",
        },
        until: { type: "string", description: "End date YYYY-MM-DD inclusive (use with since)." },
      },
    },
  },
  {
    name: "list_active_campaigns",
    description:
      "Full breakdown of EVERY campaign that spent more than $0 over the window (default last 30 days; for a specific day such as yesterday pass since=until=that date), sorted by spend. Each row carries: owning ad account and its Meta account status (ACTIVE / PAUSED / DISABLED = suspended, with reason), owning client, campaign status, spend, dailyAvgSpend (spend ÷ days), dailyBudget (the daily TARGET budget in $ — campaign CBO budget or summed active ad-set budgets), impressions, clicks, CTR, CPC, objective results, and `events` (the FULL de-duplicated conversion breakdown: purchases, registrations, leads, …). Use this for ANY request to break down / summarize the active (spending) campaigns — it returns everything in ONE call. NEVER loop get_client_stats per client to assemble this; unlike get_overview (top few only), this returns them ALL.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description:
            "Trailing window ending TODAY (default 30, max 90). days=1 = today only — for a specific past day use since+until.",
        },
        since: {
          type: "string",
          description: "Start date YYYY-MM-DD (yesterday = since=until=that date); overrides days.",
        },
        until: { type: "string", description: "End date YYYY-MM-DD inclusive (use with since)." },
      },
    },
  },
  {
    name: "search_entities",
    description:
      "Find ad accounts, campaigns, and Notion brands by name/id substring. Returns matching `accounts`, `campaigns`, and `brands` — a brand is a Notion campaign-row title mapped to the agency client that groups it (e.g. brand 'Lucky Rebel' → client 'OneAgency'). Use when a name is not itself a client and might be a specific campaign, account, or a brand grouped under an agency client.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "get_ad_sets",
    description:
      "Ad-set-level (or ad-level) performance for a client, campaign, or ad account: one row per ad set (or ad) with spend, impressions, CTR, CPC, the objective result, AND the full conversion/event breakdown for THAT ad set (purchases, leads, registrations, …). Use this for ANY question at ad-set or ad grain — e.g. per-ad-set conversions, best/worst ad sets. Advertisers often name each ad set after what it targets (commonly one US state per ad set); when the user asks 'per state' (or per whatever the ad sets are named), pass group_by_name=true to SUM ad sets that share a name across campaigns into ONE row each — that yields per-state conversions and is more reliable than the region/geo breakdown. Set level='ad' for per-ad (creative) rows.",
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
        days: {
          type: "integer",
          description:
            "Trailing window ending TODAY (default 30, max 90). For a specific day/range use since+until.",
        },
        since: {
          type: "string",
          description: "Start date YYYY-MM-DD (with until); overrides days.",
        },
        until: { type: "string", description: "End date YYYY-MM-DD inclusive (with since)." },
      },
      required: ["subject"],
    },
  },
  {
    name: "list_accounts",
    description:
      "Returns `{ mappingSyncedAt, unsyncedActiveAccounts, accounts }`. `accounts` lists EVERY ad account with its Meta status — ACTIVE, PAUSED, or DISABLED (DISABLED = suspended/disabled by Meta, with the disable reason) — the CURRENT client that owns it, that client's Notion board status (e.g. Live, Paused), and `isActiveAccount`: TRUE only when the account is the client's designated Notion 'Active Account ID' (FALSE for an 'Other ad accounts' entry or a manually-added account). When the user asks specifically about the 'Active Account ID' (and NOT 'other'/all accounts), filter to isActiveAccount=true. `unsyncedActiveAccounts` lists designated Active Account IDs (per live client) that our Meta token CANNOT see (not assigned to the system user), so there is NO status for them — report these as 'active account not in synced data / needs assigning to the Meta token', never as active or disabled. Each DISABLED account also carries `disabledSince` (YYYY-MM-DD; null if not captured). `mappingSyncedAt` is when the Notion mapping was last refreshed — if the user says they just edited Notion, WARN that later changes aren't reflected (Sync now). Use for any suspended/disabled question, when they were disabled, or to cross-reference Notion client status vs account suspension (e.g. 'which Live clients have a disabled Active Account ID'). All accounts in one call; never loop.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "generate_report",
    description:
      "Generate a downloadable CSV/PDF performance report from the Meta Ads API for a client or ad account. Use for the /reports command or any request to 'generate/export/download a report'. Pull data live from Meta. Ask the user for missing details before calling: a report REQUIRES a subject (client or account) and a date range. Columns and breakdown are optional.",
    input_schema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description: "Client or ad-account name, e.g. 'PlayW3'. Fuzzy-matched.",
        },
        days: {
          type: "integer",
          description: "Trailing window in days (e.g. 7). Use this OR since+until.",
        },
        since: { type: "string", description: "Start date YYYY-MM-DD (with until)." },
        until: { type: "string", description: "End date YYYY-MM-DD (with since)." },
        columns: {
          type: "array",
          items: { type: "string" },
          description:
            "Metrics in order. Allowed: spend, impressions, reach, clicks, link_clicks, ctr, cpc, cpm, frequency, results, cost_per_result, conversions, conversion_value, roas, registrations, leads, initiate_checkout, purchases, landing_page_views, cost_per_registration, cost_per_lead, cost_per_purchase. Defaults to spend, impressions, ctr, cpc, results.",
        },
        breakdown: {
          type: "string",
          enum: ["none", "day", "platform", "placement", "age", "gender", "country", "region"],
          description:
            "Row breakdown dimension. 'day' = one row per day. Default none (single total row).",
        },
      },
      required: ["subject"],
    },
  },
];

export interface ResolvedClient {
  id: string;
  name: string;
  /** Set when resolved by a Notion campaign-row (brand) title rather than the client's own name. */
  matchedBrand?: string;
  /** Other brands grouped under this (agency) client — lets the model add a per-brand caveat. */
  siblingBrands?: string[];
  /** The matched brand row's OWN ad accounts (∩ the client's effective accounts) — lets stats be
   * scoped to just that campaign/brand instead of the whole client. Empty/absent = row carries none. */
  brandAccountIds?: string[];
}
export interface ResolveError {
  error: string;
  candidates?: string[];
}

/** Fuzzy-resolve a client name/id to a single client, or return candidates to disambiguate. */
export async function resolveClient(query: string): Promise<ResolvedClient | ResolveError> {
  const clients = (await fetchClients()).filter((c) => c.removedAt == null);
  if (clients.length === 0)
    return { error: "No clients are synced yet. Configure Notion in Settings." };
  const q = query.trim().toLowerCase();
  if (!q)
    return { error: "No client name given.", candidates: clients.map((c) => c.name).slice(0, 20) };

  const exact = clients.find((c) => c.id === q || c.name.toLowerCase() === q);
  if (exact) return { id: exact.id, name: exact.name };

  const slug = q.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const matches = clients.filter((c) => c.name.toLowerCase().includes(q) || c.id.includes(slug));
  if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
  if (matches.length > 1)
    return {
      error: `Multiple clients match "${query}". Ask the user which one.`,
      candidates: matches.map((m) => m.name).slice(0, 10),
    };

  // No client-NAME match: fall back to Notion brand (campaign-row) titles. Agency clients group
  // several brands under one name (e.g. brand "Lucky Rebel" lives under client "OneAgency"), so a
  // brand query must resolve to its holding client instead of dead-ending as "no client".
  const findBrandHits = (match: (b: string) => boolean) => {
    const hits: { id: string; name: string; brand: string; brands: string[] }[] = [];
    for (const c of clients) {
      const brand = c.brands.find(match);
      if (brand) hits.push({ id: c.id, name: c.name, brand, brands: c.brands });
    }
    return hits;
  };
  // Match punctuation/spacing-insensitively so "LuckyRebel" finds the brand "Lucky Rebel".
  const nq = q.replace(/[^a-z0-9]+/g, "");
  const bnorm = (b: string) => b.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const exactBrands = findBrandHits((b) => b.toLowerCase() === q || (nq !== "" && bnorm(b) === nq));
  const brandHits = exactBrands.length
    ? exactBrands
    : findBrandHits((b) => b.toLowerCase().includes(q) || (nq !== "" && bnorm(b).includes(nq)));
  if (brandHits.length === 1) {
    const h = brandHits[0];
    // Scope to the matched row's own accounts: pages in clients.raw carry per-row accountIds.
    const row = await getClientRow(h.id);
    const effective = new Set(row ? effectiveAccountIds(row) : []);
    const bn = bnorm(h.brand);
    const pages = (row?.raw as { title?: string; accountIds?: string[] }[] | null) ?? [];
    const brandAccountIds = [
      ...new Set(
        pages
          .filter((p) => typeof p.title === "string" && bnorm(p.title) === bn)
          .flatMap((p) => p.accountIds ?? [])
          .filter((a) => effective.has(a)),
      ),
    ];
    return {
      id: h.id,
      name: h.name,
      matchedBrand: h.brand,
      siblingBrands: h.brands.filter((b) => b !== h.brand),
      ...(brandAccountIds.length ? { brandAccountIds } : {}),
    };
  }
  if (brandHits.length > 1)
    return {
      error: `"${query}" matches brands under multiple clients. Ask the user which client.`,
      candidates: brandHits.map((h) => `${h.brand} → ${h.name}`).slice(0, 10),
    };
  return {
    error: `No client matches "${query}".`,
    candidates: clients.map((c) => c.name).slice(0, 20),
  };
}

/** Execute a tool by name; always resolves (errors are returned as data for the model). */
export async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_clients": {
      const clients = (await fetchClientsRanked(toolWindow(input))).filter(
        (c) => c.removedAt == null,
      );
      return clients.map((c) => ({
        name: c.name,
        status: c.status,
        accounts: c.accountCount,
        spend: c.spend,
        results: c.results,
        resultLabel: c.resultLabel,
      }));
    }
    case "get_client_stats": {
      const resolved = await resolveClient(String(input.client ?? ""));
      if ("error" in resolved) return resolved;
      const scoped = resolved.brandAccountIds ?? [];
      const detail = await fetchClientDetail(resolved.id, toolWindow(input), {
        accountIds: scoped,
      });
      if (!detail) return { error: `Client "${resolved.name}" has no data.` };
      return {
        client: detail.name,
        ...(resolved.matchedBrand
          ? {
              matchedBrand: resolved.matchedBrand,
              brandNote: scoped.length
                ? `Figures are scoped to "${resolved.matchedBrand}"'s own ad account(s) (${scoped.join(", ")}) under client "${detail.name}" — NOT the whole client${resolved.siblingBrands?.length ? ` (other campaigns: ${resolved.siblingBrands.join(", ")})` : ""}.`
                : `"${resolved.matchedBrand}" is grouped under agency client "${detail.name}"${resolved.siblingBrands?.length ? ` (alongside ${resolved.siblingBrands.join(", ")})` : ""} and its Notion row carries no ad accounts of its own, so figures below are for the whole client.`,
            }
          : {}),
        status: detail.status,
        kpis: detail.kpis,
        events: detail.events,
        accounts: detail.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          source: a.source,
          inThisBM: a.hasData,
          spend: a.spend,
          ctr: a.ctr,
          cpc: a.cpc,
          status: a.status,
          disableReason: a.disableReason,
          amountSpent: a.amountSpent,
        })),
        // Bound tokens: spend-sorted, top 25, compact (drop the ad-set/ad tree).
        campaigns: detail.campaigns.slice(0, 25).map((c) => ({
          name: c.name,
          status: c.status,
          objective: c.objective,
          spend: c.spend,
          ctr: c.ctr,
          cpc: c.cpc,
          results: c.results,
          resultLabel: c.resultLabel,
        })),
      };
    }
    case "get_overview": {
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
    }
    case "list_active_campaigns":
      return await fetchActiveCampaigns(toolWindow(input));
    case "search_entities":
      return await searchEntities(String(input.query ?? ""));
    case "get_ad_sets":
      return await getAdSetsTool(input);
    case "list_accounts":
      return await fetchAccountDirectory();
    case "generate_report":
      return await generateReportTool(input);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/** Resolve a subject string to a client (preferred) or single ad account. */
type SubjectResolution = { name: string; accountIds: string[] } | ResolveError;
async function resolveSubject(subject: string): Promise<SubjectResolution> {
  const s = subject.trim();
  if (!s) return { error: "Which client or ad account?" };
  const client = await resolveClient(s);
  if (!("error" in client)) {
    const row = await getClientRow(client.id);
    return { name: client.name, accountIds: row ? effectiveAccountIds(row) : [] };
  }
  const ents = await searchEntities(s);
  if (ents.accounts.length === 1)
    return { name: ents.accounts[0].name, accountIds: [ents.accounts[0].id] };
  if (ents.accounts.length > 1)
    return {
      error: `Multiple accounts match "${s}". Ask the user which one.`,
      candidates: ents.accounts.map((a) => a.name).slice(0, 10),
    };
  return client; // client-resolution error + candidates
}

/** Resolve an ad-set/ad subject to a scope: a client's accounts, or one campaign/account. */
async function resolveAdScope(
  subject: string,
): Promise<{ scope: AdScope; label: string } | ResolveError> {
  const s = subject.trim();
  if (!s) return { error: "Which client, campaign, or ad account?" };
  const client = await resolveClient(s);
  if (!("error" in client)) {
    // A brand match scopes to that row's own accounts (when it has any), not the whole client.
    if (client.brandAccountIds?.length)
      return {
        scope: { accountIds: client.brandAccountIds },
        label: `${client.matchedBrand} (its own accounts, under client ${client.name})`,
      };
    const row = await getClientRow(client.id);
    return {
      scope: { accountIds: row ? effectiveAccountIds(row) : [] },
      label: client.matchedBrand
        ? `${client.matchedBrand} (under client ${client.name})`
        : `client ${client.name}`,
    };
  }
  const found = await resolveAdScopeSubject(s);
  if (found && "scope" in found) return found;
  if (found)
    return {
      error: `"${subject}" matches multiple campaigns/accounts. Ask the user which one.`,
      candidates: found.candidates,
    };
  return client; // client-resolution error + candidates
}

async function getAdSetsTool(input: Record<string, unknown>): Promise<unknown> {
  const resolved = await resolveAdScope(String(input.subject ?? ""));
  if ("error" in resolved) return resolved;
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
}

/**
 * Resolve a report request, validate the date range, normalize columns/breakdown,
 * then pull live from Meta. Missing/ambiguous inputs return error data so the
 * model can ask the user.
 */
async function generateReportTool(input: Record<string, unknown>): Promise<unknown> {
  const subject = await resolveSubject(String(input.subject ?? ""));
  if ("error" in subject) return subject;
  const range = resolveRange(input);
  if (!range)
    return { error: "What date range? e.g. 'last 7 days' or specific since/until dates." };
  return await runReport({
    name: subject.name,
    accountIds: subject.accountIds,
    since: range.since,
    until: range.until,
    columns: normalizeColumns(Array.isArray(input.columns) ? input.columns.map(String) : []),
    breakdown: normalizeBreakdown(input.breakdown),
  });
}
