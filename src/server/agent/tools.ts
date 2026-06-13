import { fetchClients, fetchClientDetail } from "@/server/fns/clients";
import { fetchOverview, searchEntities } from "@/server/fns/dashboard";
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
      "List all clients with their status and how many ad accounts each has. Use to discover or disambiguate client names.",
    input_schema: { type: "object", properties: {} },
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
      const clients = await fetchClients();
      return clients.map((c) => ({ name: c.name, status: c.status, accounts: c.accountCount }));
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
        accounts: detail.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          source: a.source,
          inThisBM: a.hasData,
          spend: a.spend,
          ctr: a.ctr,
          cpc: a.cpc,
        })),
        // Bound tokens: campaigns are spend-sorted, keep the top 25.
        campaigns: detail.campaigns.slice(0, 25),
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
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
