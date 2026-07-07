import { createFileRoute, redirect } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getSyncStatus } from "@/lib/api/status";
import { getCurrentUser } from "@/lib/api/auth";
import { fmtRelTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Database, RefreshCw, AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import type { DatasetProgress } from "@/server/fns/status";

export const Route = createFileRoute("/sync")({
  head: () => ({ meta: [{ title: "Sync status — MetaConsole" }] }),
  loader: async () => {
    const me = await getCurrentUser();
    if (me?.role !== "admin") throw redirect({ to: "/" });
    return await getSyncStatus();
  },
  component: SyncStatus,
});

function SyncStatus() {
  const s = Route.useLoaderData();
  const healthy = s.rateLimit.eventsLast24h === 0;

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1100px]">
      <PageHeader
        title="Sync status"
        description="Live view of the Meta sync — account coverage, the hourly CORE refresh, historical backfill progress, and rate-limit health."
      />

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <RefreshCw className="size-4 text-primary" /> Coverage &amp; refresh
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile label="Ad accounts" value={s.accounts.total} />
          <Tile label="Structure synced" value={`${s.accounts.structured}/${s.accounts.total}`} />
          <Tile label="Insights synced" value={`${s.accounts.insighted}/${s.accounts.total}`} />
          <Tile
            label="In error"
            value={s.accounts.errored}
            tone={s.accounts.errored ? "bad" : "ok"}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          Last account refreshed {s.refresh.lastAt ? fmtRelTime(s.refresh.lastAt) : "never"}
          {s.refresh.oldestAt && ` · oldest refresh ${fmtRelTime(s.refresh.oldestAt)}`}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 space-y-5">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Database className="size-4 text-primary" /> Historical backfill
        </h3>
        <Progress label="Insights (≈ 37 months)" p={s.backfill.insights} />
        <Progress label="Breakdowns (≈ 13 months)" p={s.backfill.breakdown} />
        <p className="text-[11px] text-muted-foreground">
          Backfill walks ~90 days older per account each cycle (newest history first). It runs in
          the time left after the hourly refresh.
        </p>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 space-y-4">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <ShieldAlert className="size-4 text-primary" /> Rate limit &amp; API health
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Tile
            label="Throttle events (24h)"
            value={s.rateLimit.eventsLast24h}
            tone={healthy ? "ok" : "warn"}
          />
          <Tile
            label="System-user token"
            value={s.rateLimit.tokenValid === false ? "invalid" : "valid"}
            tone={s.rateLimit.tokenValid === false ? "bad" : "ok"}
          />
          <Tile
            label="Token checked"
            value={s.rateLimit.tokenCheckedAt ? fmtRelTime(s.rateLimit.tokenCheckedAt) : "—"}
          />
          <Tile
            label="Access tier"
            value={
              s.rateLimit.tier === "standard"
                ? "Standard"
                : s.rateLimit.tier === "development"
                  ? "Dev tier"
                  : "unknown"
            }
            tone={s.rateLimit.tier === "standard" ? "ok" : s.rateLimit.tier ? "warn" : undefined}
          />
        </div>
        <div
          className={cn(
            "text-xs flex items-center gap-1.5",
            healthy ? "text-success" : "text-amber-500",
          )}
        >
          {healthy ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
          {healthy
            ? "No rate limiting in the last 24h — operating with headroom."
            : `${s.rateLimit.eventsLast24h} rate-limit events in the last 24h.`}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 space-y-3">
        <h3 className="text-sm font-semibold">Recent API events</h3>
        {s.events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No rate-limit or error events recorded.</p>
        ) : (
          <div className="max-h-64 overflow-auto rounded-md border border-border divide-y divide-border">
            {s.events.map((e, i) => (
              <div key={`${e.at}-${i}`} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 font-medium",
                    e.kind === "rate_limit"
                      ? "bg-amber-500/10 text-amber-500"
                      : "bg-destructive/10 text-destructive",
                  )}
                >
                  {e.kind === "rate_limit" ? (e.code === 0 ? "throttle" : `#${e.code}`) : "error"}
                </span>
                {e.accountId && <span className="shrink-0 font-mono">{e.accountId}</span>}
                <span className="flex-1 truncate text-muted-foreground">{e.message}</span>
                {e.pressure ? (
                  <span className="shrink-0 text-muted-foreground">{e.pressure}%</span>
                ) : null}
                {e.retryAfterMin ? (
                  <span className="shrink-0 text-amber-500">~{e.retryAfterMin}m</span>
                ) : null}
                <span className="shrink-0 text-muted-foreground/60">
                  {new Date(e.at).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {s.errors.length > 0 && (
        <section className="rounded-xl border border-border bg-card p-6 space-y-3">
          <h3 className="text-sm font-semibold">Accounts in error ({s.errors.length})</h3>
          <div className="max-h-48 overflow-auto rounded-md border border-border divide-y divide-border">
            {s.errors.map((a) => (
              <div key={a.accountId} className="flex items-start gap-2 px-3 py-1.5 text-[11px]">
                <span className="shrink-0 font-mono">{a.accountId}</span>
                <span className="truncate text-muted-foreground">{a.error}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "ok" | "bad" | "warn";
}) {
  const color =
    tone === "bad"
      ? "text-destructive"
      : tone === "warn"
        ? "text-amber-500"
        : tone === "ok"
          ? "text-success"
          : "";
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("text-lg font-semibold mt-1", color)}>{value}</div>
    </div>
  );
}

function Progress({ label, p }: { label: string; p: DatasetProgress }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {p.pctComplete}% · {p.remainingChunks.toLocaleString()} chunks left
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary rounded-full" style={{ width: `${p.pctComplete}%` }} />
      </div>
      {(p.deepest || p.shallowest) && (
        <div className="text-[10px] text-muted-foreground">
          reached back to {p.deepest ?? "—"} · shallowest account at {p.shallowest ?? "—"}
        </div>
      )}
    </div>
  );
}
