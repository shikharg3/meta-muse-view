import { useRouter, useRouterState, useSearch } from "@tanstack/react-router";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Download, RefreshCw } from "lucide-react";
import { AccountSwitcher } from "./AccountSwitcher";
import { GlobalSearch } from "./GlobalSearch";
import { RangePicker } from "./RangePicker";
import { getExportCsv } from "@/lib/api/dashboard";
import { toRange } from "@/lib/range";
import type { CsvKind } from "@/server/fns/dashboard";

function csvKindForPath(path: string): CsvKind | null {
  if (path.startsWith("/campaigns")) return "campaigns";
  if (path.startsWith("/creatives")) return "creatives";
  if (path.startsWith("/audiences")) return "breakdowns";
  if (path === "/" || path.startsWith("/accounts")) return "accounts";
  return null;
}

export function TopBar({
  business,
  accounts,
}: {
  business: { businessId: string; accountCount: number };
  accounts: { id: string; name: string }[];
}) {
  const router = useRouter();
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

      <RangePicker />

      <Button
        variant="outline"
        size="sm"
        className="hidden sm:inline-flex h-9 text-xs"
        onClick={() => router.invalidate()}
      >
        <RefreshCw className="size-3.5" /> Refresh
      </Button>
      <Button size="sm" className="h-9 text-xs" onClick={onExport} disabled={!kind}>
        <Download className="size-3.5" /> Export
      </Button>
    </header>
  );
}
