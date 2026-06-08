import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { creatives, fmtCurrency, fmtPct, fmtCompact } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { Play } from "lucide-react";

export const Route = createFileRoute("/creatives")({
  head: () => ({
    meta: [
      { title: "Creatives — MetaConsole" },
      { name: "description", content: "Creative gallery with performance overlays across the BM." },
    ],
  }),
  component: Creatives,
});

function Creatives() {
  const [format, setFormat] = useState("ALL");
  const formats = ["ALL", "Image", "Video", "Carousel", "Collection"];
  const filtered = useMemo(
    () => creatives.filter((c) => format === "ALL" || c.format === format),
    [format]
  );

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader title="Creative Hub" description={`${creatives.length} top-performing ads across all accounts.`} />

      <div className="flex rounded-md border border-border bg-card overflow-hidden w-fit text-xs">
        {formats.map((f) => (
          <button
            key={f}
            onClick={() => setFormat(f)}
            className={cn(
              "px-3 h-9 font-medium transition-colors",
              format === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
            )}
          >{f}</button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
        {filtered.map((c) => (
          <div key={c.id} className="rounded-xl border border-border bg-card overflow-hidden group">
            <div
              className="aspect-square relative overflow-hidden"
              style={{
                background: `linear-gradient(135deg, hsl(${c.thumbHue} 70% 35%), hsl(${(c.thumbHue + 60) % 360} 55% 22%))`,
              }}
            >
              <div className="absolute top-2 left-2 flex items-center gap-1.5">
                <span className="rounded bg-background/70 backdrop-blur px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider">{c.format}</span>
                <StatusPill status={c.status} />
              </div>
              {c.format === "Video" && (
                <div className="absolute inset-0 grid place-items-center">
                  <div className="size-12 rounded-full bg-background/40 backdrop-blur grid place-items-center group-hover:scale-110 transition-transform">
                    <Play className="size-5 fill-foreground text-foreground" />
                  </div>
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/80 via-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
                  <div><div className="text-white/60">CTR</div><div className="text-white font-semibold">{fmtPct(c.ctr)}</div></div>
                  <div><div className="text-white/60">Spend</div><div className="text-white font-semibold">{fmtCurrency(c.spend)}</div></div>
                  <div><div className="text-white/60">ROAS</div><div className="text-white font-semibold">{c.roas.toFixed(2)}x</div></div>
                </div>
              </div>
            </div>
            <div className="p-3 space-y-1.5">
              <div className="text-xs font-medium truncate">{c.name}</div>
              <div className="text-[10px] text-muted-foreground truncate">{c.campaign}</div>
              <div className="flex items-center justify-between pt-1 text-[10px] font-mono text-muted-foreground">
                <span>{fmtCompact(c.impressions)} impr</span>
                <span className={c.roas >= 3 ? "text-success" : c.roas < 1.5 ? "text-destructive" : ""}>{c.roas.toFixed(2)}x ROAS</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
