import { createFileRoute, redirect, Link, useNavigate } from "@tanstack/react-router";
import { Network, Table2 } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { PagePendingSkeleton } from "@/components/dashboard/TableSkeleton";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { InfraGraphCanvas } from "@/components/infra/InfraGraphCanvas";
import { RiskBadge } from "@/components/infra/RiskBadge";
import { getInfraRiskMap } from "@/lib/api/infrastructure";
import { getCurrentUser } from "@/lib/api/auth";
import { isAdmin } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import type { InfraRiskRow } from "@/server/fns/infra/risk";

/** The map is the default: the tables answer "what is broken", the map answers "what does it cost". */
type InfraView = "map" | "table";

export const Route = createFileRoute("/infrastructure/")({
  head: () => ({
    meta: [
      { title: "Infrastructure — MetaConsole" },
      {
        name: "description",
        content:
          "Access-path risk across profiles, Business Managers, ad accounts, pixels and pages.",
      },
    ],
  }),
  validateSearch: (s: Record<string, unknown>): { view?: InfraView } => ({
    view: s.view === "table" ? "table" : undefined,
  }),
  loader: async () => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    return await getInfraRiskMap();
  },
  component: InfrastructurePage,
  pendingComponent: () => <PagePendingSkeleton rows={8} kpis={5} />,
});

/**
 * Rows arrive already sorted critical-first from the server, so this table has no client-side sort —
 * risk order IS the useful order on a triage screen.
 */
function RiskSection({
  title,
  rows,
  emptyLabel,
}: {
  title: string;
  rows: InfraRiskRow[];
  emptyLabel: string;
}) {
  const atRisk = rows.filter((r) => r.risk.level !== "safe").length;
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-[11px] text-muted-foreground font-mono">
          {atRisk} at risk of {rows.length}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
              <th className="text-left px-5 py-2.5">Name</th>
              <th className="text-left px-3 py-2.5">Status</th>
              <th className="text-left px-3 py-2.5">Risk</th>
              <th className="text-left px-5 py-2.5">Access paths</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-accent/40 transition-colors">
                <td className="px-5 py-3">
                  {r.name}
                  {r.overdue && (
                    <span className="ml-2 text-[10px] text-warning">verification overdue</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <StatusPill status={r.status} />
                </td>
                <td className="px-3 py-3">
                  <RiskBadge risk={r.risk} />
                </td>
                <td className="px-5 py-3 text-[11px] text-muted-foreground">{r.detail}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-8 text-center text-sm text-muted-foreground">
                  {emptyLabel}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InfrastructurePage() {
  const map = Route.useLoaderData();
  const { counts } = map;
  const view: InfraView = Route.useSearch().view ?? "map";
  const navigate = useNavigate({ from: "/infrastructure/" });

  const tiles = [
    { label: "Profiles", value: counts.profiles, to: "/infrastructure/profiles" },
    { label: "Business Managers", value: counts.bms, to: "/infrastructure/business-managers" },
    { label: "Ad Accounts", value: counts.adAccounts, to: "/infrastructure/ad-accounts" },
    { label: "Pixels", value: counts.pixels, to: "/infrastructure/pixels" },
    { label: "Pages", value: counts.pages, to: "/infrastructure/pages" },
  ];

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Infrastructure"
        description={
          map.atRisk === 0
            ? "Every registered asset has at least two independent access paths."
            : `${map.atRisk} asset${map.atRisk === 1 ? "" : "s"} with fewer than two independent access paths.`
        }
      >
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {(
            [
              { id: "map", label: "Map", icon: Network },
              { id: "table", label: "Table", icon: Table2 },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() =>
                navigate({ search: { view: tab.id === "map" ? undefined : tab.id }, replace: true })
              }
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                view === tab.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <tab.icon className="size-3.5" />
              {tab.label}
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {tiles.map((tile) => (
          <Link
            key={tile.label}
            to={tile.to}
            className="rounded-xl border border-border bg-card px-4 py-3 hover:bg-accent/40 transition-colors"
          >
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              {tile.label}
            </div>
            <div className="text-2xl font-semibold tabular-nums">{tile.value}</div>
          </Link>
        ))}
      </div>

      {view === "map" ? (
        <InfraGraphCanvas graph={map.graph} />
      ) : (
        <>
          <RiskSection
            title="Business Managers"
            rows={map.bms}
            emptyLabel="No Business Managers registered yet."
          />
          <RiskSection
            title="Ad Accounts"
            rows={map.adAccounts}
            emptyLabel="No ad accounts registered yet."
          />
          <RiskSection title="Pixels" rows={map.pixels} emptyLabel="No pixels registered yet." />
          <RiskSection title="Pages" rows={map.pages} emptyLabel="No pages registered yet." />
        </>
      )}
    </div>
  );
}
