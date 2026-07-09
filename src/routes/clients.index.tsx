import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { listClients } from "@/lib/api/clients";
import { cn } from "@/lib/utils";
import { Search, ChevronRight } from "lucide-react";
import { rangeSearch } from "@/lib/range";

export const Route = createFileRoute("/clients/")({
  head: () => ({ meta: [{ title: "Clients — MetaConsole" }] }),
  validateSearch: rangeSearch,
  loader: async () => ({ clients: await listClients() }),
  component: Clients,
});

const STATUS_DOT: Record<string, string> = {
  Live: "bg-success",
  Paused: "bg-warning",
  "On Boarding": "bg-primary",
};

function Clients() {
  const { clients } = Route.useLoaderData();
  const search = Route.useSearch();
  const [filter, setFilter] = useState("");
  const [clientStatus, setClientStatus] = useState("active");

  const clientStatuses = useMemo(
    () => Array.from(new Set(clients.map((c) => c.status).filter((s): s is string => !!s))),
    [clients],
  );
  const shown = useMemo(
    () =>
      clients.filter((c) => {
        if (clientStatus === "active" && c.status === "Full Budget Finished") return false;
        if (clientStatus !== "active" && clientStatus !== "all" && c.status !== clientStatus)
          return false;
        return filter.trim() === "" || c.name.toLowerCase().includes(filter.toLowerCase());
      }),
    [clients, filter, clientStatus],
  );

  return (
    <div className="p-6 md:p-8 max-w-[1200px]">
      <PageHeader
        title="Clients"
        description="Per-client performance across every ad account they've ever used, synced from Notion. Open a client for its full campaign detail, date ranges, and report export."
      />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search clients…"
            className="w-full h-9 rounded-md border border-border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <select
          value={clientStatus}
          onChange={(e) => setClientStatus(e.target.value)}
          className="h-9 rounded-md border border-border bg-card px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="active">Active (hide Full Budget Finished)</option>
          <option value="all">All statuses</option>
          {clientStatuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-card overflow-hidden divide-y divide-border">
        {shown.map((c) => (
          <Link
            key={c.id}
            to="/clients/$id"
            params={{ id: c.id }}
            search={{ range: search.range, from: search.from, to: search.to }}
            className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors"
          >
            <span
              className={cn(
                "size-2 rounded-full shrink-0",
                STATUS_DOT[c.status ?? ""] ?? "bg-muted-foreground/40",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium truncate">{c.name}</span>
              <span className="block text-[11px] text-muted-foreground">
                {c.status ?? "—"} · {c.accountCount} account{c.accountCount === 1 ? "" : "s"}
                {c.removedAt && <span className="text-amber-500"> · off board</span>}
              </span>
            </span>
            <ChevronRight className="size-4 text-muted-foreground shrink-0" />
          </Link>
        ))}
        {shown.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            {clients.length === 0
              ? "No clients synced. Configure Notion in Settings."
              : "No clients match."}
          </div>
        )}
      </div>

      <div className="mt-3 text-[11px] text-muted-foreground">
        {shown.length} of {clients.length} clients · synced from Notion
      </div>
    </div>
  );
}
