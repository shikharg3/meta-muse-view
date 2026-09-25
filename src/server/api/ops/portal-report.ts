import { z } from "zod";
import { resolveWindow } from "@/lib/range";
import { fetchPortalReport } from "@/server/fns/portal-report";
import { defineOp } from "../registry";
import { rangeSpec } from "../schemas";

/**
 * The client's report builder.
 *
 * `portalReport` is reachable with the CLIENT token (`src/server/api/http.ts` routes that token to
 * any op named `portal*` and nothing else), so its schema has NO markup input. Not "ignored if
 * sent" — absent, so there is no field a client could set, and none to read the agency's margin
 * back out of. `brandIds` and `campaignIds` are filters over the caller's resolved scope;
 * `breakdown` is the row axis and `granularity` the time axis, exactly as the builder reads them.
 */
export const portalReport = defineOp({
  name: "portalReport",
  mode: "read",
  input: rangeSpec.extend({
    brandIds: z.array(z.string()).optional(),
    campaignIds: z.array(z.string()).optional(),
    breakdown: z.enum(["total", "campaign"]),
    granularity: z.enum(["range", "day", "week"]),
  }),
  handler: (input) => fetchPortalReport(resolveWindow(input), input),
});
