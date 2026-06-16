import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { TrendChart } from "@/components/dashboard/TrendChart";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { getAccount } from "@/lib/api/dashboard";
import { fmtCurrency, fmtCompact, fmtPct } from "@/lib/format";
import { ChevronLeft } from "lucide-react";
import { rangeSearch, rangeSpec, rangeLabel } from "@/lib/range";
import { kpiSparks } from "@/lib/sparks";
import { useSort, SortHeader } from "@/components/dashboard/SortableTable";

export const Route = createFileRoute("/accounts/$id")({
  validateSearch: rangeSearch,
  loaderDeps: ({ search }) => rangeSpec(search),
  loader: async ({ params, deps }) => {
    const data = await getAccount({ data: { id: params.id, ...deps } });
    if (!data) throw notFound();
    return data;
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.account.name ?? "Account"} — MetaConsole` },
      {
        name: "description",
        content: `Performance detail for ${loaderData?.account.name ?? "ad account"}.`,
      },
    ],
  }),
  component: AccountDetail,
  notFoundComponent: () => (
    <div className="p-8">
      <Link to="/accounts" className="text-sm text-primary hover:underline">
        ← Back to accounts
      </Link>
      <p className="mt-4 text-muted-foreground">Account not found.</p>
    </div>
  ),
});

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value ?? "—"}</dd>
    </div>
  );
}

function AccountDetail() {
  const { account, deltas, campaigns: accountCampaigns, trend, meta } = Route.useLoaderData();
  const { days, from, to } = Route.useLoaderDeps();
  const sparks = kpiSparks(trend);
  const { sorted, key, dir, toggle } = useSort(
    accountCampaigns,
    {
      name: (c) => c.name,
      spend: (c) => c.spend,
      ctr: (c) => c.ctr,
      cpc: (c) => c.cpc,
      results: (c) => c.results,
    },
    "spend",
  );

  return (
    <div className="p-6 md:p-8 space-y-8 max-w-[1600px]">
      <Link
        to="/accounts"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" /> All accounts
      </Link>
      <PageHeader
        title={account.name}
        description={`${account.id} · ${account.currency} · ${account.status.toLowerCase()}`}
      >
        <StatusPill status={account.status} />
      </PageHeader>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Spend"
          value={fmtCurrency(account.spend)}
          delta={deltas.spend}
          spark={sparks.spend}
        />
        <KpiCard label={account.resultLabel} value={fmtCompact(account.results)} />
        <KpiCard
          label="Conversions"
          value={fmtCompact(account.conversions)}
          delta={deltas.conversions}
          spark={sparks.conversions}
        />
        <KpiCard label="CTR" value={fmtPct(account.ctr)} delta={deltas.ctr} spark={sparks.ctr} />
        <KpiCard
          label="Impressions"
          value={fmtCompact(account.impressions)}
          delta={deltas.impressions}
          spark={sparks.impressions}
        />
        <KpiCard
          label="Reach"
          value={fmtCompact(account.reach)}
          delta={deltas.reach}
          spark={sparks.reach}
        />
        <KpiCard
          label="Avg. CPM"
          value={fmtCurrency(account.cpm)}
          delta={deltas.cpm}
          spark={sparks.cpm}
        />
      </section>

      {meta && (
        <section className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold mb-3">Account details</h3>
          {meta.disableReason && (
            <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
              Account disabled — {meta.disableReason}
            </div>
          )}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
            <Detail label="Business" value={meta.businessName} />
            <Detail label="Time zone" value={meta.timezoneName} />
            <Detail label="Created" value={meta.createdTime} />
            <Detail
              label="Lifetime spend"
              value={
                meta.amountSpent != null
                  ? fmtCurrency(meta.amountSpent / 100, account.currency)
                  : null
              }
            />
            <Detail
              label="Balance"
              value={
                meta.balance != null ? fmtCurrency(meta.balance / 100, account.currency) : null
              }
            />
            <Detail
              label="Spend cap"
              value={meta.spendCap ? fmtCurrency(meta.spendCap / 100, account.currency) : "None"}
            />
          </dl>
        </section>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold mb-1">Performance Trend</h3>
        <p className="text-xs text-muted-foreground mb-2">
          {rangeLabel({ range: days, from, to })} · spend &amp; conversions
        </p>
        <TrendChart data={trend} />
      </section>

      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">Campaigns ({accountCampaigns.length})</h3>
          <Link
            to="/campaigns"
            search={{ account: account.id }}
            className="text-xs text-primary hover:underline"
          >
            Open explorer
          </Link>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
              <SortHeader
                label="Campaign"
                sortKey="name"
                active={key}
                dir={dir}
                onSort={toggle}
                align="left"
              />
              <th className="text-left px-3 py-2.5">Objective</th>
              <th className="text-left px-3 py-2.5">Status</th>
              <SortHeader
                label="Spend"
                sortKey="spend"
                active={key}
                dir={dir}
                onSort={toggle}
                align="right"
              />
              <SortHeader
                label="CTR"
                sortKey="ctr"
                active={key}
                dir={dir}
                onSort={toggle}
                align="right"
              />
              <SortHeader
                label="CPC"
                sortKey="cpc"
                active={key}
                dir={dir}
                onSort={toggle}
                align="right"
              />
              <SortHeader
                label="Results"
                sortKey="results"
                active={key}
                dir={dir}
                onSort={toggle}
                align="right"
              />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((c) => (
              <tr key={c.id} className="hover:bg-accent/40">
                <td className="px-5 py-3 font-medium">{c.name}</td>
                <td className="px-3 py-3 text-xs font-mono text-muted-foreground">{c.objective}</td>
                <td className="px-3 py-3">
                  <StatusPill status={c.status} />
                </td>
                <td className="px-3 py-3 text-right font-mono">{fmtCurrency(c.spend)}</td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {fmtPct(c.ctr)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                  {fmtCurrency(c.cpc)}
                </td>
                <td className="px-5 py-3 text-right font-mono">
                  {fmtCompact(c.results)}{" "}
                  <span className="text-muted-foreground text-[10px]">
                    {c.resultLabel.toLowerCase()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
