import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, FileText, Loader2 } from "lucide-react";
import { generateClientReport } from "@/lib/api/report";
import { listClients } from "@/lib/api/clients";
import { ReportBuilder, type ReportRequest } from "@/components/chat/ReportBuilder";
import { ReportBlock } from "@/components/chat/ReportBlock";
import type { ReportPayload } from "@/server/agent/report";

export const Route = createFileRoute("/reports")({
  head: () => ({
    meta: [
      { title: "Reports — MetaConsole" },
      {
        name: "description",
        content: "Build client-ready CSV/PDF reports from your synced Meta Ads data.",
      },
    ],
  }),
  loader: async () => ({ clients: (await listClients()).filter((c) => c.removedAt == null) }),
  component: Reports,
});

function Reports() {
  const { clients } = Route.useLoaderData();
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (req: ReportRequest) => {
    setLoading(true);
    setError(null);
    try {
      const res = await generateClientReport({
        data: {
          clientId: req.clientId,
          days: req.days,
          since: req.since,
          until: req.until,
          columns: req.columns,
          breakdown: req.breakdown,
          splitByDay: req.splitByDay,
          markup: req.markup,
          campaignIds: req.campaignIds,
        },
      });
      if ("error" in res) {
        setError(res.error);
        setReport(null);
      } else {
        setReport(res);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 md:px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <FileText className="size-5 text-primary" /> Reports
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
          Build a client-ready CSV or PDF from your synced data. Pick a client, date range, columns,
          and breakdown — add a commission markup to hand the report straight to clients.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(300px,360px)_1fr] items-start">
        <ReportBuilder clients={clients} busy={loading} onSubmit={(r) => void run(r)} />

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
            <ReportBlock report={report} />
          ) : (
            <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
              Pick a client and options, then generate a report.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
