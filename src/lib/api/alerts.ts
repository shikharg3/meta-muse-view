import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/alerts";

export const getAlerts = createServerFn({ method: "GET" }).handler(() =>
  ops.getAlerts.run(undefined),
);

export const getAlertSettings = createServerFn({ method: "GET" }).handler(() =>
  ops.getAlertSettings.run(undefined),
);

/** Live unassigned-spend backlog. Computed from current ownership rather than read from the alerts
 *  table, so it cannot fall off the end of the capped alert feed while still needing action. */
export const getUnassignedSpend = createServerFn({ method: "GET" }).handler(() =>
  ops.getUnassignedSpend.run(undefined),
);

export const sendTestAlert = createServerFn({ method: "POST" }).handler(() =>
  ops.sendTestAlert.run(undefined),
);
