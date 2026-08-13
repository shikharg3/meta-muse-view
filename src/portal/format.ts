import { fmtCompact } from "@/lib/format";

/**
 * Portal-specific number shapes. The repo's `@/lib/format` covers whole dollars, counts and compact
 * notation; these add the forms a client report needs and the period-over-period comparison.
 *
 * Every dollar figure the portal renders is already client-facing — the commission markup is applied
 * before the data reaches the UI, so there is no raw-spend formatter here on purpose.
 */

/** Cents, for cost-per-result figures where the second decimal is the whole point. */
export const usd2 = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const usdCompact = (n: number): string => `$${fmtCompact(n)}`;
export const pct = (n: number, digits = 1): string => `${n.toFixed(digits)}%`;
export const mult = (n: number): string => `${n.toFixed(2)}×`;

export interface Change {
  /** Percent change against the comparison period; 0 when there is no prior figure. */
  pct: number;
  dir: "up" | "down" | "flat";
  /** Whether the movement is good news for the client, given the metric's polarity. */
  good: boolean;
}

/** Period-over-period change. `lowerIsBetter` for costs (cost per registration, CPC, CPM). */
export function change(now: number, prev: number, lowerIsBetter = false): Change {
  if (prev <= 0) return { pct: 0, dir: "flat", good: true };
  const p = ((now - prev) / prev) * 100;
  const dir = Math.abs(p) < 0.5 ? "flat" : p > 0 ? "up" : "down";
  return { pct: p, dir, good: dir === "flat" ? true : lowerIsBetter ? p < 0 : p > 0 };
}
