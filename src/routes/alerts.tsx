import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getAlerts, getAlertSettings, sendTestAlert } from "@/lib/api/alerts";
import { fmtRelTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import type { AlertSettings } from "@/sync/alerts";

export const Route = createFileRoute("/alerts")({
  head: () => ({
    meta: [
      { title: "Alerts — MetaConsole" },
      { name: "description", content: "Automated anomaly alerts across all ad accounts." },
    ],
  }),
  loader: async () => ({ alerts: await getAlerts(), settings: await getAlertSettings() }),
  component: Alerts,
});

function SettingsPanel({ settings }: { settings: AlertSettings }) {
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [sending, setSending] = useState(false);
  async function test() {
    setSending(true);
    setResult(null);
    try {
      setResult(await sendTestAlert());
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold">Alert settings</h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Trigger</dt>
          <dd className="text-sm font-medium">
            ≥ {Math.round(settings.dropPct * 100)}% spend drop vs 7-day baseline
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Min. baseline</dt>
          <dd className="text-sm font-medium">${settings.minBaseline}/day</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Telegram delivery</dt>
          <dd
            className={cn(
              "text-sm font-medium",
              settings.telegramConfigured ? "text-success" : "text-muted-foreground",
            )}
          >
            {settings.telegramConfigured ? "Configured" : "Not configured"}
          </dd>
        </div>
      </dl>
      <div className="flex items-center gap-3">
        <button
          onClick={test}
          disabled={sending || !settings.telegramConfigured}
          className="h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send test message"}
        </button>
        {result && (
          <span className={cn("text-xs", result.ok ? "text-success" : "text-destructive")}>
            {result.ok ? "Sent ✓ — check the channel" : result.error}
          </span>
        )}
      </div>
    </section>
  );
}

function Alerts() {
  const { alerts, settings } = Route.useLoaderData();
  const open = alerts.filter((a) => a.status === "open").length;
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1100px]">
      <PageHeader
        title="Alerts"
        description="Sudden spend drops that may signal a banned or shadow-banned account or campaign."
      >
        {open > 0 && (
          <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-semibold text-destructive">
            {open} open
          </span>
        )}
      </PageHeader>

      <SettingsPanel settings={settings} />

      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {alerts.length === 0 && (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">
            No alerts — all accounts pacing normally.
          </div>
        )}
        {alerts.map((a) => (
          <div key={a.id} className="flex items-start gap-3 px-5 py-4">
            <AlertTriangle
              className={cn(
                "mt-0.5 size-4 shrink-0",
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
            <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {fmtRelTime(a.createdAt)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
