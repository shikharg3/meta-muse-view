import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/clients";
import type { RangeSpec } from "@/lib/range";

export const listClients = createServerFn({ method: "GET" }).handler(() =>
  ops.listClients.run(undefined),
);

export const getClientFilterOptions = createServerFn({ method: "GET" }).handler(() =>
  ops.getClientFilterOptions.run(undefined),
);

export const getClientCampaigns = createServerFn({ method: "GET" })
  .inputValidator((clientId: string) => clientId)
  .handler(({ data }) => ops.getClientCampaigns.run(data));

export const getClientDetail = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string } & RangeSpec) => d)
  .handler(({ data }) => ops.getClientDetail.run(data));

export const getClientBudgets = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(({ data }) => ops.getClientBudgets.run(data));

export const mutateClientAccounts = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; action: "add" | "remove"; accountId: string }) => d)
  .handler(({ data }) => ops.mutateClientAccounts.run(data));

export const getCampaignOverrides = createServerFn({ method: "GET" }).handler(() =>
  ops.getCampaignOverrides.run(undefined),
);

/** Move a campaign to another client, or pass clientId=null to restore automatic attribution. */
export const moveCampaignToClient = createServerFn({ method: "POST" })
  .inputValidator((d: { campaignId: string; clientId: string | null }) => d)
  .handler(({ data }) => ops.moveCampaignToClient.run(data));
