/**
 * Split a share of every row into another campaign: each row keeps (1 − share) of every metric and a
 * copy carries the rest, so totals never change. Not "the last 20% of rows" — every row is split.
 *
 * Counts are split into whole numbers, money into cents, and the moved part is computed first with
 * the kept part as the remainder, so kept + moved is exactly the original. Derived figures (CPC, CTR,
 * cost per …) are not split: the report engine recomputes them from each half.
 */
import type { InsightRow } from "@/meta/types";
import { decimalsFor, eachMetric, roundTo } from "./insight-fields";

/** Appended to an entity id to name its split copy. Never a Meta id character. */
export const SPLIT_SUFFIX = "::split";

export const isSplitId = (id: string): boolean => id.endsWith(SPLIT_SUFFIX);
export const unsplitId = (id: string): string =>
  isSplitId(id) ? id.slice(0, -SPLIT_SUFFIX.length) : id;

/** [kept, moved]: the row with (1 − share) of each metric, and a copy with the rest. */
export function splitRow(row: InsightRow, share: number): [InsightRow, InsightRow] {
  const kept: Record<string, unknown> = { ...row };
  const moved: Record<string, unknown> = { ...row };
  const part = (key: string, value: number): [string, string] => {
    const d = decimalsFor(key);
    const m = Number(roundTo(value * share, d));
    return [roundTo(value - m, d), roundTo(m, d)];
  };
  eachMetric(row, {
    number: (k, v) => {
      [kept[k], moved[k]] = part(k, v);
    },
    actions: (k, actions) => {
      const halves = actions.map((a) => part(k, Number(a.value) || 0));
      kept[k] = actions.map((a, i) => ({ ...a, value: halves[i][0] }));
      moved[k] = actions.map((a, i) => ({ ...a, value: halves[i][1] }));
    },
  });
  return [kept as InsightRow, moved as InsightRow];
}
