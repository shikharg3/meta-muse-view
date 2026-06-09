import { createFileRoute, Link } from "@tanstack/react-router";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { TrendChart } from "@/components/dashboard/TrendChart";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { Sparkline } from "@/components/dashboard/Sparkline";
import { BreakdownBar } from "@/components/dashboard/BreakdownBar";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getOverview, getBreakdowns } from "@/lib/api/dashboard";
import { fmtCurrency, fmtCompact, fmtPct } from "@/lib/format";
import { rangeSearch, toRange } from "@/lib/range";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overview — MetaConsole" },
      { name: "description", content: "Aggregate Meta Ads performance across all accounts." },
    ],
  }),
  validateSearch: rangeSearch,
  loaderDeps: ({ search }) => ({ range: toRange(search.range) }),
  loader: async ({ deps: { range } }) => {
    const [overview, breakdowns] = await Promise.all([getOverview({ data: range }), getBreakdowns({ data: range })]);
    return { ...overview, placements: breakdowns.publisher_platform };
  },
  component: Overview,
});

function Overview() {
  const { kpis, topAccounts, topCampaigns, trend, placements } = Route.useLoaderData();

  return (
    <div className="p-6 md:p-8 space-y-8 max-w-[1600px]">
      <PageHeader
        title="Performance Overview"
        description="Consolidated metrics across all connected ad accounts."
      />

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Spend" value={fmtCurrency(kpis.spend)} delta={12.4} spark={[42, 50, 38, 55, 60, 72, 65, 80, 85, 92, 88, 95]} />
        <KpiCard label="Avg. ROAS" value={`${kpis.roas.toFixed(2)}x`} delta={-2.1} spark={[70, 72, 68, 75, 71, 65, 62, 68, 64, 60, 58, 62]} />
        <KpiCard label="CTR" value={fmtPct(kpis.ctr)} delta={0.4} spark={[30, 35, 40, 38, 45, 42, 50, 48, 52, 55, 53, 58]} />
        <KpiCard label="Conversions" value={fmtCompact(kpis.conversions)} delta={18.2} spark={[50, 55, 60, 58, 65, 70, 68, 75, 78, 82, 88, 94]} />
        <KpiCard label="Impressions" value={fmtCompact(kpis.impressions)} delta={9.6} spark={[55, 60, 58, 65, 70, 68, 72, 75, 80, 78, 84, 88]} />
        <KpiCard label="Avg. CPC" value={fmtCurrency(kpis.cpc)} delta={-5.2} spark={[80, 75, 78, 72, 70, 68, 65, 62, 60, 58, 55, 52]} />
        <KpiCard label="Avg. CPM" value={fmtCurrency(kpis.cpm)} delta={4.1} spark={[60, 62, 65, 64, 68, 70, 72, 74, 76, 75, 78, 80]} />
        <KpiCard label="Reach" value={fmtCompact(kpis.reach)} delta={7.8} spark={[40, 45, 50, 48, 55, 58, 62, 65, 70, 72, 76, 80]} />
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-sm font-semibold">Spend &amp; Conversions</h3>
              <p className="text-xs text-muted-foreground">Daily aggregate · last 30 days</p>
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
            <Link to="/accounts" className="text-xs text-primary hover:underline">View all</Link>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <th className="text-left px-5 py-2.5">Account</th>
                <th className="text-right px-3 py-2.5">Spend</th>
                <th className="text-right px-3 py-2.5">ROAS</th>
                <th className="text-right px-5 py-2.5">Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {topAccounts.map((a) => (
                <tr key={a.id} className="hover:bg-accent/40 transition-colors">
                  <td className="px-5 py-3">
                    <Link to="/accounts/$id" params={{ id: a.id }} className="font-medium hover:text-primary">{a.name}</Link>
                    <div className="font-mono text-[10px] text-muted-foreground">{a.id}</div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{fmtCurrency(a.spend)}</td>
                  <td className={`px-3 py-3 text-right font-mono ${a.roas >= 3 ? "text-success" : a.roas >= 1.5 ? "" : "text-destructive"}`}>{a.roas.toFixed(2)}x</td>
                  <td className="px-5 py-3"><div className="flex justify-end"><Sparkline data={a.spark} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h3 className="text-sm font-semibold">Top Campaigns by ROAS</h3>
            <Link to="/campaigns" className="text-xs text-primary hover:underline">Explorer</Link>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <th className="text-left px-5 py-2.5">Campaign</th>
                <th className="text-right px-3 py-2.5">Spend</th>
                <th className="text-right px-3 py-2.5">ROAS</th>
                <th className="text-right px-5 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {topCampaigns.map((c) => (
                <tr key={c.id} className="hover:bg-accent/40 transition-colors">
                  <td className="px-5 py-3">
                    <div className="font-medium truncate max-w-[260px]">{c.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate max-w-[260px]">{c.accountName}</div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{fmtCurrency(c.spend)}</td>
                  <td className="px-3 py-3 text-right font-mono text-success">{c.roas.toFixed(2)}x</td>
                  <td className="px-5 py-3 text-right"><StatusPill status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
