import { fetchMetaHealth } from "@/server/fns/health";
import { defineOp } from "../registry";

/** Meta token health. Readable by any resolvable actor, matching today's behaviour. */
export const getMetaHealth = defineOp({
  name: "getMetaHealth",
  mode: "read",
  handler: () => fetchMetaHealth(),
});
