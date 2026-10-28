/**
 * "What if delivery had not been interrupted": replace the days a campaign barely ran with an
 * estimate from the days around them. For the modeled report option only — the figures it produces
 * are estimates, and every report that uses them says so (title, note, a Modeled column on daily
 * rows, the Telegram caption). Actual reporting goes out without it.
 *
 * Pure: rows in, rows out. The rules:
 *
 * - A day is judged on the whole report scope's spend that day. It is **interrupted** when spend is
 *   zero, or below `threshold` (25%) of the median spend of its reference days.
 * - A day's **reference days** are the active days within ±`window` (5) days of it. When nothing
 *   after it has data yet (yesterday, in a daily report) they are the active days in the
 *   `fallbackBack` (7) days before it. Interrupted days are never references, so two dead days in a
 *   row are both modeled from live ones.
 * - Each entity (ad set, campaign, country, …) on an interrupted day becomes the mean of its own
 *   reference days — a day it did not run counts as zero — times an independent factor in
 *   [1 − variance, 1 + variance] per metric (±15%). The factors are seeded by day, entity and metric,
 *   so the same report always shows the same estimate.
 * - The day's actual rows are dropped in favour of the estimate. A day with fewer than `minReferenceDays`
 *   active reference days is left actual, and reported as such.
 */
import type { InsightRow } from "@/meta/types";
import { addDays } from "@/lib/range";
import {
  decimalsFor,
  isActionArray,
  isIdentity,
  isNumeric,
  num,
  roundTo as round,
} from "./insight-fields";

export interface ModelingOptions {
  threshold: number;
  window: number;
  fallbackBack: number;
  variance: number;
  minReferenceDays: number;
}

export const MODELING_DEFAULTS: ModelingOptions = {
  threshold: 0.25,
  window: 5,
  fallbackBack: 7,
  variance: 0.15,
  minReferenceDays: 2,
};

/** One synced row and what identifies its entity across days. */
export interface KeyedRow {
  accountId: string;
  /** Stable across days for the same report row: entity id, or campaign + breakdown value. */
  key: string;
  row: InsightRow;
}

export interface ModeledDay {
  date: string;
  actualSpend: number;
  referenceMedian: number;
  referenceDays: string[];
}

export interface ModelingResult {
  /** Rows inside the range, interrupted days replaced by their estimate. */
  rows: KeyedRow[];
  modeled: ModeledDay[];
  /** Interrupted days left actual, with why. */
  skipped: { date: string; reason: string }[];
}

/** FNV-1a: a stable [0, 1) per string, so an estimate never changes between runs. */
function unit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 2 ** 32;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The estimate for one entity on `date`: the mean of its reference-day rows, varied per metric. */
function estimate(
  date: string,
  key: string,
  refRows: InsightRow[],
  referenceCount: number,
  variance: number,
): InsightRow {
  const factor = (metric: string) => 1 + (unit(`${date}|${key}|${metric}`) * 2 - 1) * variance;
  const template = refRows[refRows.length - 1];
  const out: InsightRow = { ...template, date_start: date, date_stop: date };
  const keys = new Set(refRows.flatMap((r) => Object.keys(r)));
  for (const k of keys) {
    if (isIdentity(k)) continue;
    const values = refRows.map((r) => (r as Record<string, unknown>)[k]);
    const sample = values.find((v) => v !== undefined && v !== null);
    if (isActionArray(sample)) {
      // One factor for the whole array: Meta reports one event under several synonymous action
      // types, and varying them apart would make the family count depend on which is read.
      const f = factor(k);
      const sums = new Map<string, number>();
      for (const v of values)
        if (isActionArray(v))
          for (const a of v) sums.set(a.action_type, (sums.get(a.action_type) ?? 0) + num(a.value));
      (out as Record<string, unknown>)[k] = [...sums].map(([action_type, total]) => ({
        action_type,
        value: round((total / referenceCount) * f, decimalsFor(k)),
      }));
    } else if (isNumeric(sample)) {
      const total = values.reduce((s: number, v) => s + num(v), 0);
      (out as Record<string, unknown>)[k] = round(
        (total / referenceCount) * factor(k),
        decimalsFor(k),
      );
    }
  }
  return out;
}

