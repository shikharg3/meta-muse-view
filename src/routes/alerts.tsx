import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getAlerts } from "@/lib/api/alerts";
import { fmtRelTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/alerts")({
  head: () => ({
    meta: [
      { title: "Alerts — MetaConsole" },
      { name: "description", content: "Automated anomaly alerts across all ad accounts." },
    ],
  }),
  loader: async () => ({ alerts: await getAlerts() }),
  component: Alerts,
});

function Alerts() {
  const { alerts } = Route.useLoaderData();
  const open = alerts.filter((a) => a.status === "open").length;
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1100px]">
      <PageHeader
        title="Alerts"
        description="Sudden spend drops that may signal a banned or shadow-banned account or campaign."
      >
        {open > 0 && (
          <span className="rounded-full bg-destructive/10 text-destructive text-xs font-semibold px-2.5 py-1">
            {open} open
          </span>
        )}
      </PageHeader>

      <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
        {alerts.length === 0 && (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">
            No alerts — all accounts pacing normally.
          </div>
        )}
        {alerts.map((a) => (
          <div key={a.id} className="flex items-start gap-3 px-5 py-4">
            <AlertTriangle
              className={cn(
                "size-4 mt-0.5 shrink-0",
                a.severity === "critical" ? "text-destructive" : "text-warning",
              )}
            />
            <div className="min-w-0 flex-1">
              <Link
                to="/accounts/$id"
                params={{ id: a.accountId }}
                className="text-sm font-medium hover:text-primary hover:underline"
              >
                {a.accountName ?? a.accountId}
              </Link>
              <div className="text-xs text-muted-foreground">{a.message}</div>
            </div>
            <div className="text-[10px] text-muted-foreground font-mono shrink-0">
              {fmtRelTime(a.createdAt)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
