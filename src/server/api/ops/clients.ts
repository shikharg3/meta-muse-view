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
import { fetchClientProjects, fetchProjectMap } from "@/server/fns/client-projects";
import { defineOp, scalarString } from "../registry";
import { rangeSpec } from "../schemas";

/**
 * Client-book ops.
 *
 * The reads carry no authorisation check, matching today's behaviour — the cookie gate was the
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

/**
 * Campaigns filed under a project by hand, `campaignId → pageId`. They are stored by the Base44 app
 * (its `ProjectAssignment` entity) and sent with each read; they only regroup a client's own
 * campaigns between its own rows, so a caller can misfile nothing it could not already see.
 */
const placements = z
  .record(z.string().min(1), z.string().min(1))
  .default({})
  .transform((value) => new Map(Object.entries(value)));

/** A client's projects — one per Notion board row — each with its campaigns measured over its days. */
export const getClientProjects = defineOp({
  name: "getClientProjects",
  mode: "read",
  input: rangeSpec.extend({ id: z.string().min(1), placements }),
  handler: (input) => fetchClientProjects(input.id, resolveWindow(input), input.placements),
});

/** Every client's projects and their campaigns, without figures — for filters, cards and chips. */
export const getProjectMap = defineOp({
  name: "getProjectMap",
  mode: "read",
  input: z.object({ placements }),
  handler: (input) => fetchProjectMap(input.placements),
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
