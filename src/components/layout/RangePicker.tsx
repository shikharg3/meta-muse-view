import { useNavigate, useSearch } from "@tanstack/react-router";
import { Calendar, Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RANGE_DAYS, RANGE_LABELS, toRange } from "@/lib/range";
import { cn } from "@/lib/utils";

/** Global date-range selector; writes `?range=` on the current route so loaders refetch. */
export function RangePicker() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { range?: number };
  const current = toRange(search.range);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded-md border border-border bg-card hover:bg-accent px-3 h-9 text-xs transition-colors">
          <Calendar className="size-3.5 text-muted-foreground" />
          <span className="font-medium">{RANGE_LABELS[current]}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        {RANGE_DAYS.map((d) => (
          <DropdownMenuItem
            key={d}
            className="text-xs gap-2"
            onClick={() => navigate({ to: ".", search: (prev) => ({ ...prev, range: d }) })}
          >
            <Check className={cn("size-3.5", d === current ? "opacity-100" : "opacity-0")} />
            {RANGE_LABELS[d]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
