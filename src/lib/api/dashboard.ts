import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/dashboard";
import type { CsvKind } from "@/server/fns/dashboard";
import type { RangeSpec } from "@/lib/range";

export const listAccounts = createServerFn({ method: "GET" })
  .inputValidator((spec: RangeSpec) => spec)
  .handler(({ data }) => ops.listAccounts.run(data));

export const getOverview = createServerFn({ method: "GET" })
  .inputValidator((spec: RangeSpec) => spec)
  .handler(({ data }) => ops.getOverview.run(data));

export const listCampaigns = createServerFn({ method: "GET" })
  .inputValidator((spec: RangeSpec) => spec)
  .handler(({ data }) => ops.listCampaigns.run(data));

export const getAccount = createServerFn({ method: "GET" })
  .inputValidator((input: { id: string } & RangeSpec) => input)
  .handler(({ data }) => ops.getAccount.run(data));

export const getBreakdowns = createServerFn({ method: "GET" })
  .inputValidator(
    (input: RangeSpec & { clientId?: string; campaignId?: string; accountIds?: string[] }) => input,
  )
  .handler(({ data }) => ops.getBreakdowns.run(data));

export const getCampaignOptions = createServerFn({ method: "GET" })
  .inputValidator((input: { clientId: string }) => input)
  .handler(({ data }) => ops.getCampaignOptions.run(data));

export const getBusinessSummary = createServerFn({ method: "GET" }).handler(() =>
  ops.getBusinessSummary.run(undefined),
);

export const getAccountOptions = createServerFn({ method: "GET" }).handler(() =>
  ops.getAccountOptions.run(undefined),
);

export const runSearch = createServerFn({ method: "GET" })
  .inputValidator((q: string) => q)
  .handler(({ data }) => ops.runSearch.run(data));

export const getExportCsv = createServerFn({ method: "GET" })
  .inputValidator((input: { kind: CsvKind } & RangeSpec) => input)
  .handler(({ data }) => ops.getExportCsv.run(data));

/** Ads for one ad set, fetched on drill-down (the campaign list omits ads to keep it light). */
export const getAdSetAds = createServerFn({ method: "GET" })
  .inputValidator((input: { adSetId: string } & RangeSpec) => input)
  .handler(({ data }) => ops.getAdSetAds.run(data));
