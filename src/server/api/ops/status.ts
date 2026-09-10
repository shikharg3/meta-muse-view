import { fetchSyncStatus } from "@/server/fns/status";
import { defineOp } from "../registry";

/**
 * Sync-status op for the admin Sync page. `fetchSyncStatus` calls `requireAdmin()` itself, so the
 * op adds nothing in front of it.
 */

export const getSyncStatus = defineOp({
  name: "getSyncStatus",
  mode: "read",
  handler: () => fetchSyncStatus(),
});
