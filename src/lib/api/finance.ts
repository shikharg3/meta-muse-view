import { createServerFn } from "@tanstack/react-start";
import { currentUser } from "@/server/fns/auth";
import { isSuperadmin } from "@/lib/auth/roles";
import { fetchFinance, type FinanceQuery, type FinanceSummary } from "@/server/fns/finance";

export const getFinance = createServerFn({ method: "GET" })
  .inputValidator((q: FinanceQuery) => q)
  .handler(async ({ data }): Promise<FinanceSummary | { error: string }> => {
    const me = await currentUser();
    if (!isSuperadmin(me?.role)) return { error: "Forbidden" };
    return fetchFinance(data);
  });