export function modelInterruptedDays(
  rows: KeyedRow[],
  range: { since: string; until: string },
  /** The last day with synced data; later days are neither modeled nor used as references. */
  lastDay: string,
  opts: ModelingOptions = MODELING_DEFAULTS,
): ModelingResult {
  const spendByDay = new Map<string, number>();
  const byKeyDay = new Map<string, Map<string, InsightRow[]>>();
  const accountOf = new Map<string, string>();
  for (const r of rows) {
    const d = String(r.row.date_start);
    spendByDay.set(d, (spendByDay.get(d) ?? 0) + num(r.row.spend));
    const days = byKeyDay.get(r.key) ?? new Map<string, InsightRow[]>();
    days.set(d, [...(days.get(d) ?? []), r.row]);
    byKeyDay.set(r.key, days);
    accountOf.set(r.key, r.accountId);
  }
  const spend = (d: string) => spendByDay.get(d) ?? 0;
  const active = [...spendByDay].filter(([, s]) => s > 0).map(([d]) => d);
  const firstActive = active.length ? active.reduce((a, b) => (a < b ? a : b)) : null;

  /** Days within reach of `d` that have data, nearest window first. */
  const neighbours = (d: string): string[] => {
    const after: string[] = [];
    const before: string[] = [];
    for (let i = 1; i <= opts.window; i++) {
      const a = addDays(d, i);
      if (a <= lastDay) after.push(a);
      before.push(addDays(d, -i));
    }
    if (after.length > 0) return [...before, ...after];
    return Array.from({ length: opts.fallbackBack }, (_, i) => addDays(d, -(i + 1)));
  };
  const interruptedBy = (d: string, excluded: Set<string>) => {
    const refs = neighbours(d).filter((x) => spend(x) > 0 && !excluded.has(x));
    const med = refs.length ? median(refs.map(spend)) : 0;
    return { refs, med, interrupted: spend(d) === 0 || spend(d) < opts.threshold * med };
  };

  const days: string[] = [];
  for (let d = range.since; d <= range.until && d <= lastDay; d = addDays(d, 1)) days.push(d);
  // Two passes: the first marks every low day in reach, the second judges and models each day
  // against references without them — otherwise a run of low days drags its own median down.
  const lowDays = new Set<string>();
  for (const d of new Set(days.flatMap((d) => [d, ...neighbours(d)])))
    if (spend(d) > 0 && interruptedBy(d, new Set()).interrupted) lowDays.add(d);

  const modeled: ModeledDay[] = [];
  const skipped: ModelingResult["skipped"] = [];
  const replaced = new Map<string, KeyedRow[]>();
  for (const d of days) {
    const { refs, med, interrupted } = interruptedBy(d, lowDays);
    if (!interrupted) continue;
    // Before the first delivery in reach the campaign had not started: nothing was interrupted.
    if (firstActive === null || d < firstActive) continue;
    if (refs.length < opts.minReferenceDays) {
      skipped.push({
        date: d,
        reason: `only ${refs.length} active day${refs.length === 1 ? "" : "s"} nearby to model from`,
      });
      continue;
    }
    const estimates: KeyedRow[] = [];
    for (const [key, byDay] of byKeyDay) {
      const refRows = refs.flatMap((x) => byDay.get(x) ?? []);
      if (refRows.length === 0) continue;
      estimates.push({
        accountId: accountOf.get(key)!,
        key,
        row: estimate(d, key, refRows, refs.length, opts.variance),
      });
    }
    replaced.set(d, estimates);
    modeled.push({ date: d, actualSpend: spend(d), referenceMedian: med, referenceDays: refs });
  }

  const inRange = rows.filter((r) => {
    const d = String(r.row.date_start);
    return d >= range.since && d <= range.until && !replaced.has(d);
  });
  return { rows: [...inRange, ...[...replaced.values()].flat()], modeled, skipped };
}
