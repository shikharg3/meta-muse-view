import { and, eq, gte, inArray, lte } from "drizzle-orm";

import { db, schema } from "@/db/client";
import { EVENT_MEMBERS } from "@/server/agg";
import { REPORT_METRICS, metric } from "@/lib/report-catalog";
import { resolveRange } from "@/server/agent/report";
import { getClientRow, effectiveAccountIds } from "@/sync/jobs/clients";
import { requireApproved } from "./auth";

/** Rows scanned per availability check. The picker needs presence, not precision. */
const SAMPLE_ROWS = 5000;

/**
 * Which catalog keys hold non-zero data for a client's accounts over a window.
 *
 * Sampled, not exhaustive: the column picker only needs to know whether a metric is worth offering,
 * and scanning every row would cost more than the report it is helping to build.
 *
 * The engine never consults this. A report that explicitly asks for a metric with no data still
 * renders zeros rather than failing — availability shapes the UI, it is not a validation gate.
 *
 * Why it matters: `marketing_messages_*` is 11 fields present on 7,579 production rows, essential
 * for a WhatsApp client and pure noise for everyone else. Without the filter a 112-item picker is a
 * worse experience than the 22-item one it replaces.
 */
export async function availableMetricKeys(args: {
  accountIds: string[];
  since: string;
  until: string;
}): Promise<string[]> {
  if (args.accountIds.length === 0) return [];
  const rows = await db
    .select({ raw: schema.insightsDaily.raw, actions: schema.insightsDaily.actions })
    .from(schema.insightsDaily)
    .where(
      and(
        eq(schema.insightsDaily.level, "ad"),
        inArray(schema.insightsDaily.accountId, args.accountIds),
        gte(schema.insightsDaily.date, args.since),
        lte(schema.insightsDaily.date, args.until),
      ),
    )
    .limit(SAMPLE_ROWS);
  return classifyAvailable(rows);
}

/**
 * The classification half of the availability check, split from the query so it is testable without
 * a database — the interesting behaviour is dependency-following and Meta's field shapes, not SQL.
 */
export function classifyAvailable(rows: readonly { raw: unknown; actions: unknown }[]): string[] {
  const fields = new Set<string>();
  const actionTypes = new Set<string>();
  for (const r of rows) {
    for (const [k, v] of Object.entries((r.raw ?? {}) as Record<string, unknown>)) {
      // Meta's video and ROAS metrics arrive as [{action_type, value}]; treat any non-empty array as
      // present, and any scalar that parses to a non-zero number.
      if (Array.isArray(v) ? v.length > 0 : Number(v)) fields.add(k);
    }
    for (const a of (r.actions as { action_type: string; value: string }[] | null) ?? []) {
      if (Number(a.value)) actionTypes.add(a.action_type);
    }
  }

  const has = (key: string, seen: Set<string>): boolean => {
    if (seen.has(key)) return false; // a cycle cannot be "available"; the catalog test forbids one
    seen.add(key);
    const m = metric(key);
    if (!m) return false;
    switch (m.source.kind) {
      case "scalar":
        return fields.has(m.source.field);
      case "action":
        return actionTypes.has(m.source.type);
      case "event":
        return (EVENT_MEMBERS[m.source.family] ?? []).some((t) => actionTypes.has(t));
      case "result":
        return true; // objective-derived; always computable from campaign rows
      case "derived":
        return m.source.deps.every((d) => has(d, seen));
    }
  };

  return REPORT_METRICS.filter((m) => has(m.key, new Set())).map((m) => m.key);
}

/**
 * Availability for a client over a resolved window. Plain async function, not a server fn: the
 * createServerFn wrapper lives in src/lib/api/report-catalog.ts, matching every other module here.
 *
 * A read, so it throws on an unauthorised caller rather than returning an error shape.
 */
export async function fetchReportCatalog(input: {
  clientId: string;
  preset?: string;
  days?: number;
  since?: string;
  until?: string;
}): Promise<{ keys: string[] }> {
  await requireApproved();
  const row = await getClientRow(input.clientId);
  if (!row) return { keys: [] };
  const range = resolveRange(input);
  if (!range) return { keys: [] };
  return {
    keys: await availableMetricKeys({
      accountIds: effectiveAccountIds(row),
      since: range.since,
      until: range.until,
    }),
  };
}
