import { FileText, Download } from "lucide-react";
import { fmtCurrency, fmtNumber, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { downloadBlob, downloadCsvRows } from "@/lib/download";
import type { ReportColumn, ReportPayload } from "@/server/agent/report";

/** Format a raw cell value for display, per its column kind. */
function fmtCell(value: string | number, kind: ReportColumn["kind"]): string {
  if (typeof value === "string") return value;
  switch (kind) {
    case "money":
      return fmtCurrency(value);
    case "pct":
      return fmtPct(value);
    case "int":
      return fmtNumber(value);
    case "float":
      return value.toFixed(2);
    default:
      return String(value);
  }
}

/** Plain value for CSV/PDF (numbers rounded, no currency symbols). */
function rawCell(value: string | number, kind: ReportColumn["kind"]): string {
  if (typeof value === "string") return value;
  if (kind === "int") return String(Math.round(value));
  return value.toFixed(2);
}

function reportMatrix(report: ReportPayload): string[][] {
  const body = report.rows.map((r) => r.map((v, i) => rawCell(v, report.columns[i].kind)));
  if (report.totals) body.push(report.totals.map((v, i) => rawCell(v, report.columns[i].kind)));
  return body;
}

function downloadCsv(report: ReportPayload) {
  downloadCsvRows(
    [report.columns.map((c) => c.label), ...reportMatrix(report)],
    `${report.filename}.csv`,
  );
}

async function downloadPdf(report: ReportPayload) {
  // Exception (ts-no-dynamic-import): jspdf + autotable are heavy and only needed on an explicit
  // PDF export click, so they are lazy-loaded to stay out of the main bundle.
  const { default: jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");
  const landscape = report.columns.length > 6;
  const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait" });
  doc.setFontSize(13);
  doc.text(report.title, 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(report.subtitle + (report.note ? `  (${report.note})` : ""), 14, 22);
  autoTable(doc, {
    head: [report.columns.map((c) => c.label)],
    body: reportMatrix(report),
    startY: 27,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [37, 99, 235] },
    ...(report.totals
      ? { footStyles: { fillColor: [241, 245, 249], textColor: 20, fontStyle: "bold" } }
      : {}),
  });
  doc.save(`${report.filename}.pdf`);
}

export function ReportBlock({ report }: { report: ReportPayload }) {
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
          onClick={() => downloadCsv(report)}
          className="h-8 px-3 rounded-md border border-border text-xs font-medium inline-flex items-center gap-1.5 hover:bg-accent"
        >
          <Download className="size-3.5" /> CSV
        </button>
        <button
          onClick={() => void downloadPdf(report)}
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
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card">
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              {report.columns.map((c) => (
                <th
                  key={c.key}
                  className={cn("px-3 py-2 font-semibold", c.kind !== "text" && "text-right")}
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
                      "px-3 py-1.5 font-mono",
                      report.columns[ci].kind !== "text" && "text-right",
                      ci === 0 && report.columns[ci].kind === "text" && "font-sans text-foreground",
                    )}
                  >
                    {fmtCell(v, report.columns[ci].kind)}
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
                      "px-3 py-1.5 font-mono",
                      report.columns[ci].kind !== "text" && "text-right",
                    )}
                  >
                    {fmtCell(v, report.columns[ci].kind)}
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
