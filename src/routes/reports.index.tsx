import { createFileRoute, Link } from "@tanstack/react-router";
import { listReportRuns } from "@/lib/api/reports";

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const Route = createFileRoute("/reports/")({
  loader: async () => ({ runs: await listReportRuns({ data: {} }) }),
  component: ReportHistory,
});

function ReportHistory() {
  const { runs } = Route.useLoaderData();

  // History lists only EXPORTED runs — `fetchReportRuns` filters on `exported_at` and the sync
  // worker prunes never-exported drafts after 7 days. So this table is a log of what actually left
  // the building, not of every time somebody pressed Generate.
  const rows = Array.isArray(runs) ? runs : null;

  if (rows === null || rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-4 py-12 text-center text-xs text-muted-foreground">
        {rows === null ? (
          "Run history could not be loaded. Reload the page to try again."
        ) : (
          <>
            Nothing exported yet. A report is recorded here the moment you export it as CSV or PDF,
            with its numbers frozen as the client received them —{" "}
            <Link to="/reports/new" className="text-primary underline-offset-2 hover:underline">
              build one
            </Link>
            .
          </>
        )}
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
              <th className="text-left px-3 py-2.5">Client</th>
              <th className="text-left px-3 py-2.5">Range</th>
              <th className="text-right px-3 py-2.5">Rows</th>
              <th className="text-left px-3 py-2.5">Exported</th>
              <th className="text-left px-3 py-2.5">Formats</th>
              <th className="text-left px-3 py-2.5">By</th>
              <th className="text-left px-3 py-2.5">Template</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="transition-colors hover:bg-accent/40">
                <td className="px-3 py-3">
                  <Link
                    to="/reports/$runId"
                    params={{ runId: r.id }}
                    className="block font-medium hover:text-primary"
                  >
                    {r.clientName}
                  </Link>
                </td>
                <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                  {r.since} → {r.until}
                </td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {r.rowCount.toLocaleString()}
                </td>
                <td className="px-3 py-3 text-[11px] text-muted-foreground whitespace-nowrap">
                  {r.exportedAt ? fmtTime(r.exportedAt) : "—"}
                </td>
                <td className="px-3 py-3">
                  <FormatBadges formats={r.exportedFormats} />
                </td>
                <td className="px-3 py-3 text-[11px] text-muted-foreground">
                  {r.ranByEmail ?? "—"}
                </td>
                <td className="px-3 py-3 text-[11px] text-muted-foreground">
                  {r.templateName ?? "Ad hoc"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-5 py-3 border-t border-border text-[11px] text-muted-foreground font-mono">
        {rows.length} exported {rows.length === 1 ? "report" : "reports"}
      </div>
    </div>
  );
}

function FormatBadges({ formats }: { formats: string[] }) {
  if (formats.length === 0) return <span className="text-[11px] text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {formats.map((f) => (
        <span
          key={f}
          className="rounded border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {f}
        </span>
      ))}
    </div>
  );
}
