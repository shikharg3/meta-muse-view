import { fetchActivity } from "@/server/fns/activity";
import { defineOp } from "../registry";

/** Ad-account change history. No authorisation check, matching today's behaviour. */
export const getActivity = defineOp({
  name: "getActivity",
  mode: "read",
  handler: () => fetchActivity(),
});
