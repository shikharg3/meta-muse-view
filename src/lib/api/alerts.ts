import { createServerFn } from "@tanstack/react-start";
import { fetchAlerts } from "@/server/fns/alerts";
import {
  alertSettings,
  sendTestAlert as runTestAlert,
  unassignedSpendSummary,
} from "@/sync/alerts";

export const getAlerts = createServerFn({ method: "GET" }).handler(() => fetchAlerts());

export const getAlertSettings = createServerFn({ method: "GET" }).handler(() => alertSettings());

/** Live unassigned-spend backlog. Computed from current ownership rather than read from the alerts
 *  table, so it cannot fall off the end of the capped alert feed while still needing action. */
export const getUnassignedSpend = createServerFn({ method: "GET" }).handler(() =>
  unassignedSpendSummary(),
);

export const sendTestAlert = createServerFn({ method: "POST" }).handler(() => runTestAlert());
