import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { listClients } from "@/lib/api/clients";
import { listReportTemplates, startReportRun } from "@/lib/api/reports";
import { ReportBuilder, type ReportRequest } from "@/components/chat/ReportBuilder";
import { ReportBlock } from "@/components/chat/ReportBlock";
import type { ReportPayload } from "@/server/agent/report";

export const Route = createFileRoute("/reports/new")({
  validateSearch: (s: Record<string, unknown>): { template?: string } => ({
    template: typeof s.template === "string" ? s.template : undefined,
  }),
  loader: async () => {
    const [clients, templates] = await Promise.all([listClients(), listReportTemplates()]);
    return { clients: clients.filter((c) => c.removedAt == null), templates };
  },
  component: NewReport,
});

function NewReport() {
  const { clients, templates } = Route.useLoaderData();
  const { template: templateId } = Route.useSearch();
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [runId, setRunId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const template = templateId ? templates.find((t) => t.id === templateId) : undefined;
  // `rangePreset` is handed over as a key, not a resolved window, so a template that means "last
  // month" still means it next month. A missing/unknown `?template=` just leaves the builder blank.
  const initial = template
    ? {
        clientId: template.clientId ?? undefined,
        clientName: template.clientName ?? undefined,
        columns: template.columns,
        breakdown: template.breakdown,
        timeIncrement: template.timeIncrement,
        markup: template.markup ?? undefined,
        campaignIds: template.campaignIds ?? undefined,
        rangePreset: template.rangePreset,
      }
    : undefined;

  const run = async (req: ReportRequest) => {
    setLoading(true);
    setError(null);
    try {
      const res = await startReportRun({
        data: {
          templateId: template?.id ?? null,
          clientId: req.clientId,
          preset: req.preset,
          days: req.days,
          since: req.since,
          until: req.until,
          columns: req.columns,
          breakdown: req.breakdown,
          timeIncrement: req.timeIncrement,
          markup: req.markup,
          campaignIds: req.campaignIds,
        },
      });
      if (res.ok) {
        setReport(res.payload);
        setRunId(res.runId);
      } else {
        setError(res.error);
        setReport(null);
        setRunId(undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReport(null);
      setRunId(undefined);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr] items-start">
      <ReportBuilder
        // Remounted per template so the seed lands in fresh state: `initial` is read once, and
        // silently overwriting a half-finished edit would be worse than starting over.
        key={template?.id ?? "blank"}
        clients={clients}
        busy={loading}
        initial={initial}
        onSubmit={(r) => void run(r)}
      />

      <div className="min-w-0">
        {loading ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Generating report…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : report ? (
          <ReportBlock report={report} runId={runId} />
        ) : (
          <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
            Pick a client and options, then generate a report.
          </div>
        )}
      </div>
    </div>
  );
}
