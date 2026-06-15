import { createServerFn } from "@tanstack/react-start";
import {
  exportCsv,
  fetchAccount,
  fetchAccountOptions,
  fetchAccounts,
  fetchBreakdowns,
  fetchBusinessSummary,
  fetchCampaigns,
  fetchCampaignOptions,
  fetchCreatives,
  fetchOverview,
  searchEntities,
  type CsvKind,
} from "@/server/fns/dashboard";
import { getClientRow, effectiveAccountIds } from "@/sync/jobs/clients";

export const listAccounts = createServerFn({ method: "GET" })
  .inputValidator((days: number) => days)
  .handler(({ data }) => fetchAccounts(data));

export const getOverview = createServerFn({ method: "GET" })
  .inputValidator((days: number) => days)
  .handler(({ data }) => fetchOverview(data));

export const listCampaigns = createServerFn({ method: "GET" })
  .inputValidator((days: number) => days)
  .handler(({ data }) => fetchCampaigns(data));

export const getAccount = createServerFn({ method: "GET" })
  .inputValidator((input: { id: string; days: number }) => input)
  .handler(({ data }) => fetchAccount(data.id, data.days));

export const listCreatives = createServerFn({ method: "GET" })
  .inputValidator((days: number) => days)
  .handler(({ data }) => fetchCreatives(data));

export const getBreakdowns = createServerFn({ method: "GET" })
  .inputValidator((input: { days: number; clientId?: string; campaignId?: string }) => input)
  .handler(async ({ data }) => {
    if (data.campaignId) return fetchBreakdowns(data.days, { campaignId: data.campaignId });
    if (data.clientId) {
      const row = await getClientRow(data.clientId);
      return fetchBreakdowns(data.days, { accountIds: row ? effectiveAccountIds(row) : [] });
    }
    return fetchBreakdowns(data.days);
  });

export const getCampaignOptions = createServerFn({ method: "GET" })
  .inputValidator((input: { clientId: string }) => input)
  .handler(async ({ data }) => {
    const row = await getClientRow(data.clientId);
    return fetchCampaignOptions(row ? effectiveAccountIds(row) : []);
  });

export const getBusinessSummary = createServerFn({ method: "GET" }).handler(() =>
  fetchBusinessSummary(),
);

export const getAccountOptions = createServerFn({ method: "GET" }).handler(() =>
  fetchAccountOptions(),
);

export const runSearch = createServerFn({ method: "GET" })
  .inputValidator((q: string) => q)
  .handler(({ data }) => searchEntities(data));

export const getExportCsv = createServerFn({ method: "GET" })
  .inputValidator((input: { kind: CsvKind; days: number }) => input)
  .handler(({ data }) => exportCsv(data.kind, data.days));
