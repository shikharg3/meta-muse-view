import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useId, type ReactNode } from "react";

import { STATUS_LABEL, type CampaignStatus } from "../mock";
import { pct, type Change } from "../format";

// ------------------------------------------------------------------ surfaces

export function Panel({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <section
      className={`pf-panel pf-rise ${className}`}
      style={{ "--d": `${delay}ms` } as React.CSSProperties}
    >
      {children}
    </section>
  );
}

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`pf-eyebrow ${className}`}>{children}</p>;
}

/** Section heading: serif title with an optional aside on the right. */
export function SectionHead({
  eyebrow,
  title,
  aside,
}: {
  eyebrow: string;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 px-5 pt-4 pb-3 md:px-6">
      <div className="min-w-0">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="pf-display mt-1.5 text-[22px] md:text-[25px]">{title}</h2>
      </div>
      {aside ? <div className="min-w-0 pb-1">{aside}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ signals

export function Delta({ change: c, className = "" }: { change: Change; className?: string }) {
  const Icon = c.dir === "up" ? ArrowUpRight : c.dir === "down" ? ArrowDownRight : Minus;
  const color = c.dir === "flat" ? "var(--pf-faint)" : c.good ? "var(--pf-mint)" : "var(--pf-rose)";
  return (
    <span
      className={`inline-flex items-center gap-1 text-[12px] font-semibold ${className}`}
      style={{ color }}
    >
      <Icon className="size-3.5" strokeWidth={2.4} />
      <span className="pf-num">{c.dir === "flat" ? "—" : pct(Math.abs(c.pct), 1)}</span>
    </span>
  );
}

const STATUS_TONE: Record<CampaignStatus, string> = {
  running: "var(--pf-mint)",
  paused: "var(--pf-gold)",
  finished: "var(--pf-faint)",
  scheduled: "var(--pf-violet)",
};

export function StatusPill({ status }: { status: CampaignStatus }) {
  const tone = STATUS_TONE[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold"
      style={{ color: tone, borderColor: "color-mix(in oklab, currentColor 34%, transparent)" }}
    >
      <span
        className="size-1.5 rounded-full"
        style={{
          background: tone,
          boxShadow:
            status === "running"
              ? `0 0 0 3px color-mix(in oklab, ${tone} 22%, transparent)`
              : undefined,
        }}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}

// ------------------------------------------------------------------ figures

/** Headline metric. The number carries the weight; the label stays quiet above it. */
export function MetricTile({
  label,
  value,
  sub,
  change: c,
  accent = false,
  delay = 0,
}: {
  label: string;
  value: string;
  sub?: string;
  change?: Change;
  accent?: boolean;
  delay?: number;
}) {
  return (
    <div
      className="pf-rise relative px-5 py-4 md:px-6 md:py-5"
      style={{ "--d": `${delay}ms` } as React.CSSProperties}
    >
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-2 flex items-baseline gap-2">
        <span
          className="pf-num text-[26px] leading-none md:text-[31px]"
          style={{ color: accent ? "var(--pf-gold)" : "var(--pf-text)" }}
        >
          {value}
        </span>
        {c ? <Delta change={c} /> : null}
      </div>
      {sub ? <p className="mt-2 text-[11.5px] text-[color:var(--pf-faint)]">{sub}</p> : null}
    </div>
  );
}

/** Inline trend for table rows — no axes, no tooltip, just the shape of the last N days. */
export function Sparkline({
  values,
  width = 96,
  height = 26,
  tone = "var(--pf-gold)",
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  if (values.length < 2) {
    return (
      <span className="text-[11px] text-[color:var(--pf-faint)]" style={{ width }}>
        —
      </span>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const line = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity={0.34} />
          <stop offset="100%" stopColor={tone} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#sp${id})`} />
      <path d={line} fill="none" stroke={tone} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

/** Proportion bar for breakdown rows. */
export function ShareBar({ share, tone = "var(--pf-gold)" }: { share: number; tone?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--pf-line)]">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.max(2, share * 100).toFixed(1)}%`,
          background: `linear-gradient(90deg, ${tone}, color-mix(in oklab, ${tone} 55%, transparent))`,
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ controls

export function Segmented<T extends string | null>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className="pf-chip"
          data-on={o.value === value}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
