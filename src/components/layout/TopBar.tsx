import { Link, useRouter, useRouterState, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { CloudDownload, Download, RefreshCw, Table2 } from "lucide-react";
import { AccountSwitcher } from "./AccountSwitcher";
import { GlobalClientFilter, type FilterClient } from "./GlobalClientFilter";
import { GlobalSearch } from "./GlobalSearch";
import { RangePicker } from "./RangePicker";
import { getExportCsv } from "@/lib/api/dashboard";
import { syncNow, syncNotionNow } from "@/lib/api/settings";
import { getMetaHealth } from "@/lib/api/health";
import { toRange, isYmd } from "@/lib/range";
import { fmtRelTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CsvKind } from "@/server/fns/dashboard";

function csvKindForPath(path: string): CsvKind | null {
  if (path.startsWith("/campaigns")) return "campaigns";
  if (path.startsWith("/creatives")) return "creatives";
  if (path.startsWith("/audiences")) return "breakdowns";
  if (path === "/overview" || path.startsWith("/accounts")) return "accounts";
  return null;
}

/** Always-on data-freshness pill: pastel green when the sync is current, pastel red when data is
 *  stale (>3h ≈ several missed hourly cycles). Polls the shared health query so it stays live
 *  without a navigation, and links admins to Settings → Sync. */
function SyncFreshness({ isAdmin }: { isAdmin: boolean }) {
  const { data } = useQuery({
    queryKey: ["meta-health"],
    queryFn: () => getMetaHealth(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const last = data?.lastRefreshAt ?? null;
  const ageMin = last ? (Date.now() - Date.parse(last)) / 60_000 : Infinity;
  const stale = ageMin > 180;
  const title = last
    ? `Last successful data refresh: ${new Date(last).toLocaleString()}${stale ? " — sync looks stale" : ""}`
    : "No sync has completed yet";
  const cls = cn(
    "flex items-center gap-1.5 rounded-md border px-2.5 h-9 text-[11px] font-medium transition-colors",
    stale
      ? "border-rose-300 bg-rose-200 text-rose-900"
      : "border-emerald-300 bg-emerald-200 text-emerald-900",
  );
  const inner = (
    <>
      <RefreshCw className="size-3 shrink-0" />
      <span className="font-mono whitespace-nowrap">
        {last ? `Updated ${fmtRelTime(last)}` : "Never synced"}
      </span>
    </>
  );
  return isAdmin ? (
    <Link to="/settings" title={title} className={cn(cls, "hover:opacity-90")}>
      {inner}
    </Link>
  ) : (
    <div title={title} className={cls}>
      {inner}
    </div>
  );
}

/** Admin-only: triggers a real Meta Marketing API sync in the background. */
function SyncNowButton({ running }: { running: boolean }) {
  const router = useRouter();
  const [triggering, setTriggering] = useState(false);
  const busy = running || triggering;
  // While a cycle is in flight, keep loader data fresh so the freshness chip and
  // this button's state update as accounts finish syncing.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void router.invalidate(), 5000);
    return () => clearInterval(t);
  }, [running, router]);
  const onSync = async () => {
    if (busy) return;
    setTriggering(true);
    try {
      await syncNow();
      await router.invalidate();
    } finally {
      setTriggering(false);
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      className="hidden sm:inline-flex h-9 text-xs"
      onClick={() => void onSync()}
      disabled={busy}
      title="Pull the latest data from Meta now (runs in the background)"
    >
      {busy ? (
        <RefreshCw className="size-3.5 animate-spin" />
      ) : (
        <CloudDownload className="size-3.5" />
      )}
      {busy ? "Syncing…" : "Sync now"}
    </Button>
  );
}

/** Admin-only: refresh ONLY the Notion client-board mapping (clients, statuses, Active Account
 *  IDs) — fast, no Meta data pull. For "I just edited the sheet" moments. */
function SyncNotionButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await syncNotionNow();
      setMsg(r.ok ? `Notion: ${r.clients} clients` : "Notion sync failed");
      await router.invalidate();
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 5000);
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      className="hidden sm:inline-flex h-9 text-xs"
      onClick={() => void onClick()}
      disabled={busy}
      title="Refresh only the Notion board mapping (clients, statuses, Active Account IDs). Fast — does not pull Meta data."
    >
      {busy ? <RefreshCw className="size-3.5 animate-spin" /> : <Table2 className="size-3.5" />}
      {busy ? "Syncing…" : (msg ?? "Sync Notion")}
    </Button>
  );
}

export function TopBar({
  business,
  accounts,
  filterClients,
  isAdmin = false,
}: {
  business: {
    businessId: string;
    accountCount: number;
    lastSyncAt: string | null;
    syncRunning: boolean;
  };
  accounts: { id: string; name: string }[];
  filterClients: FilterClient[];
  isAdmin?: boolean;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const search = useSearch({ strict: false }) as { range?: number; from?: string; to?: string };
  const range = toRange(search.range);
  const kind = csvKindForPath(path);

  async function onExport() {
    if (!kind) return;
    const custom = Boolean(search.from && search.to && isYmd(search.from) && isYmd(search.to));
    const csv = await getExportCsv({
      data: { kind, days: range, from: search.from, to: search.to },
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = custom ? `${kind}-${search.from}_${search.to}.csv` : `${kind}-${range}d.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <header className="h-14 border-b border-border bg-background/80 backdrop-blur-md sticky top-0 z-20 flex items-center gap-3 px-4 md:px-6">
      <SidebarTrigger className="-ml-1" />
      <div className="h-6 w-px bg-border mx-1" />

      <AccountSwitcher business={business} accounts={accounts} />
      <GlobalClientFilter clients={filterClients} accounts={accounts} />
      <GlobalSearch />

      <div className="flex-1 lg:hidden" />

      <SyncFreshness isAdmin={isAdmin} />
      <RangePicker />

      {isAdmin && <SyncNowButton running={business.syncRunning} />}
      {isAdmin && <SyncNotionButton />}
      <Button size="sm" className="h-9 text-xs" onClick={onExport} disabled={!kind}>
        <Download className="size-3.5" /> Export
      </Button>
    </header>
  );
}
