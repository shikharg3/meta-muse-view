import { createServerFn } from "@tanstack/react-start";

import * as ops from "@/server/api/ops/report-catalog";

/** Which report metrics actually hold data for a client over a window — drives the column picker. */
export const getReportCatalog = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { clientId: string; preset?: string; days?: number; since?: string; until?: string }) => d,
  )
  .handler(({ data }) => ops.getReportCatalog.run(data));
