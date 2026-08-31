import { useState } from "react";
import { CalendarRange, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TIME_INCREMENTS, type TimeIncrement } from "@/lib/time-increment";

interface TimeIncrementPickerProps {
  value: TimeIncrement;
  onChange: (v: TimeIncrement) => void;
  /** Metrics the current selection will withhold, if any — see `isAdditive`. */
  withheld: string[];
}

/**
 * Meta's `time_increment` as its own control, beside the breakdown rather than inside it: they are
 * two independent axes in the Insights API, and the previous "Split by day" checkbox could only
 * express two of the five granularities Meta actually offers.
 */
export function TimeIncrementPicker({ value, onChange, withheld }: TimeIncrementPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = TIME_INCREMENTS.find((t) => t.key === value) ?? TIME_INCREMENTS[0];

  return (
    <div className="space-y-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 h-9 text-xs transition-colors hover:bg-accent"
          >
            <CalendarRange className="size-3.5 text-muted-foreground" />
            <span className="flex-1 text-left">{selected.label}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[--radix-popover-trigger-width] min-w-72 p-1"
          aria-describedby={undefined}
        >
          {TIME_INCREMENTS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                onChange(t.key);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
            >
              <Check
                className={cn("size-3.5 shrink-0 text-primary", t.key !== value && "invisible")}
              />
              <span className="truncate">{t.label}</span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{t.hint}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Stated at the point of choice, not discovered as an empty cell after generating: these are
          counts of distinct people, which Meta de-duplicates per row and nobody can re-add. */}
      {withheld.length > 0 && (
        <p className="text-[11px] leading-snug text-amber-500/90">
          {withheld.join(", ")} {withheld.length === 1 ? "is" : "are"} de-duplicated by Meta per day
          and per account, so {withheld.length === 1 ? "it" : "they"} cannot be summed into a wider
          row. Pick <span className="font-medium">Daily</span> to include{" "}
          {withheld.length === 1 ? "it" : "them"}.
        </p>
      )}
    </div>
  );
}
