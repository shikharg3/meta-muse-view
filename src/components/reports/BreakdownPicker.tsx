import { useMemo, useState } from "react";
import { Check, ChevronDown, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { REPORT_BREAKDOWNS } from "@/lib/report-options";

interface BreakdownPickerProps {
  breakdown: string;
  onBreakdownChange: (key: string) => void;
  splitByDay: boolean;
  onSplitByDayChange: (v: boolean) => void;
}

/**
 * Presentation grouping for the two dozen dimensions. Ordering only — `REPORT_BREAKDOWNS` stays the
 * single source of truth for which keys exist, so a key listed here but absent there is dropped and
 * a key present there but unlisted here falls through to "Other" (below). Neither case can make the
 * picker offer a dimension the engine cannot run, or hide one it can.
 */
const GROUPS: { label: string; keys: string[]; adLevelOnly?: boolean }[] = [
  { label: "Entity", keys: ["campaign", "adset", "ad"] },
  { label: "Audience", keys: ["age", "gender", "age_gender", "country", "region", "market"] },
  { label: "Placement", keys: ["platform", "placement", "device"] },
  { label: "Time", keys: ["hour", "hour_audience", "frequency"] },
  {
    // Meta serves dynamic-creative asset breakdowns at ad level only; every item carries the hint.
    label: "Assets",
    adLevelOnly: true,
    keys: [
      "image_asset",
      "video_asset",
      "title_asset",
      "body_asset",
      "cta_asset",
      "description_asset",
      "link_asset",
    ],
  },
];

export function BreakdownPicker({
  breakdown,
  onBreakdownChange,
  splitByDay,
  onSplitByDayChange,
}: BreakdownPickerProps) {
  const [open, setOpen] = useState(false);

  const sections = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const b of REPORT_BREAKDOWNS) labels[b.key] = b.label;
    // "none" is pinned above the groups, so it must not also be claimed by one.
    const claimed = new Set<string>(["none"]);
    const groups = GROUPS.map((g) => {
      const items = g.keys.flatMap((key) => {
        const label = labels[key];
        if (label === undefined) return [];
        claimed.add(key);
        return [{ key, label, adLevelOnly: g.adLevelOnly === true }];
      });
      return { label: g.label, items };
    }).filter((g) => g.items.length > 0);

    const other = REPORT_BREAKDOWNS.filter((b) => !claimed.has(b.key));
    if (other.length > 0) {
      groups.push({
        label: "Other",
        items: other.map((b) => ({ key: b.key, label: b.label, adLevelOnly: false })),
      });
    }
    return groups;
  }, []);

  const activeLabel =
    REPORT_BREAKDOWNS.find((b) => b.key === breakdown)?.label ?? "Total (no breakdown)";

  const select = (key: string) => {
    onBreakdownChange(key);
    setOpen(false);
  };

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex flex-1 items-center gap-2 rounded-md border border-border bg-background hover:bg-accent px-3 h-9 text-xs transition-colors"
          >
            <Layers className="size-3.5 text-muted-foreground" />
            <span className="flex-1 text-left truncate">{activeLabel}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="p-0 w-[--radix-popover-trigger-width] min-w-72">
          <Command>
            <CommandInput placeholder="Search breakdowns…" className="text-xs" />
            <CommandList>
              <CommandEmpty>No matching breakdown.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="none total no breakdown"
                  className="text-xs gap-2"
                  onSelect={() => select("none")}
                >
                  <Check
                    className={cn("size-3.5 text-primary", breakdown !== "none" && "invisible")}
                  />
                  <span className="truncate">Total (no breakdown)</span>
                </CommandItem>
              </CommandGroup>
              {sections.map((section) => (
                <CommandGroup key={section.label} heading={section.label}>
                  {section.items.map((item) => (
                    <CommandItem
                      key={item.key}
                      // Key included so a user who knows the API dimension name can search for it.
                      value={`${item.label} ${item.key}`}
                      className="text-xs gap-2"
                      onSelect={() => select(item.key)}
                    >
                      <Check
                        className={cn(
                          "size-3.5 text-primary",
                          breakdown !== item.key && "invisible",
                        )}
                      />
                      <span className="truncate">{item.label}</span>
                      {item.adLevelOnly && (
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                          ad level only
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap cursor-pointer">
        <input
          type="checkbox"
          checked={splitByDay}
          onChange={(e) => onSplitByDayChange(e.target.checked)}
          className="size-3.5 accent-primary"
        />
        Split by day
      </label>
    </div>
  );
}
