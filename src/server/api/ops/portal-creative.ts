import { z } from "zod";
import { fetchPortalCreatives } from "@/server/fns/portal-creative";
import { defineOp } from "../registry";
import { rangeSpec } from "../schemas";

/**
 * Portal creative ops.
 *
 * `portal*` is a load-bearing prefix, not a naming convention: `src/server/api/http.ts` lets a
 * `PORTAL_API_TOKEN` caller invoke only ops whose name starts with it. An op added here under any
 * other name would be unreachable from the client portal and reachable from the staff token — with
 * a handler that resolves its scope from a portal actor that is not there.
 */

export const portalCreatives = defineOp({
  name: "portalCreatives",
  mode: "read",
  input: rangeSpec.extend({
    brandIds: z.array(z.string()).optional(),
    campaignIds: z.array(z.string()).optional(),
  }),
  handler: (input) => fetchPortalCreatives(input),
});
