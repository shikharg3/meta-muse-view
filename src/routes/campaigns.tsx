import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { listCampaigns } from "@/lib/api/dashboard";
import { fmtCurrency, fmtPct, fmtCompact } from "@/lib/format";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSort, SortHeader } from "@/components/dashboard/SortableTable";
import { rangeSearch, toRange } from "@/lib/range";

export const Route = createFileRoute("/campaigns")({
  head: () => ({
    meta: [
      { title: "Campaigns — MetaConsole" },
      { name: "description", content: "Explore campaigns, ad sets, and ads across all accounts." },
    ],
  }),
  validateSearch: rangeSearch,
  loaderDeps: ({ search }) => ({ range: toRange(search.range) }),
  loader: async ({ deps: { range } }) => ({ campaigns: await listCampaigns({ data: range }) }),
  component: CampaignsExplorer,
});

function CampaignsExplorer() {
  const { campaigns } = Route.useLoaderData();
  const [q, setQ] = useState("");
  const [objective, setObjective] = useState("ALL");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const objectives = useMemo(
    () => ["ALL", ...Array.from(new Set(campaigns.map((c) => c.objective)))],
    [campaigns],
  );
  const filtered = useMemo(
    () =>
      campaigns.filter(
        (c) =>
          (objective === "ALL" || c.objective === objective) &&
          (q.trim() === "" ||
            c.name.toLowerCase().includes(q.toLowerCase()) ||
            c.accountName.toLowerCase().includes(q.toLowerCase())),
      ),
    [campaigns, q, objective],
  );

  const {
    sorted,
    key,
    dir,
    toggle: toggleSort,
  } = useSort(
    filtered,
    {
      name: (c) => c.name,
      spend: (c) => c.spend,
      ctr: (c) => c.ctr,
      cpc: (c) => c.cpc,
      conversions: (c) => c.conversions,
      results: (c) => c.results,
    },
    "spend",
  );

  const toggle = (id: string, fullOpen?: boolean) =>
    setOpen((p) => ({ ...p, [id]: fullOpen ?? !p[id] }));

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Campaign Explorer"
        description="Hierarchical view of campaigns, ad sets, and ads across the BM."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search campaigns or accounts…"
            className="w-full h-9 rounded-md border border-border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex rounded-md border border-border bg-card overflow-hidden text-xs">
          {objectives.map((o) => (
            <button
              key={o}
              onClick={() => setObjective(o)}
              className={cn(
                "px-2.5 h-9 font-medium font-mono uppercase text-[10px] transition-colors",
                objective === o
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {o}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <SortHeader
                  label="Entity"
                  sortKey="name"
                  active={key}
                  dir={dir}
                  onSort={toggleSort}
                  align="left"
                  className="w-[40%]"
                />
                <th className="text-left px-3 py-2.5">Status</th>
                <SortHeader
                  label="Spend"
                  sortKey="spend"
                  active={key}
                  dir={dir}
                  onSort={toggleSort}
                  align="right"
                />
                <SortHeader
                  label="CTR"
                  sortKey="ctr"
                  active={key}
                  dir={dir}
                  onSort={toggleSort}
                  align="right"
                />
                <SortHeader
                  label="CPC"
                  sortKey="cpc"
                  active={key}
                  dir={dir}
                  onSort={toggleSort}
                  align="right"
                />
                <SortHeader
                  label="Conv."
                  sortKey="conversions"
                  active={key}
                  dir={dir}
                  onSort={toggleSort}
                  align="right"
                />
                <SortHeader
                  label="Results"
                  sortKey="results"
                  active={key}
                  dir={dir}
                  onSort={toggleSort}
                  align="right"
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((c) => {
                const isOpen = open[c.id];
                return (
                  <Fragment key={c.id}>
                    <tr
                      onClick={() => toggle(c.id)}
                      className="hover:bg-accent/40 transition-colors cursor-pointer"
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2 text-left group">
                          {isOpen ? (
                            <ChevronDown className="size-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-3.5 text-muted-foreground" />
                          )}
                          <div>
                            <div className="font-medium group-hover:text-primary truncate max-w-[420px]">
                              {c.name}
                            </div>
                            <div className="text-[10px] text-muted-foreground truncate max-w-[420px]">
                              {c.accountName} · <span className="font-mono">{c.objective}</span>
                            </div>
                          </div>
                        </div>
                      </td>
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
                      <td className="px-3 py-3 text-right font-mono">
                        {fmtCompact(c.conversions)}
                      </td>
                      <td className="px-5 py-3 text-right font-mono">
                        {fmtCompact(c.results)}{" "}
                        <span className="text-muted-foreground">{c.resultLabel.toLowerCase()}</span>
                      </td>
                    </tr>
                    {isOpen &&
                      c.adSets.map((s) => {
                        const isSetOpen = open[s.id];
                        return (
                          <Fragment key={s.id}>
                            <tr
                              onClick={() => toggle(s.id)}
                              className="bg-muted/20 hover:bg-accent/40 cursor-pointer"
                            >
                              <td className="px-5 py-2.5">
                                <div className="flex items-center gap-2 text-left pl-6">
                                  {isSetOpen ? (
                                    <ChevronDown className="size-3 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="size-3 text-muted-foreground" />
                                  )}
                                  <div>
                                    <div className="text-xs font-medium truncate max-w-[400px]">
                                      {s.name}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground">
                                      {s.audience}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <StatusPill status={s.status} />
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono text-xs">
                                {fmtCurrency(s.spend)}
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono text-xs text-muted-foreground">
                                {fmtPct(s.ctr)}
                              </td>
                              <td />
                              <td />
                              <td className="px-5 py-2.5 text-right font-mono text-xs">
                                {fmtCompact(s.results)}
                              </td>
                            </tr>
                            {isSetOpen &&
                              s.ads.map((ad) => (
                                <tr key={ad.id} className="bg-muted/30 hover:bg-accent/40">
                                  <td className="px-5 py-2">
                                    <div className="flex items-center gap-2 pl-12">
                                      <div
                                        className="size-6 rounded shrink-0"
                                        style={{ background: `hsl(${ad.thumbHue} 60% 45%)` }}
                                      />
                                      <div>
                                        <div className="text-xs truncate max-w-[360px]">
                                          {ad.name}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground font-mono">
                                          {ad.format}
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2">
                                    <StatusPill status={ad.status} />
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono text-xs">
                                    {fmtCurrency(ad.spend)}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                                    {fmtPct(ad.ctr)}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                                    {fmtCurrency(ad.cpc)}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono text-xs">
                                    {fmtCompact(ad.conversions)}
                                  </td>
                                  <td className="px-5 py-2 text-right font-mono text-xs">
                                    {fmtCompact(ad.results)}
                                  </td>
                                </tr>
                              ))}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-border text-[11px] text-muted-foreground font-mono">
          {filtered.length} campaigns
        </div>
      </div>
    </div>
  );
}
