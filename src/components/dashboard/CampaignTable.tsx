import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { useSort, SortHeader } from "@/components/dashboard/SortableTable";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { fmtCurrency, fmtPct, fmtCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Ad, Campaign } from "@/lib/types";

type Selected = { ad: Ad; campaign: string } | null;

/**
 * Hierarchical campaign → ad set → ad table with sortable top-level columns,
 * full-row click to drill down, and a click-to-zoom creative preview at ad level.
 * Filtering is the caller's job (pass an already-filtered list).
 */
export function CampaignTable({ campaigns }: { campaigns: Campaign[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Selected>(null);
  const {
    sorted,
    key,
    dir,
    toggle: toggleSort,
  } = useSort(
    campaigns,
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
  const toggle = (id: string) => setOpen((p) => ({ ...p, [id]: !p[id] }));

  return (
    <>
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
                  className="w-[38%]"
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
                        <div className="flex items-center gap-2 group">
                          {isOpen ? (
                            <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                          )}
                          <div className="min-w-0">
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
                      <td className="px-3 py-3 text-right font-mono text-muted-foreground">
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
                                <div className="flex items-center gap-2 pl-6">
                                  {isSetOpen ? (
                                    <ChevronDown className="size-3 text-muted-foreground shrink-0" />
                                  ) : (
                                    <ChevronRight className="size-3 text-muted-foreground shrink-0" />
                                  )}
                                  <div className="text-xs font-medium truncate max-w-[400px]">
                                    {s.name}
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
                                <tr
                                  key={ad.id}
                                  onClick={() => setSelected({ ad, campaign: c.name })}
                                  className="bg-muted/30 hover:bg-accent/50 cursor-pointer"
                                  title="View creative"
                                >
                                  <td className="px-5 py-2">
                                    <div className="flex items-center gap-2 pl-12">
                                      {ad.thumbnailUrl ? (
                                        <img
                                          src={ad.thumbnailUrl}
                                          alt=""
                                          loading="lazy"
                                          className="size-7 rounded object-cover shrink-0"
                                        />
                                      ) : (
                                        <div
                                          className="size-7 rounded shrink-0"
                                          style={{ background: `hsl(${ad.thumbHue} 60% 45%)` }}
                                        />
                                      )}
                                      <div className="min-w-0">
                                        <div className="text-xs truncate max-w-[340px]">
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
                                  <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
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
              {campaigns.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-muted-foreground text-xs">
                    No campaigns match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-border text-[11px] text-muted-foreground font-mono">
          {campaigns.length} campaigns
        </div>
      </div>

      <AdCreativeDialog selected={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function AdCreativeDialog({ selected, onClose }: { selected: Selected; onClose: () => void }) {
  return (
    <Dialog open={!!selected} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">{selected?.ad.name ?? "Creative"}</DialogTitle>
        {selected && (
          <>
            <div className="bg-muted grid place-items-center max-h-[60vh] overflow-hidden">
              {selected.ad.thumbnailUrl ? (
                <img
                  src={selected.ad.thumbnailUrl}
                  alt={selected.ad.name}
                  className="w-full h-auto max-h-[60vh] object-contain"
                />
              ) : (
                <div
                  className="w-full aspect-square"
                  style={{ background: `hsl(${selected.ad.thumbHue} 60% 55%)` }}
                />
              )}
            </div>
            <div className="p-4 space-y-3">
              <div>
                <div className="text-sm font-semibold leading-snug">{selected.ad.name}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {selected.campaign} · {selected.ad.format}
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                {(
                  [
                    ["Spend", fmtCurrency(selected.ad.spend)],
                    [selected.ad.resultLabel, fmtCompact(selected.ad.results)],
                    ["CTR", fmtPct(selected.ad.ctr)],
                    ["CPC", fmtCurrency(selected.ad.cpc)],
                  ] as [string, string][]
                ).map(([label, value]) => (
                  <div key={label} className="rounded-md border border-border bg-card py-2">
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground truncate px-1">
                      {label}
                    </div>
                    <div className="text-xs font-semibold font-mono mt-0.5">{value}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
