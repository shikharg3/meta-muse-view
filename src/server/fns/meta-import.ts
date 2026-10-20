import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { getRequestHost } from "@tanstack/react-start/server";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import { isImportHost } from "@/lib/import-host";
import { effectiveAccountIds } from "@/sync/jobs/clients";
import {
  IMPORT_TEMPLATE_HEADERS,
  MAX_CSV_CHARS,
  RESULT_EVENTS,
  insightRowsOf,
  planImport,
  resultsOf,
  round2,
  type ImportIssue,
  type ImportLevel,
  type ImportOptions,
  type ImportPlan,
} from "@/server/meta-import";
import { audit, requireAdmin } from "./auth";

/**
 * CSV import of an ad account the system-user token cannot read (see src/server/meta-import.ts).
 * Every entry point is IMPORT_HOSTS-only and admin-only; commits and deletes are audited.
 */

export interface ImportPreview {
  ok: boolean;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  account: { id: string; name: string; currency: string; state: "new" | "imported" } | null;
  dateFrom: string | null;
  dateTo: string | null;
  levelsInFile: ImportLevel[];
  derivedLevels: ImportLevel[];
  rowsByLevel: Record<ImportLevel, number>;
  resultEvent: string | null;
  resultLabel: string | null;
  mappedColumns: { header: string; field: string }[];
  ignoredColumns: string[];
  totals: {
    spend: number;
    impressions: number;
    clicks: number;
    linkClicks: number;
    results: number;
  };
  days: { date: string; spend: number; impressions: number; clicks: number; results: number }[];
  campaigns: {
    id: string;
    name: string;
    adSets: number;
    spend: number;
    impressions: number;
    results: number;
  }[];
  /** Imported rows already stored for this account and date range, which a commit replaces. */
  replaces: { rows: number; spend: number } | null;
  fileSha256: string;
}

export interface ImportCommitResult {
  batchId: string;
  accountId: string;
  dateFrom: string;
  dateTo: string;
  rowsByLevel: Record<ImportLevel, number>;
  spend: number;
}

export interface ImportedAccountSummary {
  id: string;
  name: string;
  currency: string;
  dateFrom: string | null;
  dateTo: string | null;
  spend: number;
  /** Current clients whose effective accounts include this one. Empty = it counts for nobody yet. */
  clients: string[];
  batches: {
    id: string;
    fileName: string | null;
    dateFrom: string;
    dateTo: string;
    spend: number;
    rowsByLevel: Record<ImportLevel, number>;
    uploadedBy: string;
    uploadedAt: string;
  }[];
}

export interface ImportPageData {
  imported: ImportedAccountSummary[];
  resultEvents: { event: string; label: string }[];
  templateHeaders: string[];
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Host first, so a domain answers "Not found" whoever is signed in. */
async function guard() {
  if (!isImportHost(getRequestHost(), env().IMPORT_HOSTS)) throw new Error("Not found");
  return requireAdmin();
}

/** Server-fn input arrives off the wire; the wrappers' validators are only type annotations. */
const importInput = z.object({
  csv: z.string().max(MAX_CSV_CHARS),
  fileName: z.string().max(255).nullish(),
  accountId: z.string().max(40).nullish(),
  accountName: z.string().max(200).nullish(),
  currency: z.string().max(3).nullish(),
  resultEvent: z.string().max(40).nullish(),
});

/** Postgres caps a statement at 65,535 parameters; an insights row binds about 20. */
const CHUNK = 1000;
function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

/**
 * The checks that need the database: the account must not be one the sync owns (it exists with no
 * upload behind it), no imported id may already belong to another account, and what a commit would
 * replace.
 */
async function checkAgainstDb(q: Tx, plan: ImportPlan) {
  const errors: ImportIssue[] = [];
  const accountId = plan.accountId!;
  const [existing] = await q
    .select({ name: schema.accounts.name })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  const [batch] = existing
    ? await q
        .select({ id: schema.importBatches.id })
        .from(schema.importBatches)
        .where(eq(schema.importBatches.accountId, accountId))
        .limit(1)
    : [];
  if (existing && !batch)
    errors.push({
      row: null,
      message: `${accountId} is synced from Meta, which is its system of record. It cannot be imported.`,
    });

  const clash = async (
    label: string,
    table: typeof schema.campaigns | typeof schema.adSets | typeof schema.ads,
    ids: string[],
  ) => {
    if (!ids.length) return;
    const rows = await q
      .select({ id: table.id, accountId: table.accountId })
      .from(table)
      .where(and(inArray(table.id, ids), ne(table.accountId, accountId)));
    for (const r of rows.slice(0, 10))
      errors.push({
        row: null,
        message: `${label} ${r.id} already belongs to account ${r.accountId}.`,
      });
  };
  await clash(
    "Campaign",
    schema.campaigns,
    plan.campaigns.map((c) => c.id),
  );
  await clash(
    "Ad set",
    schema.adSets,
    plan.adSets.map((s) => s.id),
  );
  await clash(
    "Ad",
    schema.ads,
    plan.ads.map((a) => a.id),
  );

  let replaces: ImportPreview["replaces"] = null;
  if (batch && plan.dateFrom && plan.dateTo) {
    const [r] = await q
      .select({
        rows: sql<number>`count(*)::int`,
        spend: sql<number>`coalesce(sum(${schema.insightsDaily.spend}) filter (where ${schema.insightsDaily.level} = 'account'), 0)::float`,
      })
      .from(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.accountId, accountId),
          gte(schema.insightsDaily.date, plan.dateFrom),
          lte(schema.insightsDaily.date, plan.dateTo),
        ),
      );
    if (r && r.rows > 0) replaces = { rows: r.rows, spend: round2(r.spend) };
  }
  return {
    errors,
    existingName: existing?.name ?? null,
    state: existing ? ("imported" as const) : ("new" as const),
    replaces,
  };
}

