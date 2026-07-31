import { createServerFn } from "@tanstack/react-start";
import {
  exportCsv,
  fetchAccount,
  fetchAccountOptions,
  fetchAccounts,
  fetchBreakdowns,
  fetchBusinessSummary,
  fetchAdSetAds,
  fetchCampaigns,
  fetchCampaignOptions,
  fetchCreatives,
  fetchOverview,
  searchEntities,
  type CsvKind,
} from "@/server/fns/dashboard";
import { getClientRow, effectiveAccountIds } from "@/sync/jobs/clients";
import { resolveWindow, type RangeSpec } from "@/lib/range";

export const listAccounts = createServerFn({ method: "GET" })
  .inputValidator((spec: RangeSpec) => spec)
  .handler(({ data }) => fetchAccounts(resolveWindow(data)));

export const getOverview = createServerFn({ method: "GET" })
  .inputValidator((spec: RangeSpec) => spec)
  .handler(({ data }) => fetchOverview(resolveWindow(data)));

export const listCampaigns = createServerFn({ method: "GET" })
  .inputValidator((spec: RangeSpec) => spec)
  .handler(({ data }) => fetchCampaigns(resolveWindow(data)));

export const getAccount = createServerFn({ method: "GET" })
  .inputValidator((input: { id: string } & RangeSpec) => input)
  .handler(({ data }) => fetchAccount(data.id, resolveWindow(data)));

export const listCreatives = createServerFn({ method: "GET" })
  .inputValidator((spec: RangeSpec) => spec)
  .handler(({ data }) => fetchCreatives(resolveWindow(data)));

export const getBreakdowns = createServerFn({ method: "GET" })
  .inputValidator(
    (input: RangeSpec & { clientId?: string; campaignId?: string; accountIds?: string[] }) => input,
  )
  .handler(async ({ data }) => {
    const w = resolveWindow(data);
    if (data.campaignId) return fetchBreakdowns(w, { campaignId: data.campaignId });
    if (data.clientId) {
      const row = await getClientRow(data.clientId);
      return fetchBreakdowns(w, { accountIds: row ? effectiveAccountIds(row) : [] });
    }
    if (data.accountIds && data.accountIds.length > 0)
      return fetchBreakdowns(w, { accountIds: data.accountIds });
    return fetchBreakdowns(w);
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
  .inputValidator((input: { kind: CsvKind } & RangeSpec) => input)
  .handler(({ data }) => exportCsv(data.kind, resolveWindow(data)));

/** Ads for one ad set, fetched on drill-down (the campaign list omits ads to keep it light). */
export const getAdSetAds = createServerFn({ method: "GET" })
  .inputValidator((input: { adSetId: string } & RangeSpec) => input)
  .handler(({ data }) => fetchAdSetAds(data.adSetId, resolveWindow(data)));
