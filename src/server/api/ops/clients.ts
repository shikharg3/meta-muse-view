import { z } from "zod";
import { resolveWindow } from "@/lib/range";
import {
  fetchClientBudgets,
  fetchClientCampaigns,
  fetchClientDetail,
  fetchClients,
  fetchClientFilterOptions,
  listCampaignOverrides,
  setCampaignClient,
  updateClientAccounts,
} from "@/server/fns/clients";
import { defineOp, scalarString } from "../registry";
import { rangeSpec } from "../schemas";

/**
 * Client-book ops.
 *
 * The six reads carry no authorisation check, matching today's behaviour — the cookie gate was the
 * only thing in front of them. The two writes are admin-only, but the check lives in the delegates
 * and *returns* `{ok:false,error:"Admins only."}` rather than throwing; the UI renders that string,
 * so the op must not promote it to an HTTP error.
 *
 * `getClientDetail`'s window resolution moved here from `src/lib/api/clients.ts`, which is being
 * deleted: without it the delegate would receive a `RangeSpec` where it expects a `DateWindow`.
 */

export const listClients = defineOp({
  name: "listClients",
  mode: "read",
  handler: () => fetchClients(),
});

export const getClientFilterOptions = defineOp({
  name: "getClientFilterOptions",
  mode: "read",
  handler: () => fetchClientFilterOptions(),
});

export const getClientCampaigns = defineOp({
  name: "getClientCampaigns",
  mode: "read",
  input: scalarString,
  handler: (clientId) => fetchClientCampaigns(clientId),
});

export const getClientDetail = defineOp({
  name: "getClientDetail",
  mode: "read",
  input: rangeSpec.extend({ id: z.string().min(1) }),
  handler: (input) => fetchClientDetail(input.id, resolveWindow(input)),
});

export const getClientBudgets = defineOp({
  name: "getClientBudgets",
  mode: "read",
  input: scalarString,
  handler: (clientId) => fetchClientBudgets(clientId),
});

export const getCampaignOverrides = defineOp({
  name: "getCampaignOverrides",
  mode: "read",
  handler: () => listCampaignOverrides(),
});

export const mutateClientAccounts = defineOp({
  name: "mutateClientAccounts",
  mode: "write",
  input: z.object({
    id: z.string().min(1),
    action: z.enum(["add", "remove"]),
    accountId: z.string().min(1),
  }),
  handler: (input) => updateClientAccounts(input.id, input.action, input.accountId),
});

/** `clientId: null` is meaningful — it drops the override and restores automatic attribution. */
export const moveCampaignToClient = defineOp({
  name: "moveCampaignToClient",
  mode: "write",
  input: z.object({
    campaignId: z.string().min(1),
    clientId: z.string().min(1).nullable(),
  }),
  handler: (input) => setCampaignClient(input.campaignId, input.clientId),
});
