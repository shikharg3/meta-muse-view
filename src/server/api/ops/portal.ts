import { z } from "zod";
import { resolveWindow } from "@/lib/range";
import {
  fetchPortalBootstrap,
  fetchPortalBreakdowns,
  fetchPortalCampaign,
  fetchPortalCampaigns,
  fetchPortalOverview,
  PORTAL_DIMENSIONS,
} from "@/server/fns/portal";
import { defineOp } from "../registry";
import { rangeSpec } from "../schemas";

/**
 * Client-facing portal ops — the pages the Base44 SPA renders.
 *
 * The `portal` prefix is load-bearing, not a naming habit: `src/server/api/http.ts` will only
 * dispatch a `portal*` op for a caller holding `PORTAL_API_TOKEN`, so a staff op is unaddressable
 * from the client app by construction. Anything added here is reachable by clients — that is the
 * whole contract of the prefix.
 *
 * These handlers carry no authorisation check of their own, and must not: the calling client is
 * resolved from the portal actor context inside `src/server/fns/portal.ts`, together with the brand
 * and campaign whitelist every query runs inside. Passing the caller's brand ids down as a plain
 * filter — never as a lookup — is what keeps an id the caller was not granted from widening
 * anything.
 */

/**
 * Brand selection is a filter over the caller's own scope; absent or empty means "all of them".
 * The ids are `portalBootstrap`'s brands — Notion board rows (`portalBrandOf`), not `brands` rows.
 */
const brandFilter = { brandIds: z.array(z.string()).optional() };

export const portalBootstrap = defineOp({
  name: "portalBootstrap",
  mode: "read",
  handler: () => fetchPortalBootstrap(),
});

export const portalOverview = defineOp({
  name: "portalOverview",
  mode: "read",
  input: rangeSpec.extend(brandFilter),
  handler: (input) => fetchPortalOverview(resolveWindow(input), input.brandIds),
});

export const portalCampaigns = defineOp({
  name: "portalCampaigns",
  mode: "read",
  input: rangeSpec.extend(brandFilter),
  handler: (input) => fetchPortalCampaigns(resolveWindow(input), input.brandIds),
});

export const portalCampaign = defineOp({
  name: "portalCampaign",
  mode: "read",
  input: rangeSpec.extend({ id: z.string().min(1) }),
  handler: (input) => fetchPortalCampaign(input.id, resolveWindow(input)),
});

export const portalBreakdowns = defineOp({
  name: "portalBreakdowns",
  mode: "read",
  input: rangeSpec.extend({
    ...brandFilter,
    // The enum is derived from the dimension→`breakdown_type` table rather than restated, so an
    // accepted dimension is always one the sync actually pulls at campaign level.
    dimension: z.enum(PORTAL_DIMENSIONS),
  }),
  handler: (input) => fetchPortalBreakdowns(resolveWindow(input), input.brandIds, input.dimension),
});
