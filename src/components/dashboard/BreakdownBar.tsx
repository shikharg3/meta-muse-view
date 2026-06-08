import { cn } from "@/lib/utils";

export function BreakdownBar({
  rows, valueKey = "spend", format,
}: {
  rows: { label: string; spend: number; conversions: number; roas: number }[];
  valueKey?: "spend" | "conversions" | "roas";
  format: (n: number) => string;
}) {
  const max = Math.max(...rows.map((r) => r[valueKey]));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const pct = (r[valueKey] / max) * 100;
        return (
          <div key={r.label} className="grid grid-cols-[140px_1fr_80px] items-center gap-3 text-xs">
            <span className="truncate text-foreground">{r.label}</span>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div className={cn("h-full bg-primary rounded-full transition-all")} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-right font-mono text-muted-foreground">{format(r[valueKey])}</span>
          </div>
        );
      })}
    </div>
  );
}
