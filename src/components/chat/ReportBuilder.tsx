import { useEffect, useRef, useState } from "react";
import { Briefcase, ChevronDown, Columns3, FileText, X } from "lucide-react";
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
  REPORT_BREAKDOWNS,
  REPORT_COLUMNS,
  DEFAULT_REPORT_COLUMN_KEYS,
} from "@/lib/report-options";
import { DATE_PRESETS } from "@/lib/date-presets";
import { ColumnPickerDialog } from "@/components/reports/ColumnPickerDialog";
import { RangePicker, type RangeValue } from "@/components/reports/RangePicker";
import { BreakdownPicker } from "@/components/reports/BreakdownPicker";
import { TimeIncrementPicker } from "@/components/reports/TimeIncrementPicker";
import { isAdditive, metric } from "@/lib/report-catalog";
import { DEFAULT_TIME_INCREMENT, TIME_INCREMENTS, type TimeIncrement } from "@/lib/time-increment";
import { getReportCatalog } from "@/lib/api/report-catalog";
import { getClientCampaigns } from "@/lib/api/clients";

export interface ReportRequest {
  clientId: string;
  clientName: string;
  /** A DATE_PRESETS key. Preferred over `days`, so a saved template stays meaningful over time. */
  preset?: string;
  days?: number;
  since?: string;
  until?: string;
  columns: string[];
  breakdown: string;
  /** Meta's `time_increment`. */
  timeIncrement?: TimeIncrement;
  markup?: number;
  campaignIds?: string[];
  summary: string;
}

interface Props {
  clients: { id: string; name: string; status: string | null; accountCount: number }[];
  busy: boolean;
  onSubmit: (req: ReportRequest) => void;
  onClose?: () => void;
  lockedClient?: { id: string; name: string }; // pre-selected + locked (used on the client page)
  /**
   * Seed values, e.g. from a saved template. Read once into initial state; a caller switches seeds
   * by remounting (a `key`), so a later prop change never clobbers an edit in progress.
   */
  initial?: Partial<ReportRequest> & { rangePreset?: string | null };
}

