import { cn } from "@/lib/utils";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

interface KpiCardProps {
  label: string;
  value: string;
  delta?: number; // percent
  spark?: number[];
  hint?: string;
}

export function KpiCard({ label, value, delta, spark, hint }: KpiCardProps) {
  const positive = (delta ?? 0) >= 0;
  const data = (spark ?? []).map((v, i) => ({ i, v }));
  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        {delta !== undefined && (
          <span className={cn(
            "inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded font-mono",
            positive ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
          )}>
            {positive ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
            {positive ? "+" : ""}{delta.toFixed(1)}%
          </span>
        )}
      </div>
      <div className="text-2xl font-bold tracking-tight font-mono">{value}</div>
      <div className="h-10 -mx-1">
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <defs>
                <linearGradient id={`g-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="v" stroke="var(--color-primary)" strokeWidth={1.5} fill={`url(#g-${label})`} />
            </AreaChart>
          </ResponsiveContainer>
        ) : hint ? (
          <div className="text-[10px] text-muted-foreground font-mono pt-2">{hint}</div>
        ) : null}
      </div>
    </div>
  );
}
