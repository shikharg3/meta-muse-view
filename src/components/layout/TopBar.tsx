import { Link, useRouter, useRouterState, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Download, RefreshCw } from "lucide-react";
import { AccountSwitcher } from "./AccountSwitcher";
import { GlobalSearch } from "./GlobalSearch";
import { RangePicker } from "./RangePicker";
import { getExportCsv } from "@/lib/api/dashboard";
import { toRange } from "@/lib/range";
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

/** Data-freshness chip: last completed insights sync, colored by staleness. */
function SyncFreshness({ lastSyncAt, isAdmin }: { lastSyncAt: string | null; isAdmin: boolean }) {
  const ageMin = lastSyncAt ? (Date.now() - new Date(lastSyncAt).getTime()) / 60_000 : Infinity;
  const tone = ageMin <= 120 ? "bg-success" : ageMin <= 360 ? "bg-warning" : "bg-destructive";
  const cls =
    "hidden xl:flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 h-9 text-[11px] text-muted-foreground";
  const title = lastSyncAt ? `Last insights sync: ${lastSyncAt}` : "No sync has completed yet";
  const inner = (
    <>
      <span className={cn("size-1.5 rounded-full", tone)} />
      <span className="font-mono">
        {lastSyncAt ? `synced ${fmtRelTime(lastSyncAt)}` : "never synced"}
      </span>
    </>
  );
  // Only admins can reach Settings, so only they get the link.
  return isAdmin ? (
    <Link to="/settings" title={title} className={cn(cls, "hover:bg-accent transition-colors")}>
      {inner}
    </Link>
  ) : (
    <div title={title} className={cls}>
      {inner}
    </div>
  );
}

/** Refetches all route loaders, with a spinner + disabled state so it's clear something happened. */
function RefreshButton() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await router.invalidate();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      className="hidden sm:inline-flex h-9 text-xs"
      onClick={() => void refresh()}
      disabled={refreshing}
    >
      <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
      {refreshing ? "Refreshing…" : "Refresh"}
    </Button>
  );
}

export function TopBar({
  business,
  accounts,
  isAdmin = false,
}: {
  business: { businessId: string; accountCount: number; lastSyncAt: string | null };
  accounts: { id: string; name: string }[];
  isAdmin?: boolean;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const search = useSearch({ strict: false }) as { range?: number };
  const range = toRange(search.range);
  const kind = csvKindForPath(path);

  async function onExport() {
    if (!kind) return;
    const csv = await getExportCsv({ data: { kind, days: range } });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind}-${range}d.csv`;
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
      <GlobalSearch />

      <div className="flex-1 lg:hidden" />

      <SyncFreshness lastSyncAt={business.lastSyncAt} isAdmin={isAdmin} />
      <RangePicker />

      <RefreshButton />
      <Button size="sm" className="h-9 text-xs" onClick={onExport} disabled={!kind}>
        <Download className="size-3.5" /> Export
      </Button>
    </header>
  );
}