export async function previewMetaImport(input: ImportOptions): Promise<ImportPreview> {
  await guard();
  const opts = importInput.parse(input);
  const plan = planImport(opts);
  const checked =
    plan.errors.length === 0 ? await db.transaction((tx) => checkAgainstDb(tx, plan)) : null;
  const errors = [...plan.errors, ...(checked?.errors ?? [])];

  const days = new Map<string, ImportPreview["days"][number]>();
  const campaigns = new Map(
    plan.campaigns.map((c) => [
      c.id,
      { id: c.id, name: c.name, adSets: 0, spend: 0, impressions: 0, results: 0 },
    ]),
  );
  for (const s of plan.adSets) campaigns.get(s.campaignId)!.adSets++;
  const totals = { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, results: 0 };
  for (const r of plan.insights) {
    const results = resultsOf(r, plan);
    if (r.level === "account") {
      days.set(r.date, {
        date: r.date,
        spend: round2(r.m.spend),
        impressions: r.m.impressions,
        clicks: r.m.clicks,
        results,
      });
      totals.spend += r.m.spend;
      totals.impressions += r.m.impressions;
      totals.clicks += r.m.clicks;
      totals.linkClicks += r.m.linkClicks;
      totals.results += results;
    } else if (r.level === "campaign") {
      const c = campaigns.get(r.entityId)!;
      c.spend += r.m.spend;
      c.impressions += r.m.impressions;
      c.results += results;
    }
  }
  totals.spend = round2(totals.spend);

  return {
    ok: errors.length === 0,
    errors,
    warnings: plan.warnings,
    account: plan.accountId
      ? {
          id: plan.accountId,
          name: plan.accountName ?? checked?.existingName ?? plan.accountId,
          currency: plan.currency,
          state: checked?.state ?? "new",
        }
      : null,
    dateFrom: plan.dateFrom,
    dateTo: plan.dateTo,
    levelsInFile: plan.levelsInFile,
    derivedLevels: plan.derivedLevels,
    rowsByLevel: plan.rowsByLevel,
    resultEvent: plan.resultEvent,
    resultLabel: plan.resultLabel,
    mappedColumns: plan.mappedColumns,
    ignoredColumns: plan.ignoredColumns,
    totals,
    days: [...days.values()],
    campaigns: [...campaigns.values()]
      .map((c) => ({ ...c, spend: round2(c.spend) }))
      .sort((a, b) => b.spend - a.spend),
    replaces: checked?.replaces ?? null,
    fileSha256: createHash("sha256").update(opts.csv).digest("hex"),
  };
}

/**
 * Write the plan. The upload is authoritative for its date range: every insight row of the account
 * dated inside it is replaced, at every level, so a corrected re-export simply supersedes the old.
 */