export function ReportBuilder({ clients, busy, onSubmit, onClose, lockedClient, initial }: Props) {
  const [clientId, setClientId] = useState(lockedClient?.id ?? initial?.clientId ?? "");
  const [clientName, setClientName] = useState(lockedClient?.name ?? initial?.clientName ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [range, setRange] = useState<RangeValue>(
    initial?.since && initial?.until
      ? { since: initial.since, until: initial.until }
      : { preset: initial?.preset ?? initial?.rangePreset ?? "last_7d" },
  );
  const [columns, setColumns] = useState<string[]>(initial?.columns ?? DEFAULT_REPORT_COLUMN_KEYS);
  // null = availability not known yet (no client, or the probe failed). The picker then shows every
  // metric rather than an empty list, which is the safe direction to fail in.
  const [availableKeys, setAvailableKeys] = useState<string[] | null>(null);
  const [breakdown, setBreakdown] = useState(initial?.breakdown ?? "none");
  // Meta's own default: one row per breakdown value across the whole range.
  const [timeIncrement, setTimeIncrement] = useState<TimeIncrement>(
    initial?.timeIncrement ?? DEFAULT_TIME_INCREMENT,
  );
  const [markupPct, setMarkupPct] = useState(
    initial?.markup ? Math.round(initial.markup * 100) : 0,
  );
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [selectedCampaigns, setSelectedCampaigns] = useState<Set<string>>(new Set());
  // Consumed once, by the load below: a seeded subset has to survive the campaign fetch, but a
  // client the user picks afterwards means "all campaigns", not the seed's now-foreign ids.
  const seedCampaignIds = useRef(initial?.campaignIds);

  // Load the client's campaigns when it changes; default to all selected (= no filter).
  useEffect(() => {
    if (!clientId) {
      setCampaigns([]);
      setSelectedCampaigns(new Set());
      return;
    }
    let cancelled = false;
    void getClientCampaigns({ data: clientId }).then((cs) => {
      if (cancelled) return;
      setCampaigns(cs);
      const seed = seedCampaignIds.current;
      seedCampaignIds.current = undefined;
      const kept = seed?.filter((id) => cs.some((c) => c.id === id)) ?? [];
      setSelectedCampaigns(new Set(kept.length > 0 ? kept : cs.map((c) => c.id)));
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  // Probe which metrics actually hold data for this client and window, so the picker can hide the
  // ~100 that would render a column of zeros. Failure is non-fatal: `null` means "show everything".
  useEffect(() => {
    if (!clientId) {
      setAvailableKeys(null);
      return;
    }
    let cancelled = false;
    const probe =
      "preset" in range ? { preset: range.preset } : { since: range.since, until: range.until };
    void getReportCatalog({ data: { clientId, ...probe } })
      .then((r) => {
        if (!cancelled) setAvailableKeys(r.keys);
      })
      .catch(() => {
        if (!cancelled) setAvailableKeys(null);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, range]);

  const toggleCampaign = (id: string) =>
    setSelectedCampaigns((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const customIncomplete = !("preset" in range) && (!range.since || !range.until);
  const canSubmit = !!clientId && columns.length > 0 && !customIncomplete && !busy;
  // Which chosen columns this granularity cannot report. Only the time axis is checked here: a
  // multi-account client also withholds them at daily granularity, but the account count is the
  // engine's business and the payload's note says so on the way back.
  const withheldMetrics =
    timeIncrement === "1"
      ? []
      : columns.filter((k) => !isAdditive(k)).map((k) => metric(k)?.label ?? k);

  const submit = () => {
    if (!canSubmit) return;
    // Emit the user's own column order — the picker's right pane IS the report layout.
    const bd = REPORT_BREAKDOWNS.find((b) => b.key === breakdown)?.label ?? breakdown;
    const rangeLabel =
      "preset" in range
        ? (DATE_PRESETS.find((p) => p.key === range.preset)?.label ?? range.preset)
        : `${range.since} → ${range.until}`;
    const incrementLabel =
      timeIncrement === DEFAULT_TIME_INCREMENT
        ? ""
        : ` × ${(TIME_INCREMENTS.find((t) => t.key === timeIncrement)?.label ?? timeIncrement).toLowerCase()}`;

    // Only send ids when a proper non-empty subset is chosen; all/none = every campaign.
    const allCampaigns = campaigns.length > 0 && selectedCampaigns.size === campaigns.length;
    const campaignIds =
      campaigns.length > 0 && selectedCampaigns.size > 0 && !allCampaigns
        ? [...selectedCampaigns]
        : undefined;
    onSubmit({
      clientId,
      clientName,
      ...("preset" in range
        ? { preset: range.preset }
        : { since: range.since, until: range.until }),
      columns,
      breakdown,
      timeIncrement,
      markup: markupPct ? markupPct / 100 : undefined,
      campaignIds,
      summary: `${clientName} · ${rangeLabel.toLowerCase()} · ${bd.toLowerCase()}${incrementLabel} · ${columns.length} columns${markupPct ? ` · +${markupPct}% markup` : ""}${campaignIds ? ` · ${campaignIds.length} campaigns` : ""}`,
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
            <button
              disabled={!!lockedClient}
              className="flex w-full items-center gap-2 rounded-md border border-border bg-background enabled:hover:bg-accent px-3 h-9 text-xs transition-colors"
            >
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

      {/* Campaigns — optional filter; restricts which rows are aggregated, at any granularity */}
      {campaigns.length > 0 && (
        <Field label={`Campaigns (${selectedCampaigns.size}/${campaigns.length})`}>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => setSelectedCampaigns(new Set(campaigns.map((c) => c.id)))}
                className="text-primary hover:underline"
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setSelectedCampaigns(new Set())}
                className="text-muted-foreground hover:underline"
              >
                None
              </button>
              <span className="ml-auto text-muted-foreground">applies to every report</span>
            </div>
            <div className="flex max-h-32 flex-wrap gap-1.5 overflow-auto">
              {campaigns.map((c) => (
                <Chip
                  key={c.id}
                  active={selectedCampaigns.has(c.id)}
                  onClick={() => toggleCampaign(c.id)}
                >
                  {c.name}
                </Chip>
              ))}
            </div>
          </div>
        </Field>
      )}

      {/* Date range — 19 named presets, resolved locally against our own daily rows */}
      <Field label="Date range">
        <RangePicker value={range} onChange={setRange} />
      </Field>

      {/* Columns — the picker needs the viewport, so it lives in a dialog rather than this rail */}
      <Field label="Columns">
        <button
          type="button"
          onClick={() => setColumnsOpen(true)}
          className="flex w-full items-center gap-2 rounded-md border border-border bg-background hover:bg-accent px-3 h-9 text-xs transition-colors"
        >
          <Columns3 className="size-3.5 text-muted-foreground" />
          <span className="flex-1 text-left">
            {columns.length} column{columns.length === 1 ? "" : "s"} selected
          </span>
          <span className="text-muted-foreground">Edit</span>
        </button>
        <ColumnPickerDialog
          open={columnsOpen}
          onOpenChange={setColumnsOpen}
          selected={columns}
          onChange={setColumns}
          availableKeys={availableKeys}
        />
      </Field>

      {/* Breakdown and granularity are separate Insights parameters, so they are separate controls */}
      <Field label="Breakdown">
        <BreakdownPicker breakdown={breakdown} onBreakdownChange={setBreakdown} />
      </Field>

      <Field label="Granularity">
        <TimeIncrementPicker
          value={timeIncrement}
          onChange={setTimeIncrement}
          withheld={withheldMetrics}
        />
      </Field>

      {/* Client markup — inflates spend, so every derived cost metric rises and ROAS falls */}
      <Field label="Client markup %">
        <input
          type="number"
          min={0}
          max={100}
          value={markupPct || ""}
          onChange={(e) => setMarkupPct(Number(e.target.value) || 0)}
          placeholder="0"
          className="w-full h-9 rounded-md border border-border bg-background px-2.5 text-xs"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Added to spend and every cost metric. Delivered figures — impressions, clicks, results,
          revenue — stay real.
        </p>
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
