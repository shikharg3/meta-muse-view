import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { TrendChart } from "@/components/dashboard/TrendChart";
import { StatusPill } from "@/components/dashboard/StatusPill";
import {
  accounts, campaigns, timeSeries, fmtCurrency, fmtCompact, fmtPct,
} from "@/lib/mock-data";
import { ChevronLeft } from "lucide-react";

export const Route = createFileRoute("/accounts/$id")({
  head: ({ params }) => {
    const a = accounts.find((x) => x.id === params.id);
    return {
      meta: [
        { title: `${a?.name ?? "Account"} — MetaConsole` },
        { name: "description", content: `Performance detail for ${a?.name ?? "ad account"}.` },
      ],
    };
  },
  loader: ({ params }) => {
    const account = accounts.find((a) => a.id === params.id);
    if (!account) throw notFound();
    return { account };
  },
  component: AccountDetail,
  notFoundComponent: () => (
    <div className="p-8">
      <Link to="/accounts" className="text-sm text-primary hover:underline">← Back to accounts</Link>
      <p className="mt-4 text-muted-foreground">Account not found.</p>
    </div>
  ),
});

function AccountDetail() {
  const { account } = Route.useLoaderData();
  const accountCampaigns = campaigns.filter((c) => c.accountId === account.id);

  return (
    <div className="p-6 md:p-8 space-y-8 max-w-[1600px]">
      <Link to="/accounts" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-3.5" /> All accounts
      </Link>
      <PageHeader
        title={account.name}
        description={`${account.id} · ${account.currency} · ${account.status.toLowerCase()}`}
      >
        <StatusPill status={account.status} />
      </PageHeader>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Spend" value={fmtCurrency(account.spend)} delta={8.4} spark={account.spark} />
        <KpiCard label="ROAS" value={`${account.roas.toFixed(2)}x`} delta={2.1} spark={account.spark.slice().reverse()} />
        <KpiCard label="Conversions" value={fmtCompact(account.conversions)} delta={11.3} spark={account.spark} />
        <KpiCard label="CTR" value={fmtPct(account.ctr)} delta={-0.4} spark={account.spark} />
        <KpiCard label="Impressions" value={fmtCompact(account.impressions)} />
        <KpiCard label="Reach" value={fmtCompact(account.reach)} />
        <KpiCard label="Frequency" value={account.frequency.toFixed(2)} />
        <KpiCard label="Revenue" value={fmtCurrency(account.revenue)} delta={14.8} spark={account.spark} />
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold mb-1">Performance Trend</h3>
        <p className="text-xs text-muted-foreground mb-2">Last 30 days · spend &amp; conversions</p>
        <TrendChart data={timeSeries} />
      </section>

      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">Campaigns ({accountCampaigns.length})</h3>
          <Link to="/campaigns" className="text-xs text-primary hover:underline">Open explorer</Link>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
              <th className="text-left px-5 py-2.5">Campaign</th>
              <th className="text-left px-3 py-2.5">Objective</th>
              <th className="text-left px-3 py-2.5">Status</th>
              <th className="text-right px-3 py-2.5">Spend</th>
              <th className="text-right px-3 py-2.5">CTR</th>
              <th className="text-right px-3 py-2.5">CPC</th>
              <th className="text-right px-5 py-2.5">ROAS</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {accountCampaigns.map((c) => (
              <tr key={c.id} className="hover:bg-accent/40">
                <td className="px-5 py-3 font-medium">{c.name}</td>
                <td className="px-3 py-3 text-xs font-mono text-muted-foreground">{c.objective}</td>
                <td className="px-3 py-3"><StatusPill status={c.status} /></td>
                <td className="px-3 py-3 text-right font-mono">{fmtCurrency(c.spend)}</td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">{fmtPct(c.ctr)}</td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">{fmtCurrency(c.cpc)}</td>
                <td className={`px-5 py-3 text-right font-mono ${c.roas >= 3 ? "text-success" : ""}`}>{c.roas.toFixed(2)}x</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
