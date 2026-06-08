import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { campaigns, fmtCurrency, fmtPct, fmtCompact } from "@/lib/mock-data";
import { ChevronDown, ChevronRight, Search, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/campaigns")({
  head: () => ({
    meta: [
      { title: "Campaigns — MetaConsole" },
      { name: "description", content: "Explore campaigns, ad sets, and ads across all accounts." },
    ],
  }),
  component: CampaignsExplorer,
});

function CampaignsExplorer() {
  const [q, setQ] = useState("");
  const [objective, setObjective] = useState("ALL");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const objectives = useMemo(
    () => ["ALL", ...Array.from(new Set(campaigns.map((c) => c.objective)))],
    []
  );
  const filtered = useMemo(
    () => campaigns.filter((c) =>
      (objective === "ALL" || c.objective === objective) &&
      (q.trim() === "" || c.name.toLowerCase().includes(q.toLowerCase()) || c.accountName.toLowerCase().includes(q.toLowerCase()))
    ),
    [q, objective]
  );

  const toggle = (id: string, fullOpen?: boolean) =>
    setOpen((p) => ({ ...p, [id]: fullOpen ?? !p[id] }));

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Campaign Explorer"
        description="Hierarchical view of campaigns, ad sets, and ads across the BM."
      >
        <button className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-card hover:bg-accent text-xs">
          <SlidersHorizontal className="size-3.5" /> Columns
        </button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
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
                objective === o ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
              )}
            >{o}</button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <th className="text-left px-5 py-2.5 w-[40%]">Entity</th>
                <th className="text-left px-3 py-2.5">Status</th>
                <th className="text-right px-3 py-2.5">Spend</th>
                <th className="text-right px-3 py-2.5">CTR</th>
                <th className="text-right px-3 py-2.5">CPC</th>
                <th className="text-right px-3 py-2.5">Conv.</th>
                <th className="text-right px-5 py-2.5">ROAS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((c) => {
                const isOpen = open[c.id];
                return (
                  <Fragment key={c.id}>
                    <tr className="hover:bg-accent/40 transition-colors">
                      <td className="px-5 py-3">
                        <button onClick={() => toggle(c.id)} className="flex items-center gap-2 text-left group">
                          {isOpen ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
                          <div>
                            <div className="font-medium group-hover:text-primary truncate max-w-[420px]">{c.name}</div>
                            <div className="text-[10px] text-muted-foreground truncate max-w-[420px]">{c.accountName} · <span className="font-mono">{c.objective}</span></div>
                          </div>
                        </button>
                      </td>
                      <td className="px-3 py-3"><StatusPill status={c.status} /></td>
                      <td className="px-3 py-3 text-right font-mono">{fmtCurrency(c.spend)}</td>
                      <td className="px-3 py-3 text-right font-mono text-muted-foreground">{fmtPct(c.ctr)}</td>
                      <td className="px-3 py-3 text-right font-mono text-muted-foreground">{fmtCurrency(c.cpc)}</td>
                      <td className="px-3 py-3 text-right font-mono">{fmtCompact(c.conversions)}</td>
                      <td className={cn("px-5 py-3 text-right font-mono", c.roas >= 3 ? "text-success" : c.roas < 1.5 && "text-destructive")}>{c.roas.toFixed(2)}x</td>
                    </tr>
                    {isOpen && c.adSets.map((s) => {
                      const isSetOpen = open[s.id];
                      return (
                        <Fragment key={s.id}>
                          <tr className="bg-muted/20 hover:bg-accent/40">
                            <td className="px-5 py-2.5">
                              <button onClick={() => toggle(s.id)} className="flex items-center gap-2 text-left pl-6">
                                {isSetOpen ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
                                <div>
                                  <div className="text-xs font-medium truncate max-w-[400px]">{s.name}</div>
                                  <div className="text-[10px] text-muted-foreground">{s.audience}</div>
                                </div>
                              </button>
                            </td>
                            <td className="px-3 py-2.5"><StatusPill status={s.status} /></td>
                            <td className="px-3 py-2.5 text-right font-mono text-xs">{fmtCurrency(s.spend)}</td>
                            <td className="px-3 py-2.5 text-right font-mono text-xs text-muted-foreground">{fmtPct(s.ctr)}</td>
                            <td />
                            <td />
                            <td className="px-5 py-2.5 text-right font-mono text-xs">{s.roas.toFixed(2)}x</td>
                          </tr>
                          {isSetOpen && s.ads.map((ad) => (
                            <tr key={ad.id} className="bg-muted/30 hover:bg-accent/40">
                              <td className="px-5 py-2">
                                <div className="flex items-center gap-2 pl-12">
                                  <div className="size-6 rounded shrink-0" style={{ background: `hsl(${ad.thumbHue} 60% 45%)` }} />
                                  <div>
                                    <div className="text-xs truncate max-w-[360px]">{ad.name}</div>
                                    <div className="text-[10px] text-muted-foreground font-mono">{ad.format}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-2"><StatusPill status={ad.status} /></td>
                              <td className="px-3 py-2 text-right font-mono text-xs">{fmtCurrency(ad.spend)}</td>
                              <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">{fmtPct(ad.ctr)}</td>
                              <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">{fmtCurrency(ad.cpc)}</td>
                              <td className="px-3 py-2 text-right font-mono text-xs">{fmtCompact(ad.conversions)}</td>
                              <td className="px-5 py-2 text-right font-mono text-xs">{ad.roas.toFixed(2)}x</td>
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
