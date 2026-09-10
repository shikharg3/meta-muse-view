import { fetchAlerts } from "@/server/fns/alerts";
import {
  alertSettings,
  sendTestAlert as runTestAlert,
  unassignedSpendSummary,
} from "@/sync/alerts";
import { defineOp } from "../registry";

/**
 * Alert feed and Telegram configuration ops. None carry an authorisation check, matching today's
 * behaviour — including `sendTestAlert`, which is a write only because it delivers a real Telegram
 * message.
 */

export const getAlerts = defineOp({
  name: "getAlerts",
  mode: "read",
  handler: () => fetchAlerts(),
});

export const getAlertSettings = defineOp({
  name: "getAlertSettings",
  mode: "read",
  handler: () => alertSettings(),
});

/**
 * Live unassigned-spend backlog. Computed from current ownership rather than read from the alerts
 * table, so it cannot fall off the end of the capped alert feed while still needing action.
 */
export const getUnassignedSpend = defineOp({
  name: "getUnassignedSpend",
  mode: "read",
  handler: () => unassignedSpendSummary(),
});

export const sendTestAlert = defineOp({
  name: "sendTestAlert",
  mode: "write",
  handler: () => runTestAlert(),
});
