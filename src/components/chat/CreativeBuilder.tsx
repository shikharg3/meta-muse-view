import { useState } from "react";
import { Briefcase, ChevronDown, Images, X } from "lucide-react";
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

const METRICS = [
  { key: "results", label: "Results" },
  { key: "spend", label: "Spend" },
  { key: "ctr", label: "CTR" },
  { key: "cpc", label: "CPC (cheapest)" },
  { key: "cost_per_result", label: "Cost / result" },
  { key: "roas", label: "ROAS" },
];
const DAYS = [3, 7, 14, 30];
const LIMITS = [4, 6, 8, 10];

interface Props {
  clients: { id: string; name: string; status: string | null; accountCount: number }[];
  busy: boolean;
  onSubmit: (prompt: string) => void;
  onClose: () => void;
}

export function CreativeBuilder({ clients, busy, onSubmit, onClose }: Props) {
  const [clientName, setClientName] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [days, setDays] = useState(7);
  const [metric, setMetric] = useState("results");
  const [limit, setLimit] = useState(6);

  const submit = () => {
    if (!clientName || busy) return;
    const m = METRICS.find((x) => x.key === metric)!;
    const by = metric === "results" ? "" : ` ranked by ${m.label.toLowerCase()}`;
    onSubmit(
      `/creativeanalysis Analyze the top ${limit} creatives for ${clientName} over the last ${days} days${by}.`,
    );
  };

  return (
    <div className="rounded-xl border border-border bg-card shadow-lg p-4 space-y-3.5">
      <div className="flex items-center gap-2">
        <Images className="size-4 text-primary" />
        <h3 className="text-sm font-semibold flex-1">Analyze creatives</h3>
        <button
          onClick={onClose}
          className="size-6 grid place-items-center rounded hover:bg-accent text-muted-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <Field label="Client">
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button className="flex w-full items-center gap-2 rounded-md border border-border bg-background hover:bg-accent px-3 h-9 text-xs transition-colors">
              <Briefcase className="size-3.5 text-muted-foreground" />
              <span
                className={cn("flex-1 text-left truncate", !clientName && "text-muted-foreground")}
              >
                {clientName || "Select a client…"}
              </span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="p-0 w-[--radix-popover-trigger-width] min-w-72">
            <Command>
              <CommandInput placeholder="Search clients…" className="text-xs" />
              <CommandList>
                <CommandEmpty>No clients.</CommandEmpty>
                <CommandGroup>
                  {clients.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={c.name}
                      className="text-xs gap-2"
                      onSelect={() => {
                        setClientName(c.name);
                        setPickerOpen(false);
                      }}
                    >
                      <span className="truncate">{c.name}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {c.accountCount} acct
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Timeframe">
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d) => (
              <Chip key={d} active={days === d} onClick={() => setDays(d)}>
                {d}d
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="Top N">
          <div className="flex flex-wrap gap-1.5">
            {LIMITS.map((n) => (
              <Chip key={n} active={limit === n} onClick={() => setLimit(n)}>
                {n}
              </Chip>
            ))}
          </div>
        </Field>
      </div>

      <Field label="Rank by">
        <div className="flex flex-wrap gap-1.5">
          {METRICS.map((m) => (
            <Chip key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>
              {m.label}
            </Chip>
          ))}
        </div>
      </Field>

      <button
        onClick={submit}
        disabled={!clientName || busy}
        className="w-full h-9 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
      >
        {busy ? "Analyzing…" : "Analyze creatives"}
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </span>
      {children}
    </label>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 h-7 text-[11px] font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}
