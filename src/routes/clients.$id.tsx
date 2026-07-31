import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ChevronLeft, FileText, AlertCircle, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ClientDetailView } from "@/components/dashboard/ClientDetailView";
import { ReportBuilder, type ReportRequest } from "@/components/chat/ReportBuilder";
import { ReportBlock } from "@/components/chat/ReportBlock";
import {
  getClientDetail,
  getClientBudgets,
  mutateClientAccounts,
  listClients,
  moveCampaignToClient,
} from "@/lib/api/clients";
import { getCurrentUser } from "@/lib/api/auth";
import { isAdmin } from "@/lib/auth/roles";
import { generateClientReport } from "@/lib/api/report";
import type { ReportPayload } from "@/server/agent/report";
import { rangeSearch, rangeSpec, rangeLabel } from "@/lib/range";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/clients/$id")({
  validateSearch: rangeSearch,
  loaderDeps: ({ search }) => rangeSpec(search),
  loader: async ({ params, deps }) => {
    const [detail, budgets, me, clients] = await Promise.all([
      getClientDetail({ data: { id: params.id, ...deps } }),
      getClientBudgets({ data: params.id }),
      getCurrentUser(),
      listClients(),
    ]);
    if (!detail) throw notFound();
    return {
      detail,
      budgets,
      isAdmin: isAdmin(me?.role),
      // Re-attribution targets: every current client except this one.
      moveTargets: clients
        .filter((c) => c.id !== params.id)
        .map((c) => ({ id: c.id, name: c.name })),
    };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.detail.name ?? "Client"} — MetaConsole` }],
  }),
  component: ClientPage,
  notFoundComponent: () => (
    <div className="p-8">
      <Link to="/clients" className="text-xs text-muted-foreground hover:text-foreground">
        ← All clients
      </Link>
      <p className="mt-4 text-sm text-muted-foreground">Client not found.</p>
    </div>
  ),
});

const STATUS_TONE: Record<string, string> = {
  Live: "text-success",
  Paused: "text-warning",
  "On Boarding": "text-primary",
};

function ClientPage() {
  const { detail, budgets, isAdmin, moveTargets } = Route.useLoaderData();
  const search = Route.useSearch();
  const router = useRouter();
  const [showReport, setShowReport] = useState(false);
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const onMutate = async (action: "add" | "remove", accountId: string) => {
    const r = await mutateClientAccounts({ data: { id: detail.id, action, accountId } });
    await router.invalidate();
    return r;
  };

  const runReport = async (req: ReportRequest) => {
    setReportLoading(true);
    setReportError(null);
    setReport(null);
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
    if ("error" in res) setReportError(res.error);
    else setReport(res);
    setReportLoading(false);
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <Link
        to="/clients"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" /> All clients
      </Link>

      <PageHeader
        title={detail.name}
        description={`${detail.accounts.length} ad account${detail.accounts.length === 1 ? "" : "s"} · ${rangeLabel(search)}`}
      >
        <div className="flex items-center gap-2">
          {detail.status && (
            <span
              className={cn(
                "rounded-md border border-border px-2 py-0.5 text-[11px] font-medium",
                STATUS_TONE[detail.status] ?? "text-muted-foreground",
              )}
            >
              {detail.status}
            </span>
          )}
          <button
            onClick={() => setShowReport((v) => !v)}
            className="h-9 px-3 rounded-md border border-border bg-card text-xs font-medium inline-flex items-center gap-1.5 hover:bg-accent"
          >
            <FileText className="size-3.5" /> {showReport ? "Hide report" : "Export report"}
          </button>
        </div>
      </PageHeader>

      {showReport && (
        <div className="grid gap-6 lg:grid-cols-[minmax(300px,360px)_1fr] items-start">
          <ReportBuilder
            clients={[
              {
                id: detail.id,
                name: detail.name,
                status: detail.status,
                accountCount: detail.accounts.length,
              },
            ]}
            lockedClient={{ id: detail.id, name: detail.name }}
            busy={reportLoading}
            onSubmit={(r) => void runReport(r)}
            onClose={() => setShowReport(false)}
          />
          <div className="min-w-0">
            {reportLoading ? (
              <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Generating report…
              </div>
            ) : reportError ? (
              <div className="flex items-center gap-2 p-6 text-sm text-destructive">
                <AlertCircle className="size-4" /> {reportError}
              </div>
            ) : report ? (
              <ReportBlock report={report} />
            ) : (
              <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                Pick columns, breakdown and a range, then Generate to build a CSV/PDF for this
                client.
              </div>
            )}
          </div>
        </div>
      )}

      <ClientDetailView
        detail={detail}
        budgets={budgets}
        isAdmin={isAdmin}
        moveTargets={moveTargets}
        onMoveCampaign={(campaignId, clientId) => {
          void moveCampaignToClient({ data: { campaignId, clientId } }).then(() =>
            router.invalidate(),
          );
        }}
        onMutate={onMutate}
      />
    </div>
  );
}
