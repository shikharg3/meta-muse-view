import { describe, expect, it } from "bun:test";
import { delivered } from "@/server/fns/portal";
import type { Totals } from "@/server/agg";

const ZERO: Totals = { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, reach: 0 };

describe("delivered", () => {
  it("drops a campaign that did nothing in the window", () => {
    expect(delivered(ZERO, 0, 0)).toBe(false);
  });

  /**
   * The rule is "no delivery", not "no spend". Every metric the portal also SUMS has to keep a
   * campaign on the list, or the campaign table's column would stop adding up to the overview's
   * figure — a client finding £0 of revenue in a table whose total says £900 has caught us
   * hiding a row. Each field is checked on its own because the plausible bug here is forgetting
   * one of them in the predicate.
   */
  it.each([
    ["spend", { ...ZERO, spend: 0.01 }, 0, 0],
    ["impressions", { ...ZERO, impressions: 1 }, 0, 0],
    ["clicks", { ...ZERO, clicks: 1 }, 0, 0],
    ["reach", { ...ZERO, reach: 1 }, 0, 0],
    ["conversions", { ...ZERO, conversions: 1 }, 0, 0],
    ["revenue", { ...ZERO, revenue: 900 }, 0, 0],
    ["registrations", ZERO, 1, 0],
    ["deposits", ZERO, 0, 1],
  ] as const)("keeps a campaign whose only figure is %s", (_label, t, regs, deps) => {
    expect(delivered(t, regs, deps)).toBe(true);
  });
});
