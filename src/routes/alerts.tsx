import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getAlerts, getAlertSettings, getUnassignedSpend, sendTestAlert } from "@/lib/api/alerts";
import { fmtRelTime, fmtCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import type { AlertSettings, UnassignedCampaign } from "@/sync/alerts";

export const Route = createFileRoute("/alerts")({
  head: () => ({
    meta: [
      { title: "Alerts — MetaConsole" },
      { name: "description", content: "Automated anomaly alerts across all ad accounts." },
    ],
  }),
  loader: async () => {
    const [alerts, settings, unassigned] = await Promise.all([
      getAlerts(),
      getAlertSettings(),
      getUnassignedSpend(),
    ]);
    return { alerts, settings, unassigned };
  },
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

/**
 * Contested campaigns nobody owns. Kept out of the feed below: every other alert is an event that
 * happened on a date, while this is a standing backlog whose spend is missing from every client's
 * figures until someone assigns it — one row among a hundred dated alerts is not a call-out.
 */
function UnassignedPanel({
  data,
}: {
  data: { count: number; spend: number; items: UnassignedCampaign[] };
}) {
  if (data.count === 0) return null;
  const items = data.items;
  return (
    <section className="overflow-hidden rounded-xl border border-warning/40 bg-warning/5">
      <div className="px-5 py-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle className="size-4 text-warning" />
          Spend assigned to no client
          <span className="font-normal text-muted-foreground">
            ({data.count} · {fmtCurrency(data.spend)})
          </span>
        </h3>
        <p className="mt-1 max-w-3xl text-[11px] text-muted-foreground">
          These campaigns run on ad accounts two clients share, and nothing decides whose they are —
          not the campaign name, not Notion&rsquo;s &ldquo;Active Account ID&rdquo; column. Their
          spend is <strong>excluded from every client&rsquo;s totals and reports</strong> until an
          admin assigns them. Open a claimant below to assign.
        </p>
      </div>
      <div className="divide-y divide-border border-t border-border">
        {items.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{u.campaign}</div>
              <div className="text-[10px] text-muted-foreground">
                on{" "}
                <Link
                  to="/accounts/$id"
                  params={{ id: u.accountId }}
                  className="hover:text-primary hover:underline"
                >
                  {u.accountName ?? u.accountId}
                </Link>
              </div>
            </div>
            <div className="shrink-0 font-mono text-sm">{fmtCurrency(u.spend)}</div>
            <div className="flex shrink-0 items-center gap-1.5">
              {u.claimants.map((c) => (
                <Link
                  key={c.id}
                  to="/clients/$id"
                  params={{ id: c.id }}
                  className="rounded border border-border bg-card px-2 py-1 text-[10px] font-medium hover:border-primary hover:text-primary"
                >
                  {c.name}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Alerts() {
  const { alerts, settings, unassigned } = Route.useLoaderData();
  // The standing backlog gets its own panel, so the dated feed stays a feed.
  const feed = alerts.filter((a) => a.type !== "unassigned_spend");
  const open = feed.filter((a) => a.status === "open").length;
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1100px]">
      <PageHeader
        title="Alerts"
        description="Spend drops that may signal a banned or shadow-banned account, disabled or nearly-drained accounts, and campaign spend not assigned to any client."
      >
        {open > 0 && (
          <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-semibold text-destructive">
            {open} open
          </span>
        )}
      </PageHeader>

      <UnassignedPanel data={unassigned} />

      <SettingsPanel settings={settings} />

      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {feed.length === 0 && (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">
            No alerts — all accounts pacing normally.
          </div>
        )}
        {feed.map((a) => (
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
