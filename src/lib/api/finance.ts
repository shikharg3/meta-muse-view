import { createServerFn } from "@tanstack/react-start";
import * as ops from "@/server/api/ops/finance";
import type { FinanceQuery, FinanceSummary } from "@/server/fns/finance";

export const getFinance = createServerFn({ method: "GET" })
  .inputValidator((q: FinanceQuery) => q)
  .handler(({ data }): Promise<FinanceSummary | { error: string }> => ops.getFinance.run(data));
