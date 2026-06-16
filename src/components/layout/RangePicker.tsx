import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Calendar, Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RANGE_DAYS, RANGE_LABELS, rangeLabel, isYmd, toRange, type RangeDays } from "@/lib/range";
import { cn } from "@/lib/utils";

/** Two date inputs + apply, for an explicit custom range. */
function CustomRange({
  from,
  to,
  onApply,
}: {
  from?: string;
  to?: string;
  onApply: (from: string, to: string) => void;
}) {
  const [f, setF] = useState(from ?? "");
  const [t, setT] = useState(to ?? "");
  return (
    <div className="flex flex-col gap-1.5 px-1">
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={f}
          max={t || undefined}
          onChange={(e) => setF(e.target.value)}
          className="h-8 flex-1 rounded-sm border border-border bg-card px-2 text-xs"
        />
        <span className="text-muted-foreground">→</span>
        <input
          type="date"
          value={t}
          min={f || undefined}
          onChange={(e) => setT(e.target.value)}
          className="h-8 flex-1 rounded-sm border border-border bg-card px-2 text-xs"
        />
      </div>
      <button
        onClick={() => f && t && onApply(f, t)}
        disabled={!f || !t}
        className="h-8 rounded-sm bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        Apply custom range
      </button>
    </div>
  );
}

/** Global date-range selector; writes `?range=` (preset) or `?from=&to=` (custom) so loaders refetch. */
export function RangePicker() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { range?: number; from?: string; to?: string };
  const isCustom = Boolean(search.from && search.to && isYmd(search.from) && isYmd(search.to));
  const currentPreset = toRange(search.range);

  const applyPreset = (d: RangeDays) =>
    navigate({
      to: ".",
      search: (prev) => ({ ...prev, range: d, from: undefined, to: undefined }),
    });
  const applyCustom = (from: string, to: string) =>
    navigate({ to: ".", search: (prev) => ({ ...prev, from, to, range: undefined }) });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-2 rounded-md border border-border bg-card hover:bg-accent px-3 h-9 text-xs transition-colors">
          <Calendar className="size-3.5 text-muted-foreground" />
          <span className="font-medium">{rangeLabel(search)}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        {RANGE_DAYS.map((d) => (
          <button
            key={d}
            onClick={() => applyPreset(d)}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
          >
            <Check
              className={cn(
                "size-3.5",
                !isCustom && d === currentPreset ? "opacity-100" : "opacity-0",
              )}
            />
            {RANGE_LABELS[d]}
          </button>
        ))}
        <div className="mt-1 border-t border-border pt-2">
          <p className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Custom range
          </p>
          <CustomRange from={search.from} to={search.to} onApply={applyCustom} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
