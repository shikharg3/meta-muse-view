import { createServerFn } from "@tanstack/react-start";
import {
  fetchClients,
  fetchClientDetail,
  updateClientAccounts,
  fetchClientBudgets,
  fetchClientFilterOptions,
  fetchClientCampaigns,
  setCampaignClient,
  listCampaignOverrides,
} from "@/server/fns/clients";
import { resolveWindow, type RangeSpec } from "@/lib/range";

export const listClients = createServerFn({ method: "GET" }).handler(() => fetchClients());

export const getClientFilterOptions = createServerFn({ method: "GET" }).handler(() =>
  fetchClientFilterOptions(),
);

export const getClientCampaigns = createServerFn({ method: "GET" })
  .inputValidator((clientId: string) => clientId)
  .handler(({ data }) => fetchClientCampaigns(data));

export const getClientDetail = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string } & RangeSpec) => d)
  .handler(({ data }) => fetchClientDetail(data.id, resolveWindow(data)));

export const getClientBudgets = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(({ data }) => fetchClientBudgets(data));

export const mutateClientAccounts = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; action: "add" | "remove"; accountId: string }) => d)
  .handler(({ data }) => updateClientAccounts(data.id, data.action, data.accountId));

export const getCampaignOverrides = createServerFn({ method: "GET" }).handler(() =>
  listCampaignOverrides(),
);

/** Move a campaign to another client, or pass clientId=null to restore automatic attribution. */
export const moveCampaignToClient = createServerFn({ method: "POST" })
  .inputValidator((d: { campaignId: string; clientId: string | null }) => d)
  .handler(({ data }) => setCampaignClient(data.campaignId, data.clientId));
