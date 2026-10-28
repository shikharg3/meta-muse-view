/**
 * How a synced insight row's fields are treated when a row is rewritten rather than read — modeled
 * (`modeling.ts`) or split (`split.ts`). One place, so both agree on what is a number, what is an
 * identity, and what keeps cents.
 */
import type { InsightRow } from "@/meta/types";

export type Action = { action_type: string; value: string };

export const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Meta's `[{ action_type, value }]` shape: actions, action values, video and ROAS families. */
export const isActionArray = (v: unknown): v is Action[] =>
  Array.isArray(v) &&
  v.every((e) => e !== null && typeof e === "object" && "action_type" in e && "value" in e);

export const isNumeric = (v: unknown): boolean =>
  typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));

/** Identity and dimension fields are copied, never rewritten. */
export const isIdentity = (key: string): boolean =>
  key === "date_start" || key === "date_stop" || key.endsWith("_id") || key.startsWith("__");

/** Money, rates and values keep cents; everything else is a count and stays whole. */
export const decimalsFor = (key: string): number =>
  /spend|value|roas|cpc|cpm|cpp|ctr|cost|rate|frequency/.test(key) ? 2 : 0;

export const roundTo = (n: number, decimals: number): string =>
  decimals === 0 ? String(Math.round(n)) : n.toFixed(decimals);

/** Each rewritable field of a row: a plain number, or an action array, by key. */
export function eachMetric(
  row: InsightRow,
  visit: {
    number: (key: string, value: number) => void;
    actions: (key: string, actions: Action[]) => void;
  },
): void {
  for (const [k, v] of Object.entries(row)) {
    if (isIdentity(k)) continue;
    if (isActionArray(v)) visit.actions(k, v);
    else if (isNumeric(v)) visit.number(k, num(v));
  }
}