export async function commitMetaImport(input: ImportOptions): Promise<ImportCommitResult> {
  const me = await guard();
  const opts = importInput.parse(input);
  const plan = planImport(opts);
  const accountId = plan.accountId!;
  const dateFrom = plan.dateFrom!;
  const dateTo = plan.dateTo!;
  const batchId = randomUUID();
  const spend = round2(
    plan.insights.reduce((n, r) => (r.level === "account" ? n + r.m.spend : n), 0),
  );

  await db.transaction(async (tx) => {
    // Re-validated inside the transaction: the preview the operator approved may be minutes old.
    const checked = plan.errors.length ? null : await checkAgainstDb(tx, plan);
    const errors = [...plan.errors, ...(checked?.errors ?? [])];
    if (!checked || errors.length) {
      const shown = errors
        .slice(0, 5)
        .map((e) => (e.row ? `row ${e.row}: ${e.message}` : e.message));
      throw new Error(`Import refused — ${shown.join(" · ")}`);
    }
    const now = new Date();
    const name = plan.accountName ?? checked.existingName ?? accountId;

    await tx
      .insert(schema.accounts)
      .values({ id: accountId, name, currency: plan.currency, syncedAt: now })
      .onConflictDoUpdate({
        target: schema.accounts.id,
        set: { name, currency: plan.currency, syncedAt: now },
        // Belt and braces with the check above: never rewrite an account the sync owns, i.e. one
        // with no earlier upload behind it.
        setWhere: sql`exists (select 1 from ${schema.importBatches} where ${schema.importBatches.accountId} = ${schema.accounts.id})`,
      });
    for (const part of chunks(plan.campaigns)) {
      await tx
        .insert(schema.campaigns)
        .values(
          part.map((c) => ({
            id: c.id,
            accountId,
            name: c.name,
            objective: c.objective,
            syncedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: schema.campaigns.id,
          set: {
            name: sql`excluded.name`,
            objective: sql`coalesce(excluded.objective, ${schema.campaigns.objective})`,
            syncedAt: now,
          },
        });
    }
    // The ad set's optimisation event is what labels a campaign's results ("Registrations").
    const promotedObject = plan.resultEvent ? { custom_event_type: plan.resultEvent } : null;
    for (const part of chunks(plan.adSets)) {
      await tx
        .insert(schema.adSets)
        .values(
          part.map((s) => ({
            id: s.id,
            campaignId: s.campaignId,
            accountId,
            name: s.name,
            promotedObject,
            syncedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: schema.adSets.id,
          set: {
            campaignId: sql`excluded.campaign_id`,
            name: sql`excluded.name`,
            promotedObject: sql`excluded.promoted_object`,
            syncedAt: now,
          },
        });
    }
    for (const part of chunks(plan.ads)) {
      await tx
        .insert(schema.ads)
        .values(
          part.map((a) => ({
            id: a.id,
            adSetId: a.adSetId,
            accountId,
            name: a.name,
            syncedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: schema.ads.id,
          set: { adSetId: sql`excluded.ad_set_id`, name: sql`excluded.name`, syncedAt: now },
        });
    }

    await tx
      .delete(schema.insightsDaily)
      .where(
        and(
          eq(schema.insightsDaily.accountId, accountId),
          gte(schema.insightsDaily.date, dateFrom),
          lte(schema.insightsDaily.date, dateTo),
        ),
      );
    for (const part of chunks(insightRowsOf(plan))) {
      await tx.insert(schema.insightsDaily).values(part.map((r) => ({ ...r, syncedAt: now })));
    }

    await tx.insert(schema.importBatches).values({
      id: batchId,
      accountId,
      fileName: opts.fileName ?? null,
      fileSha256: createHash("sha256").update(opts.csv).digest("hex"),
      dateFrom,
      dateTo,
      rowsByLevel: plan.rowsByLevel,
      spend,
      uploadedBy: me.email,
      uploadedAt: now,
    });
  });

  const rows = Object.values(plan.rowsByLevel).reduce((a, b) => a + b, 0);
  await audit(
    "import.csv",
    `${accountId} ${dateFrom}..${dateTo}: ${rows} insight rows, ${spend} ${plan.currency}` +
      (opts.fileName ? ` (${opts.fileName})` : ""),
  );
  return { batchId, accountId, dateFrom, dateTo, rowsByLevel: plan.rowsByLevel, spend };
}

export async function fetchImportPage(): Promise<ImportPageData> {
  await guard();
  const accounts = await db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      currency: schema.accounts.currency,
    })
    .from(schema.accounts)
    .where(
      inArray(
        schema.accounts.id,
        db.select({ id: schema.importBatches.accountId }).from(schema.importBatches),
      ),
    )
    .orderBy(schema.accounts.name);
  const ids = accounts.map((a) => a.id);
  const coverage = ids.length
    ? await db
        .select({
          accountId: schema.insightsDaily.accountId,
          dateFrom: sql<string>`min(${schema.insightsDaily.date})::text`,
          dateTo: sql<string>`max(${schema.insightsDaily.date})::text`,
          spend: sql<number>`sum(${schema.insightsDaily.spend})::float`,
        })
        .from(schema.insightsDaily)
        .where(
          and(
            eq(schema.insightsDaily.level, "account"),
            inArray(schema.insightsDaily.accountId, ids),
          ),
        )
        .groupBy(schema.insightsDaily.accountId)
    : [];
  const batches = ids.length
    ? await db
        .select()
        .from(schema.importBatches)
        .where(inArray(schema.importBatches.accountId, ids))
        .orderBy(desc(schema.importBatches.uploadedAt))
    : [];
  const clients = await db
    .select({
      name: schema.clients.name,
      notionAccountIds: schema.clients.notionAccountIds,
      manualAddIds: schema.clients.manualAddIds,
      manualRemoveIds: schema.clients.manualRemoveIds,
    })
    .from(schema.clients)
    .where(isNull(schema.clients.removedAt));
  const owners = new Map<string, string[]>();
  for (const c of clients)
    for (const id of effectiveAccountIds(c)) owners.set(id, [...(owners.get(id) ?? []), c.name]);
  const cov = new Map(coverage.map((c) => [c.accountId, c]));

  return {
    imported: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      dateFrom: cov.get(a.id)?.dateFrom ?? null,
      dateTo: cov.get(a.id)?.dateTo ?? null,
      spend: round2(cov.get(a.id)?.spend ?? 0),
      clients: owners.get(a.id) ?? [],
      batches: batches
        .filter((b) => b.accountId === a.id)
        .map((b) => ({
          id: b.id,
          fileName: b.fileName,
          dateFrom: b.dateFrom,
          dateTo: b.dateTo,
          spend: b.spend,
          rowsByLevel: b.rowsByLevel as Record<ImportLevel, number>,
          uploadedBy: b.uploadedBy,
          uploadedAt: b.uploadedAt.toISOString(),
        })),
    })),
    resultEvents: RESULT_EVENTS,
    templateHeaders: [...IMPORT_TEMPLATE_HEADERS],
  };
}

/** Remove an imported account and everything imported under it. Meta-synced accounts are refused. */
export async function deleteImportedAccount(
  accountId: string,
): Promise<{ ok: true; insightRows: number }> {
  await guard();
  z.string()
    .regex(/^act_\d+$/)
    .parse(accountId);
  const insightRows = await db.transaction(async (tx) => {
    const [acct] = await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId));
    if (!acct) throw new Error(`${accountId} is not in the database.`);
    const [batch] = await tx
      .select({ id: schema.importBatches.id })
      .from(schema.importBatches)
      .where(eq(schema.importBatches.accountId, accountId))
      .limit(1);
    if (!batch)
      throw new Error(
        `${accountId} is synced from Meta; only imported accounts can be deleted here.`,
      );
    const gone = await tx
      .delete(schema.insightsDaily)
      .where(eq(schema.insightsDaily.accountId, accountId))
      .returning({ level: schema.insightsDaily.level });
    await tx
      .delete(schema.insightsBreakdownDaily)
      .where(eq(schema.insightsBreakdownDaily.accountId, accountId));
    await tx.delete(schema.ads).where(eq(schema.ads.accountId, accountId));
    await tx.delete(schema.adSets).where(eq(schema.adSets.accountId, accountId));
    await tx.delete(schema.campaigns).where(eq(schema.campaigns.accountId, accountId));
    await tx.delete(schema.importBatches).where(eq(schema.importBatches.accountId, accountId));
    await tx.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
    return gone.length;
  });
  await audit(
    "import.delete",
    `${accountId}: removed the account and ${insightRows} imported insight rows`,
  );
  return { ok: true, insightRows };
}
