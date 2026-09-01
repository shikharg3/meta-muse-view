import { FileText, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { downloadReportCsv, downloadReportPdf, showCell } from "@/lib/report-export";
import { stampReportExport } from "@/lib/api/reports";
import type { ReportPayload } from "@/server/agent/report";

export function ReportBlock({ report, runId }: { report: ReportPayload; runId?: string }) {
  // Fire-and-forget: a failed stamp must never block or undo a download the user already has.
  const stamp = (format: "csv" | "pdf") => {
    if (!runId) return;
    void stampReportExport({ data: { runId, format } }).catch(() => {});
  };
  // The leading date/dimension column carries the row's identity, so it stays pinned while the
  // metric columns scroll horizontally. Any other first column is just another metric and scrolls
  // with the rest.
  const stickyDim = report.columns[0]?.key === "_period" || report.columns[0]?.key === "_dim";
  // Deliberately NO row virtualization: MAX_ROWS = 500 in src/server/agent/report.ts:520 already
  // caps output, and 500x30 cells is unremarkable for the DOM. Do not add a windowing dependency.
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <FileText className="size-4 text-primary shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{report.title}</div>
          <div className="text-[11px] text-muted-foreground">
            {report.subtitle} · {report.rowCount} row{report.rowCount === 1 ? "" : "s"}
          </div>
        </div>
        <button
          onClick={() => {
            downloadReportCsv(report);
            stamp("csv");
          }}
          className="h-8 px-3 rounded-md border border-border text-xs font-medium inline-flex items-center gap-1.5 hover:bg-accent"
        >
          <Download className="size-3.5" /> CSV
        </button>
        {report.columns.length > 12 && (
          <span className="text-[11px] text-muted-foreground max-w-[14rem] leading-tight">
            PDF is unreadable beyond ~12 columns — use CSV
          </span>
        )}
        <button
          onClick={() => void downloadReportPdf(report).then(() => stamp("pdf"))}
          className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5"
        >
          <Download className="size-3.5" /> PDF
        </button>
      </div>
      {report.note && (
        <div className="px-4 py-2 text-[11px] text-muted-foreground border-b border-border bg-muted/30">
          {report.note}
        </div>
      )}
      <div className="max-h-[60vh] overflow-auto">
        <table className="min-w-max text-xs">
          <thead className="sticky top-0 bg-card">
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              {report.columns.map((c, ci) => (
                <th
                  key={c.key}
                  className={cn(
                    "px-3 py-2 font-semibold whitespace-nowrap",
                    c.kind !== "text" && "text-right",
                    ci === 0 && stickyDim && "sticky left-0 z-20 bg-card",
                  )}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row, ri) => (
              <tr key={ri} className="border-b border-border/50">
                {row.map((v, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      "px-3 py-1.5 font-mono whitespace-nowrap",
                      report.columns[ci].kind !== "text" && "text-right",
                      ci === 0 && report.columns[ci].kind === "text" && "font-sans text-foreground",
                      ci === 0 && stickyDim && "sticky left-0 z-10 bg-card",
                    )}
                  >
                    {showCell(v, report.columns[ci].kind)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {report.totals && (
            <tfoot className="sticky bottom-0 bg-muted/50">
              <tr className="font-semibold border-t border-border">
                {report.totals.map((v, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      "px-3 py-1.5 font-mono whitespace-nowrap",
                      report.columns[ci].kind !== "text" && "text-right",
                      ci === 0 && stickyDim && "sticky left-0 z-10 bg-muted/50",
                    )}
                  >
                    {showCell(v, report.columns[ci].kind)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
