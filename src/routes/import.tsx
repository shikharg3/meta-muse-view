import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileUp,
  LogOut,
  Trash2,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import {
  commitImport,
  deleteImportedAccount,
  getImportPage,
  previewImport,
} from "@/lib/api/meta-import";
import { downloadCsvRows } from "@/lib/download";
import { fmtCurrency, fmtNumber } from "@/lib/format";
import type { ImportPreview } from "@/server/fns/meta-import";
import type { ImportIssue } from "@/server/meta-import";

/**
 * CSV import for ad accounts MetaConsole's Business Manager cannot read. Served only on
 * IMPORT_HOSTS (the droplet's bare IP): `src/server.ts` 404s the path elsewhere, and every server fn
 * behind this page re-checks the host and the admin role.
 */
export const Route = createFileRoute("/import")({
  head: () => ({ meta: [{ title: "CSV import — MetaConsole" }] }),
  loader: async () => {
    try {
      return await getImportPage();
    } catch {
      // Wrong host or not an admin. Either way the page does not exist for this caller.
      throw notFound();
    }
  },
  component: ImportPage,
});

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function ImportPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [opts, setOpts] = useState({
    accountId: "",
    accountName: "",
    currency: "",
    resultEvent: "auto",
  });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const payload = (f: { name: string; csv: string }) => ({
    csv: f.csv,
    fileName: f.name,
    accountId: opts.accountId.trim() || null,
    accountName: opts.accountName.trim() || null,
    currency: opts.currency.trim() || null,
    resultEvent: opts.resultEvent,
  });

  const runPreview = async (f: { name: string; csv: string }) => {
    setBusy("preview");
    setMsg(null);
    try {
      setPreview(await previewImport({ data: payload(f) }));
    } catch (e) {
      setPreview(null);
      setMsg({ tone: "bad", text: `Preview failed: ${errorText(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const onPick = async (picked: File | undefined) => {
    if (!picked) return;
    const f = { name: picked.name, csv: await picked.text() };
    setFile(f);
    await runPreview(f);
  };

  const onCommit = async () => {
    if (!file || !preview?.ok) return;
    if (
      preview.replaces &&
      !window.confirm(
        `Replace the ${fmtNumber(preview.replaces.rows)} rows already imported for ` +
          `${preview.dateFrom} … ${preview.dateTo}? Every level of this account in that range is overwritten.`,
      )
    )
      return;
    setBusy("commit");
    setMsg(null);
    try {
      const r = await commitImport({ data: payload(file) });
      const rows = Object.values(r.rowsByLevel).reduce((a, b) => a + b, 0);
      setMsg({
        tone: "ok",
        text: `Imported ${fmtNumber(rows)} rows for ${r.accountId}, ${r.dateFrom} … ${r.dateTo}.`,
      });
      setFile(null);
      setPreview(null);
      await router.invalidate();
    } catch (e) {
      setMsg({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (accountId: string, name: string) => {
    if (
      !window.confirm(
        `Delete ${name} (${accountId}) and every row imported for it? Reports and dashboards lose its spend.`,
      )
    )
      return;
    try {
      const r = await deleteImportedAccount({ data: { accountId } });
      setMsg({
        tone: "ok",
        text: `Deleted ${accountId} and ${fmtNumber(r.insightRows)} imported rows.`,
      });
      await router.invalidate();
    } catch (e) {
      setMsg({ tone: "bad", text: errorText(e) });
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="p-6 md:p-8 space-y-6 max-w-5xl mx-auto">
        <PageHeader
          title="Ad account CSV import"
          description="For ad accounts MetaConsole's Business Manager cannot read. An Ads Manager export lands under the account's real IDs and counts in dashboards, reports and the daily update like synced data."
        >
          <a
            href="/adset-reports"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
          >
            Ad-set reports
          </a>
          <a
            href="/auth/logout"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
          >
            <LogOut className="size-3.5" /> Sign out
          </a>
        </PageHeader>

        <section className="rounded-xl border border-border bg-card p-6 space-y-3">
          <h3 className="text-sm font-semibold">1 · Export from Ads Manager</h3>
          <ol className="list-decimal pl-5 space-y-1 text-xs text-muted-foreground">
            <li>
              Open the account in Ads Manager, pick the date range, and go to the <b>Ads</b> tab (or
              Ad sets).
            </li>
            <li>
              <b>Breakdown → By time → Day.</b> One row per ad per day.
            </li>
            <li>
              Columns: the template's — at minimum{" "}
              <b>
                Account ID, Campaign ID, Campaign name, Ad set ID, Ad set name, Amount spent,
                Impressions
              </b>
              , plus Reach, Clicks (all), Link clicks and the conversion columns you report on (e.g.
              Registrations Completed). Other columns are ignored.
            </li>
            <li>
              <b>Export → CSV.</b> Upload the file as it is: re-saving it in Excel can round the
              long IDs.
            </li>
          </ol>
          <button
            onClick={() => downloadCsvRows([data.templateHeaders], "meta-import-template.csv")}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-4 text-xs font-medium"
          >
            <Download className="size-3.5" /> Download template
          </button>
        </section>

        <section className="rounded-xl border border-border bg-card p-6 space-y-4">
          <h3 className="text-sm font-semibold">2 · Upload and check</h3>
          <label className="flex items-center gap-3 rounded-lg border border-dashed border-border p-4 cursor-pointer hover:bg-accent/40">
            <FileUp className="size-5 text-primary" />
            <span className="text-xs">
              {file ? (
                <>
                  <b>{file.name}</b> · {fmtNumber(file.csv.length / 1024)} KB — choose another file
                </>
              ) : (
                "Choose the exported .csv"
              )}
            </span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                void onPick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Input
              label="Account ID (if not in file)"
              value={opts.accountId}
              placeholder="act_123…"
              onChange={(v) => setOpts({ ...opts, accountId: v })}
            />
            <Input
              label="Account name (if not in file)"
              value={opts.accountName}
              onChange={(v) => setOpts({ ...opts, accountName: v })}
            />
            <Input
              label="Currency (override)"
              value={opts.currency}
              placeholder="from file, else USD"
              onChange={(v) => setOpts({ ...opts, currency: v.toUpperCase() })}
            />
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Result event
              </span>
              <select
                value={opts.resultEvent}
                onChange={(e) => setOpts({ ...opts, resultEvent: e.target.value })}
                className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-xs font-mono"
              >
                <option value="auto">Auto (most volume in file)</option>
                <option value="none">None (label from objective)</option>
                {data.resultEvents.map((e) => (
                  <option key={e.event} value={e.event}>
                    {e.label} ({e.event})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => file && void runPreview(file)}
              disabled={!file || busy !== null}
              className="h-9 px-4 rounded-md border border-border text-xs font-medium disabled:opacity-50"
            >
              {busy === "preview" ? "Checking…" : "Re-check with these settings"}
            </button>
            <button
              onClick={() => void onCommit()}
              disabled={!preview?.ok || busy !== null}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              {busy === "commit" ? "Importing…" : "Import"}
            </button>
            {msg && (
              <span
                className={`inline-flex items-center gap-1 text-xs ${msg.tone === "ok" ? "text-success" : "text-destructive"}`}
              >
                {msg.tone === "ok" ? (
                  <CheckCircle2 className="size-3.5" />
                ) : (
                  <XCircle className="size-3.5" />
                )}
                {msg.text}
              </span>
            )}
          </div>
          {preview && <PreviewPanel p={preview} />}
        </section>

        <section className="rounded-xl border border-border bg-card p-6 space-y-4">
          <h3 className="text-sm font-semibold">Imported accounts</h3>
          {data.imported.length === 0 && (
            <p className="text-xs text-muted-foreground">Nothing imported yet.</p>
          )}
          {data.imported.map((a) => (
            <div key={a.id} className="rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate">{a.name}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {a.id} · {a.currency} · {a.dateFrom ? `${a.dateFrom} … ${a.dateTo}` : "no rows"}{" "}
                    · {fmtCurrency(a.spend, a.currency, 2)}
                  </div>
                </div>
                <button
                  onClick={() => void onDelete(a.id, a.name)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-3.5" /> Delete
                </button>
              </div>
              {a.clients.length ? (
                <div className="text-xs">
                  Counts for: <b>{a.clients.join(", ")}</b>
                </div>
              ) : (
                <div className="flex items-start gap-1.5 text-xs text-amber-500">
                  <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                  Not linked to any client yet, so no client total includes it. Add {a.id} to the
                  client's "Other ad accounts" on the Notion campaigns board, or add it on the
                  client's page.
                </div>
              )}
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left py-1 font-semibold">Uploaded</th>
                    <th className="text-left py-1 font-semibold">File</th>
                    <th className="text-left py-1 font-semibold">Range</th>
                    <th className="text-right py-1 font-semibold">Spend</th>
                    <th className="text-right py-1 font-semibold">Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {a.batches.map((b) => (
                    <tr key={b.id} className="border-t border-border">
                      <td className="py-1.5">
                        {new Date(b.uploadedAt).toLocaleString()} · {b.uploadedBy}
                      </td>
                      <td className="py-1.5 truncate max-w-[220px]">{b.fileName ?? "—"}</td>
                      <td className="py-1.5 font-mono">
                        {b.dateFrom} … {b.dateTo}
                      </td>
                      <td className="py-1.5 text-right font-mono">
                        {fmtCurrency(b.spend, a.currency, 2)}
                      </td>
                      <td className="py-1.5 text-right font-mono">
                        {fmtNumber(Object.values(b.rowsByLevel).reduce((x, y) => x + y, 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function PreviewPanel({ p }: { p: ImportPreview }) {
  const currency = p.account?.currency ?? "USD";
  return (
    <div className="space-y-4 border-t border-border pt-4">
      <Issues issues={p.errors} tone="bad" />
      <Issues issues={p.warnings} tone="warn" />
      {p.account && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile
            label={p.account.state === "new" ? "Account (new)" : "Account (already imported)"}
            value={p.account.name}
            sub={`${p.account.id} · ${p.account.currency}`}
          />
          <Tile
            label="Days"
            value={p.dateFrom ? `${p.dateFrom} … ${p.dateTo}` : "—"}
            sub={`${p.days.length} days`}
          />
          <Tile
            label="Spend"
            value={fmtCurrency(p.totals.spend, currency, 2)}
            sub={`${fmtNumber(p.totals.impressions)} impressions`}
          />
          <Tile
            label="Results"
            value={
              p.resultLabel ? `${fmtNumber(p.totals.results)} ${p.resultLabel}` : "no result event"
            }
            sub={p.resultEvent ?? "label from objective"}
          />
        </div>
      )}
      {p.replaces && (
        <p className="text-xs text-amber-500">
          Replaces {fmtNumber(p.replaces.rows)} rows already imported in this range (
          {fmtCurrency(p.replaces.spend, currency, 2)} spend).
        </p>
      )}
      {p.account && (
        <p className="text-[11px] text-muted-foreground">
          Rows:{" "}
          {(["account", "campaign", "adset", "ad"] as const)
            .map((l) => `${l} ${p.rowsByLevel[l]}`)
            .join(" · ")}
          {p.derivedLevels.length > 0 && ` — ${p.derivedLevels.join(", ")} summed from finer rows`}
        </p>
      )}
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">
          Columns: {p.mappedColumns.length} read, {p.ignoredColumns.length} ignored
        </summary>
        <div className="mt-2 grid md:grid-cols-2 gap-2">
          <div>
            {p.mappedColumns.map((c) => (
              <div key={c.header} className="font-mono">
                {c.header} → {c.field}
              </div>
            ))}
          </div>
          <div className="font-mono">{p.ignoredColumns.join(", ") || "none ignored"}</div>
        </div>
      </details>
      {p.campaigns.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="text-left py-1 font-semibold">Campaign</th>
              <th className="text-right py-1 font-semibold">Ad sets</th>
              <th className="text-right py-1 font-semibold">Spend</th>
              <th className="text-right py-1 font-semibold">Impressions</th>
              <th className="text-right py-1 font-semibold">{p.resultLabel ?? "Results"}</th>
            </tr>
          </thead>
          <tbody>
            {p.campaigns.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="py-1.5">
                  {c.name} <span className="font-mono text-muted-foreground">{c.id}</span>
                </td>
                <td className="py-1.5 text-right font-mono">{c.adSets}</td>
                <td className="py-1.5 text-right font-mono">{fmtCurrency(c.spend, currency, 2)}</td>
                <td className="py-1.5 text-right font-mono">{fmtNumber(c.impressions)}</td>
                <td className="py-1.5 text-right font-mono">{fmtNumber(c.results)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.days.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">By day</summary>
          <table className="w-full mt-2">
            <tbody>
              {p.days.map((d) => (
                <tr key={d.date} className="border-t border-border">
                  <td className="py-1 font-mono">{d.date}</td>
                  <td className="py-1 text-right font-mono">{fmtCurrency(d.spend, currency, 2)}</td>
                  <td className="py-1 text-right font-mono">{fmtNumber(d.impressions)} impr.</td>
                  <td className="py-1 text-right font-mono">{fmtNumber(d.clicks)} clicks</td>
                  <td className="py-1 text-right font-mono">
                    {fmtNumber(d.results)} {p.resultLabel ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Issues({ issues, tone }: { issues: ImportIssue[]; tone: "bad" | "warn" }) {
  if (!issues.length) return null;
  return (
    <ul
      className={`rounded-lg border p-3 space-y-1 text-xs ${tone === "bad" ? "border-destructive/40 text-destructive" : "border-amber-500/40 text-amber-500"}`}
    >
      {issues.map((e, i) => (
        <li key={i}>
          {e.row !== null && <span className="font-mono">row {e.row}: </span>}
          {e.message}
        </li>
      ))}
    </ul>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </div>
      <div className="text-sm font-semibold mt-1 truncate">{value}</div>
      {sub && <div className="font-mono text-[11px] text-muted-foreground truncate">{sub}</div>}
    </div>
  );
}

function Input({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-xs font-mono"
      />
    </label>
  );
}
