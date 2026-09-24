import { z } from "zod";
import {
  addPortalGrant,
  createPortalUser,
  fetchBrands,
  fetchClientProjects,
  fetchCampaignCommission,
  bulkCampaignPresentation,
  fetchCampaignPresentation,
  fetchPortalUsers,
  removeBrand,
  removeCampaignCommission,
  removePortalGrant,
  removePortalUser,
  replaceBrandAccounts,
  updatePortalUserStatus,
  upsertBrand,
  upsertCampaignCommission,
  upsertCampaignPresentation,
} from "@/server/fns/portal-admin";
import { runPortalOpAs } from "@/server/fns/portal-view-as";
import { defineOp, isOp, type Op } from "../registry";
import { idOnly, nullableText, ymd } from "../schemas";
import * as portalOps from "./portal";
import * as portalCreativeOps from "./portal-creative";
import * as portalReportOps from "./portal-report";

/**
 * Staff ops for the portal's commercial layer: brands, commission, and who may see what.
 *
 * **Not one op here may be named `portal*`.** `src/server/api/http.ts` decides a caller's audience
 * by that prefix alone — a `portal`-prefixed name is addressable with the CLIENT token, and every
 * op in this file either reveals or edits the agency's margin. `staffName()` enforces it where the
 * names are written, rather than in a comment or a test, because the mistake is one keystroke and
 * its consequence is a customer with write access to what they are charged.
 *
 * The delegates all open with `requireAdmin()` and write an `audit()` entry per mutation, so no op
 * here adds a guard of its own. Like the infra ops, the schemas leave field-level rules (a required
 * name, a non-negative rate) to the delegates, which answer with `{ok:false,error}` for the admin
 * screen to render inline; a schema minimum would replace that sentence with a parse failure.
 */

/** The prefix `http.ts` treats as "client-reachable". Mirrored, not imported: importing the
 *  transport from an ops module would close the cycle `ops → http → ops`. */
const CLIENT_OP_PREFIX = "portal";

function staffName(name: string): string {
  if (name.startsWith(CLIENT_OP_PREFIX)) {
    throw new Error(
      `Staff op "${name}" starts with "${CLIENT_OP_PREFIX}", which makes it callable with the portal token.`,
    );
  }
  return name;
}

const brandId = z.object({ brandId: z.string().min(1) });
const campaignId = z.object({ campaignId: z.string().min(1) });
/** Ad-account ids are `act_<digits>` everywhere; anything else can never join to a campaign. */
const accountId = z.string().regex(/^act_\d+$/, "Expected an act_<digits> ad account id");
const money = z.number().finite().nullable().optional();

// ── Projects

export const listClientProjects = defineOp({
  name: staffName("listClientProjects"),
  mode: "read",
  input: z.object({ clientId: z.string().min(1) }),
  handler: (input) => fetchClientProjects(input.clientId),
});

// ── Brands

export const listBrands = defineOp({
  name: staffName("listBrands"),
  mode: "read",
  handler: () => fetchBrands(),
});

export const saveBrand = defineOp({
  name: staffName("saveBrand"),
  mode: "write",
  input: z.object({
    // Absent, null or empty means create — the edit form sends `""` for a new row.
    id: z.string().nullable().optional(),
    clientId: z.string().min(1),
    name: z.string(),
    website: nullableText,
    monthlyBudget: money,
    defaultCommission: money,
    /**
     * `null` = follow the client (the default for a new brand, and what makes a future engagement
     * appear by itself). An array = exactly those Notion page ids. OMITTED on an update = leave
     * the existing selection alone, which is why this is `.optional()` on top of `.nullable()`
     * rather than defaulting.
     */
    projectIds: z.array(z.string().min(1)).nullable().optional(),
  }),
  handler: (input) => upsertBrand(input),
});

export const deleteBrand = defineOp({
  name: staffName("deleteBrand"),
  mode: "write",
  input: idOnly,
  handler: (input) => removeBrand(input),
});

/**
 * A NARROWING override on the accounts a brand's projects resolve to — not the mapping itself.
 * Pass an empty array to clear it and go back to the full project-derived list.
 */
export const setBrandAccounts = defineOp({
  name: staffName("setBrandAccounts"),
  mode: "write",
  input: brandId.extend({ accountIds: z.array(accountId) }),
  handler: (input) => replaceBrandAccounts(input),
});

// ── Campaign presentation

export const listCampaignPresentation = defineOp({
  name: staffName("listCampaignPresentation"),
  mode: "read",
  /** Optional, never required: the whole table is a few hundred rows and the admin list wants it
   *  all, but the campaign screen narrows it when it already knows which ids it is showing. */
  input: z
    .object({ campaignIds: z.array(z.string().min(1)).optional() })
    .optional()
    .default({}),
  handler: (input) => fetchCampaignPresentation(input),
});

