import { z } from "zod";
import { ALERT_STATUSES, fetchAlerts, setAlertStatus } from "@/server/fns/alerts";
import {
  alertSettings,
  sendTestAlert as runTestAlert,
  unassignedSpendSummary,
} from "@/sync/alerts";
import { defineOp } from "../registry";

const alertStatus = z.enum(ALERT_STATUSES);

/**
 * Alert feed and Telegram configuration ops. None carry an authorisation check, matching today's
 * behaviour — including `sendTestAlert`, which is a write only because it delivers a real Telegram
 * message. `setAlertsStatus` is the one mutation of shared state here, so it is audited instead.
 */

export const getAlerts = defineOp({
  name: "getAlerts",
  mode: "read",
  /**
   * All-optional with a default, so the historical no-argument call still parses. `limit` is a page
   * size, not a cursor: the feed was hard-capped at 100 with no way to ask for more and no way to
   * tell that the cap had been reached.
   */
  input: z
    .object({
      limit: z.number().int().positive().max(1000).optional(),
      status: alertStatus.optional(),
    })
    .default({}),
  handler: (input) => fetchAlerts(input.limit ?? 100, input.status),
});

/** Clear one alert or a whole category, or put them back. */
export const setAlertsStatus = defineOp({
  name: "setAlertsStatus",
  mode: "write",
  input: z.object({ ids: z.array(z.string().min(1)).min(1).max(500), status: alertStatus }),
  handler: (input) => setAlertStatus(input.ids, input.status),
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
