import { useState } from "react";
import { CalendarDays, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DATE_PRESETS, resolvePreset, type DatePreset } from "@/lib/date-presets";

/**
 * Range control for the report builder: nineteen named presets plus an explicit custom pair.
 *
 * A discriminated union rather than a resolved `{ since, until }` because a saved template must keep
 * meaning next month — "Last month" stored as two literal dates silently freezes into the wrong
 * window. Resolution happens at run time, on the server, via `resolvePreset`.
 */
export type RangeValue = { preset: string } | { since: string; until: string };

interface RangePickerProps {
  value: RangeValue;
  onChange: (v: RangeValue) => void;
}

type CustomRange = { since: string; until: string };

const GROUP_ORDER: DatePreset["group"][] = ["relative", "calendar", "all"];

const GROUP_LABELS: Record<DatePreset["group"], string> = {
  relative: "Relative",
  calendar: "Calendar",
  all: "All time",
};

const isCustom = (v: RangeValue): v is CustomRange => !("preset" in v);

/** UTC, matching `resolvePreset`'s arithmetic — a local "today" would shift month boundaries. */
const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * Seed for the custom fields. Resolving the active preset means switching to Custom starts from the
 * window the user is already looking at instead of two blank inputs they have to fill from scratch.
 */
function seedCustom(v: RangeValue): CustomRange {
  if (isCustom(v)) return v;
  return resolvePreset(v.preset, todayIso()) ?? { since: "", until: "" };
}

export function RangePicker({ value, onChange }: RangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CustomRange>(() => seedCustom(value));

  const custom = isCustom(value);
  const activePreset = custom ? null : DATE_PRESETS.find((p) => p.key === value.preset);
  const triggerLabel = custom
    ? `${value.since || "—"} → ${value.until || "—"}`
    : (activePreset?.label ?? "Select a range…");

  const editDraft = (patch: Partial<CustomRange>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    // Publish only a complete pair: a half-typed range would have the parent fetch a nonsense
    // window (and, on the client page, refetch availability) on every keystroke.
    if (next.since && next.until) onChange(next);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        // Reseed on open so the custom fields track whatever preset is active now.
        if (o) setDraft(seedCustom(value));
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md border border-border bg-background hover:bg-accent px-3 h-9 text-xs transition-colors"
        >
          <CalendarDays className="size-3.5 text-muted-foreground" />
          <span className={cn("flex-1 text-left truncate", custom && "font-mono")}>
            {triggerLabel}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-[--radix-popover-trigger-width] min-w-72">
        <div className="max-h-72 overflow-auto p-1">
          {GROUP_ORDER.map((group) => {
            const presets = DATE_PRESETS.filter((p) => p.group === group);
            if (presets.length === 0) return null;
            return (
              <div key={group}>
                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                  {GROUP_LABELS[group]}
                </div>
                {presets.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => {
                      onChange({ preset: p.key });
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
                  >
                    <Check
                      className={cn(
                        "size-3.5 shrink-0 text-primary",
                        activePreset?.key !== p.key && "invisible",
                      )}
                    />
                    <span className="truncate text-left">{p.label}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <div className="border-t border-border p-2 space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Check className={cn("size-3.5 shrink-0 text-primary", !custom && "invisible")} />
            Custom range
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={draft.since}
              max={draft.until || undefined}
              onChange={(e) => editDraft({ since: e.target.value })}
              className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs font-mono"
            />
            <span className="text-muted-foreground text-xs">→</span>
            <input
              type="date"
              value={draft.until}
              min={draft.since || undefined}
              onChange={(e) => editDraft({ until: e.target.value })}
              className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs font-mono"
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