export const saveCampaignPresentation = defineOp({
  name: staffName("saveCampaignPresentation"),
  mode: "write",
  input: campaignId.extend({ alias: z.string().nullable(), hidden: z.boolean() }),
  handler: (input) => upsertCampaignPresentation(input),
});

/**
 * The bulk renamer's save. One transaction for the whole screen, so a partial failure cannot leave
 * some campaigns renamed and others not.
 *
 * `alias: null` clears an override and falls back to Meta's name; it does not hide the campaign.
 * The cap is a guard against a runaway client, not a product limit — 627 campaigns exist in total.
 */
export const saveCampaignPresentationBulk = defineOp({
  name: staffName("saveCampaignPresentationBulk"),
  mode: "write",
  input: z.object({
    items: z
      .array(
        z.object({
          campaignId: z.string().min(1),
          alias: z.string().nullable(),
          hidden: z.boolean(),
        }),
      )
      .max(1000),
  }),
  handler: (input) => bulkCampaignPresentation(input),
});

// ── Commission

export const listCampaignCommission = defineOp({
  name: staffName("listCampaignCommission"),
  mode: "read",
  input: campaignId,
  handler: (input) => fetchCampaignCommission(input),
});

export const saveCampaignCommission = defineOp({
  name: staffName("saveCampaignCommission"),
  mode: "write",
  input: campaignId.extend({ fromDate: ymd, rate: z.number() }),
  handler: (input) => upsertCampaignCommission(input),
});

export const deleteCampaignCommission = defineOp({
  name: staffName("deleteCampaignCommission"),
  mode: "write",
  input: campaignId.extend({ fromDate: ymd }),
  handler: (input) => removeCampaignCommission(input),
});

// ── Portal users and access

export const listPortalUsers = defineOp({
  name: staffName("listPortalUsers"),
  mode: "read",
  handler: () => fetchPortalUsers(),
});

export const invitePortalUser = defineOp({
  name: staffName("invitePortalUser"),
  mode: "write",
  input: z.object({ email: z.string().email(), name: nullableText }),
  handler: (input) => createPortalUser(input),
});

export const setPortalUserStatus = defineOp({
  name: staffName("setPortalUserStatus"),
  mode: "write",
  input: idOnly.extend({ status: z.enum(["pending", "approved", "rejected"]) }),
  handler: (input) => updatePortalUserStatus(input),
});

export const deletePortalUser = defineOp({
  name: staffName("deletePortalUser"),
  mode: "write",
  input: idOnly,
  handler: (input) => removePortalUser(input),
});

export const grantPortalAccess = defineOp({
  name: staffName("grantPortalAccess"),
  mode: "write",
  input: z.object({
    portalUserId: z.string().min(1),
    scope: z.enum(["brand", "campaign"]),
    targetId: z.string().min(1),
  }),
  handler: (input) => addPortalGrant(input),
});

/** Takes the grant's own id, which `listPortalUsers` returns — the `(user, scope, target)` triple
 *  identifies the same row, but only the id survives a target being renamed or re-pointed. */
export const revokePortalAccess = defineOp({
  name: staffName("revokePortalAccess"),
  mode: "write",
  input: idOnly,
  handler: (input) => removePortalGrant(input),
});

// ── Viewing the portal as a client

/**
 * The ops a client can call, by name — the only ones an admin can run as a client.
 *
 * Collected from the portal op modules directly rather than from the op table, because the table
 * imports this module and reading it back would close the cycle `index → portal-admin → index`.
 * `view-as.test.ts` asserts this equals the set the portal token reaches, so a `portal*` op added
 * in a new module fails the build here instead of being missing from the preview.
 */
export const VIEW_AS_OPS: ReadonlyMap<string, Op> = new Map(
  [portalOps, portalCreativeOps, portalReportOps]
    .flatMap((m) => Object.values(m as Record<string, unknown>))
    .filter(isOp)
    .filter((o) => o.name.startsWith(CLIENT_OP_PREFIX))
    .map((o) => [o.name, o] as const),
);

/**
 * Run a client-facing op exactly as the portal user `email` sees it — the admin console's "view as
 * client". Admin-only, audited once per preview, and it leaves the client's "last seen" alone; see
 * the delegate for what is identical to the real portal transport and what is not.
 *
 * Answers `{ ok, data | error }` inside `data`, the shape the portal transport sends, so a refusal
 * (`unknown_actor`, `not_approved`) renders as the same screen the client would get.
 */
export const viewPortalAs = defineOp({
  name: staffName("viewPortalAs"),
  mode: "read",
  input: z.object({
    email: z.string().email(),
    op: z.string().min(1),
    data: z.unknown().optional(),
  }),
  handler: (input) => runPortalOpAs(input.email, VIEW_AS_OPS.get(input.op) ?? null, input.data),
});
