import { z } from "zod";
import { isSuperadmin } from "@/lib/auth/roles";
import { currentUser } from "@/server/fns/auth";
import { fetchFinance } from "@/server/fns/finance";
import { defineOp } from "../registry";
import { ymd } from "../schemas";

/**
 * LLM cost reporting — superadmin only.
 *
 * The gate moved here from `src/lib/api/finance.ts`; `fetchFinance` itself is unguarded, so
 * deleting that wrapper without this check would expose every user's spend. It stays a returned
 * `{error:"Forbidden"}` rather than a thrown `ForbiddenError` because the UI branches on the field.
 */
export const getFinance = defineOp({
  name: "getFinance",
  mode: "read",
  input: z.object({
    since: ymd.optional(),
    until: ymd.optional(),
    userIds: z.array(z.string().min(1)).optional(),
  }),
  handler: async (query) => {
    const me = await currentUser();
    if (!isSuperadmin(me?.role)) return { error: "Forbidden" };
    return fetchFinance(query);
  },
});
