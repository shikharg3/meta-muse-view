import { fetchClientsRanked, fetchClientDetail, type ClientDetail } from "@/server/fns/clients";
import { unassignedSpendSummary } from "@/sync/alerts";
import { WINDOW_PROPS, isResolveError, resolveClient, toolWindow, type AgentTool } from "./kit";

/** Notion contract budget + burn-down, computed by `fetchClientDetail` and previously discarded. */
const budgetBlock = (b: ClientDetail["budget"]) =>
  b
    ? {
        budget: {
          total: b.total,
          spent: b.spent,
          remaining: b.remaining,
          startDate: b.startDate,
          plannedEndDate: b.plannedEndDate,
          projectedEndDate: b.projectedEndDate,
          dailyPace: b.dailyPace,
          daysRemaining: b.daysRemaining,
          forecastReason: b.forecastReason,
        },
      }
    : {};

export const listClients: AgentTool = {
  label: "clients",
  definition: {
    name: "list_clients",
    description:
      "List all clients with their Notion board status (the `status` field — e.g. Live, Paused, Full Budget Finished — is the client's status on the Notion campaigns board), ad-account count, plus spend and objective-aware results over the window (default last 30 days), sorted by spend (highest first). Use this single call to answer ranking questions like 'which client spent/performed the most/least' — do NOT call get_client_stats for every client.",
    input_schema: { type: "object", properties: { ...WINDOW_PROPS } },
  },
  async run(input) {
    const [clients, unassigned] = await Promise.all([
      fetchClientsRanked(toolWindow(input)).then((cs) => cs.filter((c) => c.removedAt == null)),
      unassignedSpendSummary(),
    ]);
    const rows = clients.map((c) => ({
      name: c.name,
      status: c.status,
      accounts: c.accountCount,
      spend: c.spend,
      results: c.results,
      resultLabel: c.resultLabel,
    }));
    // Spend excluded from EVERY row above. Silence here would make the list look complete.
    if (unassigned.count === 0) return rows;
    return {
      clients: rows,
      unassignedNote:
        `${unassigned.count} campaign(s) on shared ad accounts ($${unassigned.spend.toFixed(2)}) ` +
        `are not assigned to any client, so their spend is excluded from every figure above: ` +
        `${unassigned.items.map((i) => `${i.campaign} ($${i.spend.toFixed(2)}, claimed by ${i.claimants.map((c) => c.name).join(" and ")})`).join("; ")}. ` +
        `Mention this when reporting totals; assign_campaign_client can fix it.`,
    };
  },
};

export const getClientStats: AgentTool = {
  label: "client stats",
  definition: {
    name: "get_client_stats",
    description:
      "Performance for one client (or ONE of its Notion campaigns/brands): overall KPIs (spend, impressions, clicks, CTR, CPC); the Notion CONTRACT BUDGET with burn-down (total, spent, remaining, dailyPace, daysRemaining, projectedEndDate — use this for 'when does X's budget run out' / 'is X pacing correctly'); a per-account breakdown where each account carries its Meta `status` (ACTIVE or DISABLED) and `disableReason`; and their Meta campaigns (status, spend, CTR, CPC, results). The client-level `status` is the Notion board status. `client` is fuzzy-matched by client name OR by a Notion campaign/brand name grouped under it (e.g. 'Lucky Rebel', 'Farside'). When matched by brand and that Notion row has its own ad accounts, figures are AUTOMATICALLY scoped to just that campaign's accounts (result carries `matchedBrand` + `brandNote` — relay the note); if the row has no accounts, figures cover the whole client and the brandNote says so.",
    input_schema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          description: "Client name or partial name, e.g. 'Wild' or 'Playw3'.",
        },
        ...WINDOW_PROPS,
      },
      required: ["client"],
    },
  },
  async run(input) {
    const resolved = await resolveClient(String(input.client ?? ""));
    if (isResolveError(resolved)) return resolved;
    const scoped = resolved.brandAccountIds ?? [];
    const detail = await fetchClientDetail(resolved.id, toolWindow(input), { accountIds: scoped });
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
      ...budgetBlock(detail.budget),
      ...(detail.unattributed.campaigns.length > 0
        ? {
            unattributedNote:
              `${detail.unattributed.campaigns.length} campaign(s) on this client's SHARED ad ` +
              `accounts ($${detail.unattributed.spend.toFixed(2)}) could not be attributed to any ` +
              `client and are EXCLUDED from the figures above: ` +
              `${detail.unattributed.campaigns.map((c) => c.name).join(", ")}. Mention this; ` +
              `assign_campaign_client can attach them.`,
          }
        : {}),
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
  },
};
