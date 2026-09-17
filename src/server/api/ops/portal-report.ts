import { z } from "zod";
import { resolveWindow } from "@/lib/range";
import {
  buildAgencyReport,
  fetchAgencyReportCampaigns,
  fetchPortalReport,
} from "@/server/fns/portal-report";
import { defineOp } from "../registry";
import { rangeSpec } from "../schemas";

/**
 * The report builder's ops — the same table for both audiences, under two names.
 *
 * The name is the authorisation boundary here, not a convention: `src/server/api/http.ts` routes a
 * caller holding the CLIENT token to any op named `portal*` and to nothing else. So the customer's
 * report is `portalReport` and the agency's is `buildPortalReport`, and the two differ in exactly
 * the two ways that matter:
 *
 * - `portalReport` has NO markup input. Not "ignored if sent" — absent from the schema, so there is
 *   no field a client could set, and none for a client to read the agency's margin back out of.
 * - `buildPortalReport` accepts one, resolves its brands without consulting `portal_grants`, and is
 *   admin-only (`requireAdmin()` inside the delegate, re-checked server-side of the transport).
 *
 * `staffName()` is duplicated from `./portal-admin.ts` rather than shared, for the reason given
 * there: importing the transport to read the prefix would close the cycle `ops → http → ops`.
 */

/** The prefix `http.ts` treats as "client-reachable". */
const CLIENT_OP_PREFIX = "portal";

function staffName(name: string): string {
  if (name.startsWith(CLIENT_OP_PREFIX)) {
    throw new Error(
      `Staff op "${name}" starts with "${CLIENT_OP_PREFIX}", which makes it callable with the portal token.`,
    );
  }
  return name;
}

/**
 * Both audiences' report shape. `brandIds` and `campaignIds` are filters over the resolved scope;
 * `breakdown` is the row axis and `granularity` the time axis, exactly as the builder reads them.
 */
const reportInput = rangeSpec.extend({
  brandIds: z.array(z.string()).optional(),
  campaignIds: z.array(z.string()).optional(),
  breakdown: z.enum(["total", "campaign"]),
  granularity: z.enum(["range", "day", "week"]),
});

export const portalReport = defineOp({
  name: "portalReport",
  mode: "read",
  input: reportInput,
  handler: (input) => fetchPortalReport(resolveWindow(input), input),
});

/**
 * `markupOverride` is a percentage in the same unit as `campaign_commissions.rate`, and replaces
 * every campaign's own rate for this one report. Null or absent quotes the rates on file.
 */
export const buildPortalReport = defineOp({
  name: staffName("buildPortalReport"),
  mode: "read",
  input: reportInput.extend({ markupOverride: z.number().finite().nullable().optional() }),
  handler: (input) => buildAgencyReport(resolveWindow(input), input),
});

/** The internal builder's campaign filter. `portalCampaigns` cannot serve it — see the delegate. */
export const listPortalReportCampaigns = defineOp({
  name: staffName("listPortalReportCampaigns"),
  mode: "read",
  input: z.object({ brandIds: z.array(z.string()).optional() }),
  handler: (input) => fetchAgencyReportCampaigns(input.brandIds),
});
