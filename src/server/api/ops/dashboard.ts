import { z } from "zod";
import { resolveWindow } from "@/lib/range";
import {
  exportCsv,
  fetchAccount,
  fetchAccountOptions,
  fetchAccounts,
  fetchAdSetAds,
  fetchBreakdowns,
  fetchBusinessSummary,
  fetchCampaignOptions,
  fetchCampaigns,
  fetchOverview,
  searchEntities,
} from "@/server/fns/dashboard";
import { effectiveAccountIds, getClientRow } from "@/sync/jobs/clients";
import { defineOp, scalarString } from "../registry";
import { rangeSpec } from "../schemas";

/**
 * Dashboard ops.
 *
 * Note what moved: the window resolution and the client→accountIds lookup used to live in
 * `src/lib/api/dashboard.ts`, i.e. inside the TanStack transport. Deleting that frontend would
 * have deleted them, and `getBreakdowns` would have silently started returning agency-wide numbers
 * for a client-scoped request. Wrapper logic belongs in the op.
 *
 * None of these carry an authorisation check, matching today's behaviour — the cookie gate was the
 * only thing in front of them. On the HTTP transport the bearer token plus a resolvable actor is
 * the equivalent floor.
 */

export const listAccounts = defineOp({
  name: "listAccounts",
  mode: "read",
  input: rangeSpec,
  handler: (spec) => fetchAccounts(resolveWindow(spec)),
});

export const getOverview = defineOp({
  name: "getOverview",
  mode: "read",
  input: rangeSpec,
  handler: (spec) => fetchOverview(resolveWindow(spec)),
});

export const listCampaigns = defineOp({
  name: "listCampaigns",
  mode: "read",
  input: rangeSpec,
  handler: (spec) => fetchCampaigns(resolveWindow(spec)),
});

export const getAccount = defineOp({
  name: "getAccount",
  mode: "read",
  input: rangeSpec.extend({ id: z.string().min(1) }),
  handler: (input) => fetchAccount(input.id, resolveWindow(input)),
});

export const getBreakdowns = defineOp({
  name: "getBreakdowns",
  mode: "read",
  input: rangeSpec.extend({
    clientId: z.string().optional(),
    campaignId: z.string().optional(),
    accountIds: z.array(z.string()).optional(),
  }),
  handler: async (input) => {
    const w = resolveWindow(input);
    if (input.campaignId) return fetchBreakdowns(w, { campaignId: input.campaignId });
    if (input.clientId) {
      const row = await getClientRow(input.clientId);
      return fetchBreakdowns(w, { accountIds: row ? effectiveAccountIds(row) : [] });
    }
    if (input.accountIds && input.accountIds.length > 0) {
      return fetchBreakdowns(w, { accountIds: input.accountIds });
    }
    return fetchBreakdowns(w);
  },
});

export const getCampaignOptions = defineOp({
  name: "getCampaignOptions",
  mode: "read",
  input: z.object({ clientId: z.string().min(1) }),
  handler: async ({ clientId }) => {
    const row = await getClientRow(clientId);
    return fetchCampaignOptions(row ? effectiveAccountIds(row) : []);
  },
});

export const getBusinessSummary = defineOp({
  name: "getBusinessSummary",
  mode: "read",
  handler: () => fetchBusinessSummary(),
});

export const getAccountOptions = defineOp({
  name: "getAccountOptions",
  mode: "read",
  handler: () => fetchAccountOptions(),
});

export const runSearch = defineOp({
  name: "runSearch",
  mode: "read",
  input: scalarString,
  handler: (q) => searchEntities(q),
});

/**
 * The CSV body as a raw string — the same contract the UI has today, which builds the download
 * Blob client-side. Not `text/csv`: changing it would mean changing the one existing caller for no
 * behavioural gain, and the Base44 client builds its Blob the same way.
 */
export const getExportCsv = defineOp({
  name: "getExportCsv",
  mode: "read",
  input: rangeSpec.extend({ kind: z.enum(["accounts", "campaigns", "breakdowns"]) }),
  handler: (input) => exportCsv(input.kind, resolveWindow(input)),
});

export const getAdSetAds = defineOp({
  name: "getAdSetAds",
  mode: "read",
  input: rangeSpec.extend({ adSetId: z.string().min(1) }),
  handler: (input) => fetchAdSetAds(input.adSetId, resolveWindow(input)),
});
