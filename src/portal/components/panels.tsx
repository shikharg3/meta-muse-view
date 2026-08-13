import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CalendarClock, TrendingUp } from "lucide-react";
import { useState } from "react";

import { fmtCompact, fmtCurrency, fmtNumber } from "@/lib/format";
import {
  breakdownFor,
  derive,
  DIMENSIONS,
  EVENT,
  FRESHNESS,
  longDay,
  priorTotalsFor,
  rangeDays,
  seriesFor,
  shortDay,
  totalsFor,
  type BrandFilter,
  type Dimension,
  type Pacing,
  type RangeKey,
} from "../mock";
import { change, pct, usd2, usdCompact } from "../format";
import { Eyebrow, MetricTile, Panel, SectionHead, Segmented, ShareBar } from "./bits";

// ------------------------------------------------------------------ trend

interface TrendPoint {
  label: string;
  spend: number;
  regs: number;
}

export function TrendPanel({
  range,
  brand,
  delay = 0,
}: {
  range: RangeKey;
  brand: BrandFilter;
  delay?: number;
}) {
  const rows = seriesFor(range, brand);
  const data: TrendPoint[] = rows.map((r) => ({
    label: shortDay(r.date),
    spend: Math.round(r.spend),
    regs: r.regs,
  }));
  const t = derive(totalsFor(range, brand));

  return (
    <Panel delay={delay}>
      <SectionHead
        eyebrow={`Last ${rangeDays(range)} days`}
        title="Spend and registrations, day by day"
        aside={
          <div className="flex items-center gap-4 text-[11.5px]">
            <span className="inline-flex items-center gap-1.5 text-[color:var(--pf-dim)]">
              <span className="h-0.5 w-4 rounded-full bg-[color:var(--pf-gold)]" /> Spend
            </span>
            <span className="inline-flex items-center gap-1.5 text-[color:var(--pf-dim)]">
              <span className="h-0.5 w-4 rounded-full bg-[color:var(--pf-mint)]" /> {EVENT.reg}
            </span>
          </div>
        }
      />
      <div className="h-[268px] w-full pr-3 pb-2 md:h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id="pfSpend" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--pf-gold)" stopOpacity={0.34} />
                <stop offset="100%" stopColor="var(--pf-gold)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="pfRegs" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--pf-mint)" stopOpacity={0.2} />
                <stop offset="100%" stopColor="var(--pf-mint)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--pf-line)" vertical={false} />
            <XAxis
              dataKey="label"
              interval={Math.max(0, Math.ceil(data.length / 9) - 1)}
              tick={{ fill: "var(--pf-faint)", fontSize: 10.5, fontFamily: "var(--pf-mono)" }}
              tickLine={false}
              axisLine={false}
              dy={6}
            />
            <YAxis
              yAxisId="l"
              tickFormatter={(v: number) => `$${fmtCompact(v)}`}
              tick={{ fill: "var(--pf-faint)", fontSize: 10.5, fontFamily: "var(--pf-mono)" }}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <YAxis
              yAxisId="r"
              orientation="right"
              tick={{ fill: "var(--pf-faint)", fontSize: 10.5, fontFamily: "var(--pf-mono)" }}
              tickLine={false}
              axisLine={false}
              width={38}
            />
            <Tooltip
              cursor={{ stroke: "var(--pf-line-strong)", strokeWidth: 1 }}
              contentStyle={{
                background: "oklch(0.19 0.012 264)",
                border: "1px solid var(--pf-line-strong)",
                borderRadius: 10,
                fontSize: 12,
                fontFamily: "var(--pf-sans)",
                boxShadow: "0 18px 40px -20px rgb(0 0 0 / 0.8)",
              }}
              labelStyle={{
                color: "var(--pf-faint)",
                fontSize: 10.5,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                marginBottom: 4,
              }}
              itemStyle={{ fontFamily: "var(--pf-mono)", fontSize: 12 }}
              formatter={(value, name) => [
                name === "spend" ? fmtCurrency(Number(value)) : fmtNumber(Number(value)),
                name === "spend" ? "Spend" : EVENT.reg,
              ]}
            />
            <Area
              yAxisId="l"
              type="monotone"
              dataKey="spend"
              stroke="var(--pf-gold)"
              strokeWidth={1.9}
              fill="url(#pfSpend)"
              activeDot={{ r: 3.5, strokeWidth: 0, fill: "var(--pf-gold)" }}
            />
            <Area
              yAxisId="r"
              type="monotone"
              dataKey="regs"
              stroke="var(--pf-mint)"
              strokeWidth={1.6}
              strokeDasharray="4 3"
              fill="url(#pfRegs)"
              activeDot={{ r: 3.5, strokeWidth: 0, fill: "var(--pf-mint)" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-t px-5 py-3 md:px-6">
        {[
          // Averaged over days that actually delivered, not the window length — a brand that
          // launched mid-window would otherwise look half as active as it is.
          { k: "Average per delivering day", v: fmtCurrency(t.spend / Math.max(1, rows.length)) },
          { k: "Click-through rate", v: pct(t.ctr, 2) },
          { k: "Cost per 1,000 views", v: usd2(t.cpm) },
          { k: `${EVENT.reg} per 100 clicks`, v: t.regRate.toFixed(1) },
        ].map((x) => (
          <div key={x.k} className="flex items-baseline gap-2">
            <span className="text-[11.5px] text-[color:var(--pf-faint)]">{x.k}</span>
            <span className="pf-num text-[13px]">{x.v}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ funnel

export function FunnelPanel({
  range,
  brand,
  delay = 0,
}: {
  range: RangeKey;
  brand: BrandFilter;
  delay?: number;
}) {
  const t = totalsFor(range, brand);
  const stages = [
    { label: "Views", value: t.impressions, note: "Times your ads were shown" },
    { label: "Clicks", value: t.clicks, note: "Visits to your site" },
    { label: EVENT.reg, value: t.regs, note: "Accounts created" },
    { label: EVENT.dep, value: t.deposits, note: "Players who funded an account" },
  ];
  const top = stages[0].value || 1;

  return (
    <Panel delay={delay}>
      <SectionHead eyebrow="Player journey" title="From view to first deposit" />
      <div className="space-y-3 px-5 pb-5 md:px-6">
        {stages.map((s, i) => {
          const prev = i === 0 ? null : stages[i - 1].value;
          // Real counts span six orders of magnitude; taper the bar so every stage stays visible.
          const width = Math.max(7, Math.pow(s.value / top, 0.32) * 100);
          return (
            <div key={s.label}>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-[13px] font-semibold">{s.label}</p>
                  <p className="text-[11px] text-[color:var(--pf-faint)]">{s.note}</p>
                </div>
                <div className="text-right">
                  <span className="pf-num text-[17px]">{fmtNumber(s.value)}</span>
                  {prev ? (
                    <p className="pf-num text-[11px] text-[color:var(--pf-dim)]">
                      {pct((s.value / (prev || 1)) * 100, 1)} of {stages[i - 1].label.toLowerCase()}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-[color:var(--pf-line)]">
                <div
                  className="h-full rounded-full transition-[width] duration-700"
                  style={{
                    width: `${width.toFixed(1)}%`,
                    background: `linear-gradient(90deg, var(--pf-gold), color-mix(in oklab, var(--pf-gold) ${72 - i * 14}%, var(--pf-violet)))`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t px-5 py-3 text-[11.5px] text-[color:var(--pf-faint)] md:px-6">
        Cost per {EVENT.dep.toLowerCase().replace(/s$/, "")}{" "}
        <span className="pf-num text-[color:var(--pf-text)]">
          {usd2(t.deposits > 0 ? t.spend / t.deposits : 0)}
        </span>{" "}
        · attribution {FRESHNESS.attribution}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ pacing

export function PacingPanel({ pacing, delay = 0 }: { pacing: Pacing; delay?: number }) {
  const tone =
    pacing.verdict === "on track"
      ? "var(--pf-mint)"
      : pacing.verdict === "ahead of plan"
        ? "var(--pf-gold)"
        : "var(--pf-violet)";

  return (
    <Panel delay={delay}>
      <SectionHead
        eyebrow="Budget pacing"
        title={`${pacing.brandName} — ${pacing.verdict}`}
        aside={
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold"
            style={{
              color: tone,
              borderColor: "color-mix(in oklab, currentColor 34%, transparent)",
            }}
          >
            <CalendarClock className="size-3.5" /> {pacing.daysLeft} days left
          </span>
        }
      />
      <div className="px-5 pb-5 md:px-6">
        <div className="flex items-baseline justify-between">
          <span className="pf-num text-[26px] md:text-[30px]">{fmtCurrency(pacing.spent)}</span>
          <span className="text-[12px] text-[color:var(--pf-dim)]">
            of{" "}
            <span className="pf-num text-[color:var(--pf-text)]">{fmtCurrency(pacing.budget)}</span>{" "}
            contracted
          </span>
        </div>

        <div className="relative mt-3 h-3 w-full overflow-hidden rounded-full bg-[color:var(--pf-line)]">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(100, pacing.pctSpent).toFixed(1)}%`,
              background: "linear-gradient(90deg, var(--pf-gold-deep), var(--pf-gold))",
            }}
          />
          {/* Where the burn should sit today if it were perfectly even. */}
          <div
            className="absolute top-0 bottom-0 w-[2px] bg-[color:var(--pf-text)] opacity-70"
            style={{ left: `${Math.min(100, pacing.elapsedPct).toFixed(1)}%` }}
            title="Even pace to date"
          />
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-[color:var(--pf-faint)]">
          <span className="pf-num">{pct(pacing.pctSpent, 1)} spent</span>
          <span className="pf-num">{pct(pacing.elapsedPct, 1)} of the flight elapsed</span>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
          {[
            { k: "Average per day", v: fmtCurrency(pacing.avgPerDay) },
            { k: "Remaining", v: fmtCurrency(pacing.remaining) },
            { k: "Projected total", v: fmtCurrency(pacing.projected) },
            { k: "Flight ends", v: longDay(pacing.endsOn) },
          ].map((x) => (
            <div key={x.k}>
              <Eyebrow>{x.k}</Eyebrow>
              <p className="pf-num mt-1 text-[15px]">{x.v}</p>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ breakdowns

export function BreakdownPanel({
  range,
  brand,
  delay = 0,
}: {
  range: RangeKey;
  brand: BrandFilter;
  delay?: number;
}) {
  const [dim, setDim] = useState<Dimension>("platform");
  const rows = breakdownFor(range, brand, dim);
  const best = rows.reduce((a, b) => (b.regs > 0 && b.costPerReg < a.costPerReg ? b : a), rows[0]);

  return (
    <Panel delay={delay}>
      <SectionHead
        eyebrow="Where the money went"
        title="Delivery breakdown"
        aside={
          <Segmented
            label="Breakdown dimension"
            value={dim}
            onChange={setDim}
            options={DIMENSIONS.map((d) => ({ value: d.key, label: d.label }))}
          />
        }
      />
      <div className="overflow-x-auto">
        <div className="min-w-[560px] px-5 pb-2 md:px-6">
          <div className="grid grid-cols-[1fr_7rem_7rem_7rem] items-center gap-x-4 pb-2 text-[10px] font-semibold tracking-[0.14em] text-[color:var(--pf-faint)] uppercase">
            <span className="pl-2">{DIMENSIONS.find((d) => d.key === dim)!.label}</span>
            <span className="text-right">Spend</span>
            <span className="text-right">{EVENT.reg}</span>
            <span className="text-right">Cost each</span>
          </div>
          {rows.map((r) => (
            <div
              key={r.label}
              className="pf-row grid grid-cols-[1fr_7rem_7rem_7rem] items-center gap-x-4 border-t py-2.5"
            >
              <div className="min-w-0 pl-2">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{r.label}</span>
                  {r.label === best.label ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[color:var(--pf-mint)]">
                      <TrendingUp className="size-3" /> best value
                    </span>
                  ) : null}
                </div>
                <div className="mt-1.5 max-w-[280px]">
                  <ShareBar share={r.share} />
                </div>
              </div>
              <span className="pf-num text-right text-[13px]">{usdCompact(r.spend)}</span>
              <span className="pf-num text-right text-[13px]">{fmtNumber(r.regs)}</span>
              <span className="pf-num text-right text-[13px] text-[color:var(--pf-dim)]">
                {usd2(r.costPerReg)}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="border-t px-5 py-3 text-[11.5px] text-[color:var(--pf-faint)] md:px-6">
        Percentages are share of spend in the selected period.
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ headline metrics

/** The five figures a client checks first, each against the previous equal-length period. */
export function HeadlineMetrics({ range, brand }: { range: RangeKey; brand: BrandFilter }) {
  const now = derive(totalsFor(range, brand));
  const prev = derive(priorTotalsFor(range, brand));
  const tiles = [
    {
      label: "Amount spent",
      value: fmtCurrency(now.spend),
      c: change(now.spend, prev.spend),
      accent: false,
    },
    { label: EVENT.reg, value: fmtNumber(now.regs), c: change(now.regs, prev.regs), accent: true },
    {
      label: `Cost per ${EVENT.reg.toLowerCase().replace(/s$/, "")}`,
      value: usd2(now.costPerReg),
      c: change(now.costPerReg, prev.costPerReg, true),
      accent: false,
    },
    {
      label: EVENT.dep,
      value: fmtNumber(now.deposits),
      c: change(now.deposits, prev.deposits),
      accent: false,
    },
    {
      label: "Click-through rate",
      value: pct(now.ctr, 2),
      c: change(now.ctr, prev.ctr),
      accent: false,
    },
  ];

  return (
    <div className="pf-panel grid grid-cols-2 divide-x divide-y md:grid-cols-3 xl:grid-cols-5 xl:divide-y-0">
      {tiles.map((t, i) => (
        <MetricTile
          key={t.label}
          label={t.label}
          value={t.value}
          change={t.c}
          accent={t.accent}
          delay={80 + i * 55}
          sub={`vs previous ${rangeDays(range)} days`}
        />
      ))}
    </div>
  );
}
