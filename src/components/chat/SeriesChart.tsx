import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SeriesPoint } from "@/server/agent/events";
import { fmtCompact, fmtCurrency, fmtPct } from "@/lib/format";

/**
 * The in-chat chart. Any tool that returns `{ title, unit, points }` gets drawn here instead of
 * being flattened into a markdown table the model has to describe in prose.
 *
 * Styled to match `src/components/dashboard/TrendChart.tsx` (same theme vars, same axis treatment)
 * so a chart in the Ask tab reads as the same object as a chart on a dashboard.
 */
export function SeriesChart({
  title,
  unit,
  points,
}: {
  title: string;
  unit: string;
  points: SeriesPoint[];
}) {
  if (points.length === 0) return null;

  const values = points.map((p) => p.value);
  // Decimals are chosen once for the whole series, not per value: mixing "$0.00" and "$2,500" down
  // one axis reads as two different units.
  const { format, rate } = unitStyle(unit, Math.max(...values.map(Math.abs)));
  const last = values[values.length - 1] ?? 0;
  const total = values.reduce((a, b) => a + b, 0);
  // A rate (CTR, ROAS, CPC) has no meaningful sum, so the header shows its average instead.
  const summaryLabel = rate ? "avg" : "total";
  const summary = rate ? total / values.length : total;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-baseline gap-3 px-4 pt-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            {title}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {points.length} day{points.length === 1 ? "" : "s"} · {summaryLabel} {format(summary)}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold font-mono">{format(last)}</div>
          <div className="text-[10px] text-muted-foreground">latest</div>
        </div>
      </div>
      <div className="h-56 w-full px-1 pb-2 pt-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={shortDate}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              minTickGap={16}
            />
            <YAxis
              tickFormatter={(v: number) => format(v)}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <Tooltip
              contentStyle={{
                background: "var(--color-popover)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: "var(--color-muted-foreground)", fontSize: 10 }}
              formatter={(v) => [format(Number(v ?? 0)), title]}
            />
            <Line
              name={title}
              type="monotone"
              dataKey="value"
              stroke="var(--color-primary)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** `2026-08-31` → `Aug 31`. Sliced, not parsed — the dates are already in the account's timezone. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/**
 * `unit` is whatever the tool called it — `USD`, `$`, `%`, `impressions`, `results`. Money and
 * percentages get real formatting; everything else is a compact count. `rate` marks the units where
 * summing the series would be nonsense. `scale` is the largest magnitude in the series and only
 * decides how many decimals a currency axis shows.
 */
function unitStyle(unit: string, scale: number): { format: (v: number) => string; rate: boolean } {
  const u = unit.trim().toLowerCase();
  if (u === "usd" || u === "$" || u === "spend" || u === "cost" || u === "revenue") {
    const digits = scale < 100 ? 2 : 0;
    return { format: (v) => fmtCurrency(v, "USD", digits), rate: false };
  }
  if (u.startsWith("cp")) {
    // cpc / cpm / cpa — money, but an average across days rather than a sum.
    return { format: (v) => fmtCurrency(v, "USD", 2), rate: true };
  }
  if (u === "%" || u === "pct" || u === "percent" || u === "ctr" || u === "cvr") {
    return { format: (v) => fmtPct(v), rate: true };
  }
  if (u === "roas" || u === "x" || u === "ratio") {
    return { format: (v) => `${v.toFixed(2)}x`, rate: true };
  }
  return { format: (v) => fmtCompact(v), rate: false };
}
