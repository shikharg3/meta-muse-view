import { useState } from "react";
import { Briefcase, ChevronDown, FileText, X } from "lucide-react";
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
import {
  REPORT_COLUMNS,
  REPORT_BREAKDOWNS,
  REPORT_RANGE_PRESETS,
  DEFAULT_REPORT_COLUMN_KEYS,
} from "@/lib/report-options";

export interface ReportRequest {
  clientId: string;
  clientName: string;
  days?: number;
  since?: string;
  until?: string;
  columns: string[];
  breakdown: string;
  markup?: number;
  summary: string;
}

interface Props {
  clients: { id: string; name: string; status: string | null; accountCount: number }[];
  busy: boolean;
  onSubmit: (req: ReportRequest) => void;
  onClose?: () => void;
}

export function ReportBuilder({ clients, busy, onSubmit, onClose }: Props) {
  const [clientId, setClientId] = useState("");
  const [clientName, setClientName] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [days, setDays] = useState(7);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [columns, setColumns] = useState<string[]>(DEFAULT_REPORT_COLUMN_KEYS);
  const [breakdown, setBreakdown] = useState("day");
  const [markupPct, setMarkupPct] = useState(0);

  const toggleColumn = (key: string) =>
    setColumns((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));

  const canSubmit = !!clientId && columns.length > 0 && (!custom || (!!since && !!until)) && !busy;

  const submit = () => {
    if (!canSubmit) return;
    // Emit columns in catalog order for a predictable layout.
    const ordered = REPORT_COLUMNS.filter((c) => columns.includes(c.key)).map((c) => c.key);
    const colLabels = REPORT_COLUMNS.filter((c) => columns.includes(c.key)).map((c) => c.label);
    const bd = REPORT_BREAKDOWNS.find((b) => b.key === breakdown)?.label ?? breakdown;
    const range = custom ? `${since} → ${until}` : `last ${days} days`;
    onSubmit({
      clientId,
      clientName,
      ...(custom ? { since, until } : { days }),
      columns: ordered,
      breakdown,
      markup: markupPct ? markupPct / 100 : undefined,
      summary: `${clientName} · ${range} · ${bd.toLowerCase()} · ${colLabels.join(", ")}${markupPct ? ` · +${markupPct}% markup` : ""}`,
    });
  };

  return (
    <div className="rounded-xl border border-border bg-card shadow-lg p-4 space-y-3.5">
      <div className="flex items-center gap-2">
        <FileText className="size-4 text-primary" />
        <h3 className="text-sm font-semibold flex-1">Build a report</h3>
        {onClose && (
          <button
            onClick={onClose}
            className="size-6 grid place-items-center rounded hover:bg-accent text-muted-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Client */}
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
                        setClientId(c.id);
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

      {/* Date range */}
      <Field label="Date range">
        <div className="flex flex-wrap items-center gap-1.5">
          {REPORT_RANGE_PRESETS.map((d) => (
            <Chip
              key={d}
              active={!custom && days === d}
              onClick={() => {
                setCustom(false);
                setDays(d);
              }}
            >
              {d}d
            </Chip>
          ))}
          <Chip active={custom} onClick={() => setCustom(true)}>
            Custom
          </Chip>
          {custom && (
            <div className="flex items-center gap-1.5 w-full mt-1.5">
              <input
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs font-mono"
              />
              <span className="text-muted-foreground text-xs">→</span>
              <input
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs font-mono"
              />
            </div>
          )}
        </div>
      </Field>

      {/* Columns */}
      <Field label={`Columns (${columns.length})`}>
        <div className="flex flex-wrap gap-1.5">
          {REPORT_COLUMNS.map((c) => (
            <Chip key={c.key} active={columns.includes(c.key)} onClick={() => toggleColumn(c.key)}>
              {c.label}
            </Chip>
          ))}
        </div>
      </Field>

      {/* Breakdown */}
      <Field label="Breakdown">
        <select
          value={breakdown}
          onChange={(e) => setBreakdown(e.target.value)}
          className="w-full h-9 rounded-md border border-border bg-background px-2.5 text-xs"
        >
          {REPORT_BREAKDOWNS.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </select>
      </Field>

      {/* Client markup */}
      <Field label="Client markup %">
        <input
          type="number"
          min={0}
          max={100}
          value={markupPct || ""}
          onChange={(e) => setMarkupPct(Number(e.target.value) || 0)}
          placeholder="0 — added to spend & cost metrics for client-facing reports"
          className="w-full h-9 rounded-md border border-border bg-background px-2.5 text-xs"
        />
      </Field>

      <button
        onClick={submit}
        disabled={!canSubmit}
        className="w-full h-9 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
      >
        {busy ? "Generating…" : "Generate report"}
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
