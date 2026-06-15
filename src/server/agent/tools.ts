import { fetchClients, fetchClientsRanked, fetchClientDetail } from "@/server/fns/clients";
import { fetchOverview, searchEntities } from "@/server/fns/dashboard";
import { getClientRow, effectiveAccountIds } from "@/sync/jobs/clients";
import { runReport, resolveRange, normalizeColumns, normalizeBreakdown } from "./report";
import type { AnthropicTool } from "./anthropic";

// Insights are only backfilled ~90 days; clamp so the model can't ask beyond data.
const MAX_DAYS = 90;
function clampDays(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, MAX_DAYS);
}

export const TOOLS: AnthropicTool[] = [
  {
    name: "list_clients",
    description:
      "List all clients with status, ad-account count, spend, and objective-aware results over the last N days (default 30), sorted by spend (highest first). Use this single call to answer ranking questions like 'which client spent/performed the most/least' — do NOT call get_client_stats for every client.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description: "Trailing window in days for spend/results (default 30, max 90).",
        },
      },
    },
  },
  {
    name: "get_client_stats",
    description:
      "Performance for one client across every ad account they've ever used: overall KPIs (spend, impressions, clicks, CTR, CPC), per-account breakdown, and their campaigns (status, spend, CTR, CPC, results). The client name is fuzzy-matched.",
    input_schema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          description: "Client name or partial name, e.g. 'Wild' or 'Playw3'.",
        },
        days: { type: "integer", description: "Trailing window in days (default 30, max 90)." },
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
        days: { type: "integer", description: "Trailing window in days (default 30, max 90)." },
      },
    },
  },
  {
    name: "search_entities",
    description:
      "Find ad accounts and campaigns by name or id substring. Use when the question is about a specific campaign or account rather than a client.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
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
            "Metrics in order. Allowed: spend, impressions, reach, clicks, link_clicks, ctr, cpc, cpm, frequency, results, cost_per_result, conversions, conversion_value, roas. Defaults to spend, impressions, ctr, cpc, results.",
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
}
export interface ResolveError {
  error: string;
  candidates?: string[];
}

/** Fuzzy-resolve a client name/id to a single client, or return candidates to disambiguate. */
export async function resolveClient(query: string): Promise<ResolvedClient | ResolveError> {
  const clients = await fetchClients();
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
  return {
    error: `No client matches "${query}".`,
    candidates: clients.map((c) => c.name).slice(0, 20),
  };
}

/** Execute a tool by name; always resolves (errors are returned as data for the model). */
export async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_clients": {
      const clients = await fetchClientsRanked(clampDays(input.days));
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
      const detail = await fetchClientDetail(resolved.id, clampDays(input.days));
      if (!detail) return { error: `Client "${resolved.name}" has no data.` };
      return {
        client: detail.name,
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
      const o = await fetchOverview(clampDays(input.days));
      return {
        kpis: o.kpis,
        deltas: o.deltas,
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
    case "search_entities":
      return await searchEntities(String(input.query ?? ""));
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
