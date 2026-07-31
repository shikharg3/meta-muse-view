import { createFileRoute, Link } from "@tanstack/react-router";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { PagePendingSkeleton } from "@/components/dashboard/TableSkeleton";
import { TrendChart } from "@/components/dashboard/TrendChart";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { Sparkline } from "@/components/dashboard/Sparkline";
import { BreakdownBar } from "@/components/dashboard/BreakdownBar";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getOverview, getBreakdowns } from "@/lib/api/dashboard";
import { fmtCurrency, fmtCompact, fmtPct } from "@/lib/format";
import { rangeSearch, rangeSpec, rangeLabel } from "@/lib/range";
import { kpiSparks } from "@/lib/sparks";
import { useSort, SortHeader } from "@/components/dashboard/SortableTable";

export const Route = createFileRoute("/overview")({
  head: () => ({
    meta: [
      { title: "Overview — MetaConsole" },
      { name: "description", content: "Aggregate Meta Ads performance across all accounts." },
    ],
  }),
  validateSearch: rangeSearch,
  loaderDeps: ({ search }) => rangeSpec(search),
  loader: async ({ deps }) => {
    const [overview, breakdowns] = await Promise.all([
      getOverview({ data: deps }),
      getBreakdowns({ data: deps }),
    ]);
    return { ...overview, placements: breakdowns.publisher_platform };
  },
  component: Overview,
  pendingComponent: () => <PagePendingSkeleton rows={6} kpis={8} />,
});

function Overview() {
  const { kpis, deltas, results, topAccounts, topCampaigns, trend, placements } =
    Route.useLoaderData();
  const { days, from, to } = Route.useLoaderDeps();
  const sparks = kpiSparks(trend);
  const accounts = useSort(
    topAccounts,
    {
      name: (a) => a.name,
      spend: (a) => a.spend,
      results: (a) => a.results,
    },
    "spend",
  );
  const campaigns = useSort(
    topCampaigns,
    {
      name: (c) => c.name,
      spend: (c) => c.spend,
      results: (c) => c.results,
    },
    "spend",
  );

  return (
    <div className="p-6 md:p-8 space-y-8 max-w-[1600px]">
      <PageHeader
        title="Performance Overview"
        description="Consolidated metrics across all connected ad accounts."
      />

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Total Spend"
          value={fmtCurrency(kpis.spend)}
          delta={deltas.spend}
          spark={sparks.spend}
        />
        <KpiCard label={results.label} value={fmtCompact(results.value)} />
        <KpiCard label="CTR" value={fmtPct(kpis.ctr)} delta={deltas.ctr} spark={sparks.ctr} />
        <KpiCard
          label="Conversions"
          value={fmtCompact(kpis.conversions)}
          delta={deltas.conversions}
          spark={sparks.conversions}
        />
        <KpiCard
          label="Impressions"
          value={fmtCompact(kpis.impressions)}
          delta={deltas.impressions}
          spark={sparks.impressions}
        />
        <KpiCard
          label="Avg. CPC"
          value={fmtCurrency(kpis.cpc)}
          delta={deltas.cpc}
          spark={sparks.cpc}
        />
        <KpiCard
          label="Avg. CPM"
          value={fmtCurrency(kpis.cpm)}
          delta={deltas.cpm}
          spark={sparks.cpm}
        />
        <KpiCard
          label="Reach"
          value={fmtCompact(kpis.reach)}
          delta={deltas.reach}
          spark={sparks.reach}
        />
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-sm font-semibold">Spend &amp; Conversions</h3>
              <p className="text-xs text-muted-foreground">
                Daily aggregate · {rangeLabel({ range: days, from, to }).toLowerCase()}
              </p>
            </div>
          </div>
          <TrendChart data={trend} />
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold">Placement Breakdown</h3>
            <p className="text-xs text-muted-foreground">Spend share by placement</p>
          </div>
          <BreakdownBar rows={placements} valueKey="spend" format={(n) => fmtCurrency(n)} />
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h3 className="text-sm font-semibold">Top Accounts by Spend</h3>
            <Link to="/accounts" className="text-xs text-primary hover:underline">
              View all
            </Link>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <SortHeader
                  label="Account"
                  sortKey="name"
                  active={accounts.key}
                  dir={accounts.dir}
                  onSort={accounts.toggle}
                  align="left"
                />
                <SortHeader
                  label="Spend"
                  sortKey="spend"
                  active={accounts.key}
                  dir={accounts.dir}
                  onSort={accounts.toggle}
                  align="right"
                />
                <SortHeader
                  label="Results"
                  sortKey="results"
                  active={accounts.key}
                  dir={accounts.dir}
                  onSort={accounts.toggle}
                  align="right"
                />
                <th className="text-right px-5 py-2.5">Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {accounts.sorted.map((a) => (
                <tr key={a.id} className="hover:bg-accent/40 transition-colors">
                  <td className="px-5 py-3">
                    <Link
                      to="/accounts/$id"
                      params={{ id: a.id }}
                      className="font-medium hover:text-primary"
                    >
                      {a.name}
                    </Link>
                    <div className="font-mono text-[10px] text-muted-foreground">{a.id}</div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{fmtCurrency(a.spend)}</td>
                  <td className="px-3 py-3 text-right font-mono">
                    {fmtCompact(a.results)}{" "}
                    <span className="text-muted-foreground">{a.resultLabel.toLowerCase()}</span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end">
                      <Sparkline data={a.spark} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h3 className="text-sm font-semibold">Top Campaigns by Spend</h3>
            <Link to="/campaigns" className="text-xs text-primary hover:underline">
              Explorer
            </Link>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <SortHeader
                  label="Campaign"
                  sortKey="name"
                  active={campaigns.key}
                  dir={campaigns.dir}
                  onSort={campaigns.toggle}
                  align="left"
                />
                <SortHeader
                  label="Spend"
                  sortKey="spend"
                  active={campaigns.key}
                  dir={campaigns.dir}
                  onSort={campaigns.toggle}
                  align="right"
                />
                <SortHeader
                  label="Results"
                  sortKey="results"
                  active={campaigns.key}
                  dir={campaigns.dir}
                  onSort={campaigns.toggle}
                  align="right"
                />
                <th className="text-right px-5 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {campaigns.sorted.map((c) => (
                <tr key={c.id} className="hover:bg-accent/40 transition-colors">
                  <td className="px-5 py-3">
                    <div className="font-medium truncate max-w-[260px]">{c.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate max-w-[260px]">
                      {c.accountName}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{fmtCurrency(c.spend)}</td>
                  <td className="px-3 py-3 text-right font-mono">
                    {fmtCompact(c.results)}{" "}
                    <span className="text-muted-foreground">{c.resultLabel.toLowerCase()}</span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <StatusPill status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
