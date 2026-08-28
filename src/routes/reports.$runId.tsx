import { createFileRoute, Link } from "@tanstack/react-router";
import { ReportBlock } from "@/components/chat/ReportBlock";
import { getReportRun } from "@/lib/api/reports";
import { metric } from "@/lib/report-catalog";

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const Route = createFileRoute("/reports/$runId")({
  loader: async ({ params }) => ({ run: await getReportRun({ data: { id: params.runId } }) }),
  component: FrozenRun,
});

function FrozenRun() {
  const { run } = Route.useLoaderData();

  if (!run) {
    return (
      <p className="rounded-md border border-dashed border-border px-4 py-12 text-center text-xs text-muted-foreground">
        No run with that id. Only exported runs are kept — drafts are pruned after 7 days.{" "}
        <Link to="/reports" className="text-primary underline-offset-2 hover:underline">
          Back to history
        </Link>
        .
      </p>
    );
  }

  // The stored payload carries its own `columns`, so the table below renders from itself and never
  // re-consults the live catalog. That is exactly why the whole payload is stored rather than params
  // plus a key list: relabelling, regrouping or dropping a metric cannot make an archived report
  // disagree with the CSV the client already has, and the numbers can never drift.
  //
  // `_dim` is the synthetic dimension/date column assembled in `report.ts`, never a catalog key, so
  // it is excluded rather than counted as missing forever.
  const orphaned = run.payload.columns.filter(
    (c) => c.key !== "_dim" && metric(c.key) === undefined,
  ).length;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">{run.clientName}</h2>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {run.since} → {run.until}
            </p>
          </div>
          <Link
            to="/reports"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Back to history
          </Link>
        </div>

        <dl className="mt-3 grid gap-x-6 gap-y-2 border-t border-border pt-3 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Exported
            </dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span>{run.exportedAt ? fmtTime(run.exportedAt) : "Not exported"}</span>
              {run.exportedFormats.map((f) => (
                <span
                  key={f}
                  className="rounded border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {f}
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Run by
            </dt>
            <dd className="mt-0.5">{run.ranByEmail ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Template
            </dt>
            <dd className="mt-0.5">{run.templateName ?? "Ad hoc"}</dd>
          </div>
        </dl>

        {orphaned > 0 && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {orphaned} column{orphaned === 1 ? "" : "s"} in this report{" "}
            {orphaned === 1 ? "is" : "are"} no longer in the catalog.
          </p>
        )}
      </div>

      {/*
       * No `runId` prop: this is an archive view, so re-downloading the frozen CSV/PDF must not
       * re-stamp the run's export record. The first export is the delivery; a later read is not.
       */}
      <ReportBlock report={run.payload} />
    </div>
  );
}
