import { z } from "zod";
import { fetchReportCatalog } from "@/server/fns/report-catalog";
import { defineOp } from "../registry";
import { ymd } from "../schemas";

/**
 * Which report metrics actually hold data for a client over a window — drives the column picker.
 *
 * `read` despite the historical POST: it samples insight rows and writes nothing. The method was
 * POST only because the input is an object. `fetchReportCatalog` calls `requireApproved()` itself.
 */
export const getReportCatalog = defineOp({
  name: "getReportCatalog",
  mode: "read",
  input: z.object({
    clientId: z.string().min(1),
    preset: z.string().optional(),
    days: z.number().optional(),
    since: ymd.optional(),
    until: ymd.optional(),
  }),
  handler: (input) => fetchReportCatalog(input),
});
