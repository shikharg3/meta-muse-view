import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface FilterMenuOption {
  value: string;
  label: string;
  /** Rows this value would match, counted against every *other* active facet. */
  count: number;
}

/** Options beyond this get a type-ahead; below it, one is noise on a list you can already scan. */
const SEARCH_THRESHOLD = 8;

/**
 * A multi-select facet: one trigger button, a checkbox list, per-option row counts.
 *
 * Multi-select rather than a `<select>` because the queries that matter are disjunctions —
 * "restricted or banned", "either of these two BMs" — and a single-value control cannot express one.
 *
 * The caller owns the selection and the counts; this component only renders and toggles. Toggling
 * filters the option vocabulary rather than splicing the selected array, so the parent's chips keep a
 * stable order instead of reshuffling on each click.
 */
export function FilterMenu({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: FilterMenuOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const needle = q.trim().toLowerCase();
  const visible = useMemo(
    () => (needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options),
    [options, needle],
  );

  const toggle = (value: string) => {
    const on = selected.includes(value);
    onChange(
      options
        .filter((o) => (o.value === value ? !on : selected.includes(o.value)))
        .map((o) => o.value),
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQ("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
            selected.length > 0
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          aria-label={`Filter by ${label}`}
        >
          {label}
          {selected.length > 0 && (
            <span className="rounded bg-primary px-1 font-mono text-[10px] text-primary-foreground">
              {selected.length}
            </span>
          )}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      {/* Portaled for the reason documented in LinkChips: the table below is `overflow-x-auto`. */}
      <PopoverContent align="start" className="w-64 p-1">
        {options.length > SEARCH_THRESHOLD && (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${label.toLowerCase()}…`}
            className="mb-1 h-7 w-full rounded border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        )}
        <div className="max-h-64 overflow-y-auto">
          {visible.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(option.value)}
                  className="size-3.5 shrink-0 accent-primary"
                />
                <span
                  className={cn("flex-1 truncate", option.count === 0 && "text-muted-foreground")}
                >
                  {option.label}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">{option.count}</span>
              </label>
            );
          })}
          {visible.length === 0 && (
            <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">No matches</p>
          )}
        </div>
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="mt-1 w-full rounded border-t border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Clear {label.toLowerCase()}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
