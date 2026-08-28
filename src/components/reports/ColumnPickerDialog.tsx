/**
 * Column picker — the whole metric catalog behind a search box.
 *
 * Two panes because there are two different questions. Left answers "what can I measure": the
 * catalog, grouped and searchable, since 112 flat checkboxes is a haystack. Right answers "what
 * will my report look like": the picked keys in order, with ↑/↓. The selected array IS the column
 * order the engine renders, so this dialog is the only place that order is authored — which is why
 * ticking a box appends rather than slotting the metric into catalog position.
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GROUP_LABELS, REPORT_METRICS, metric } from "@/lib/report-catalog";
import type { MetricGroup, ReportMetric } from "@/lib/report-catalog";

interface ColumnPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ordered catalog keys. */
  selected: string[];
  /** Ordered catalog keys. */
  onChange: (keys: string[]) => void;
  /** Keys with data for this client and range. `null` = unknown; show everything, no count. */
  availableKeys: string[] | null;
}

/** The catalog partitioned in GROUP_LABELS order. Static, so it is built once at module load. */
const GROUPS: { group: MetricGroup; label: string; metrics: ReportMetric[] }[] = (
  Object.keys(GROUP_LABELS) as MetricGroup[]
).map((group) => ({
  group,
  label: GROUP_LABELS[group],
  metrics: REPORT_METRICS.filter((m) => m.group === group),
}));

export function ColumnPickerDialog({
  open,
  onOpenChange,
  selected,
  onChange,
  availableKeys,
}: ColumnPickerDialogProps) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  // Membership is tested once per rendered row on every keystroke and every toggle; `includes` on
  // both arrays would make that quadratic over a 112-metric catalog.
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const availableSet = useMemo(
    () => (availableKeys ? new Set(availableKeys) : null),
    [availableKeys],
  );

  const needle = query.trim().toLowerCase();

  // Availability *hides* rather than greys out: on a client with no purchase data ~100 of the 112
  // rows are dead, and a wall of disabled checkboxes is noise you must read past to find the dozen
  // that work. Hiding silently would be worse — someone would scan the Conversions group for ROAS,
  // not find it, and conclude the catalog is broken — so the footer always states how many metrics
  // have data and offers `Show all` as the escape hatch.
  const groups = useMemo(() => {
    const gate = availableSet && !showAll ? availableSet : null;
    return GROUPS.map((g) => ({
      group: g.group,
      label: g.label,
      shown: g.metrics.filter(
        (m) =>
          (gate === null || gate.has(m.key)) &&
          (needle === "" ||
            m.label.toLowerCase().includes(needle) ||
            m.key.toLowerCase().includes(needle)),
      ),
    })).filter((g) => g.shown.length > 0);
  }, [availableSet, showAll, needle]);

  /** Select appends, deselect splices out. Never re-sorts — user order is the deliverable. */
  const toggle = (key: string) => {
    onChange(selectedSet.has(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= selected.length) return;
    const next = selected.slice();
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  // Drop the search on close: reopening into a stale query looks like a half-empty catalog.
  // `Show all` is a deliberate preference, so it survives.
  const handleOpenChange = (next: boolean) => {
    if (!next) setQuery("");
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-4xl" aria-describedby={undefined}>
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-semibold">Report columns</DialogTitle>
        </DialogHeader>

        {/* Each pane scrolls on its own so the group headers and the order list stay reachable. */}
        <div className="flex max-h-[70vh] flex-col md:flex-row">
          <div className="flex min-h-0 flex-1 flex-col border-b border-border md:border-b-0 md:border-r">
            <div className="shrink-0 px-4 py-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search metrics…"
                  className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2.5 text-xs"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              {groups.length === 0 ? (
                <p className="py-10 text-center text-xs text-muted-foreground">
                  {needle
                    ? `No metric matches “${query.trim()}”.`
                    : "No metric has data for this client and range."}
                </p>
              ) : (
                groups.map((g) => {
                  const picked = g.shown.filter((m) => selectedSet.has(m.key)).length;
                  return (
                    <div key={g.group} className="pb-2">
                      <div className="sticky top-0 z-10 -mx-4 flex items-center gap-2 bg-background px-4 py-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {g.label}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {picked}/{g.shown.length}
                        </span>
                      </div>
                      {g.shown.map((m) => (
                        <label
                          key={m.key}
                          className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-accent"
                        >
                          <input
                            type="checkbox"
                            checked={selectedSet.has(m.key)}
                            onChange={() => toggle(m.key)}
                            className="size-3.5 accent-primary"
                          />
                          <span className="flex-1 truncate text-xs">{m.label}</span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            {m.key}
                          </span>
                        </label>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col md:w-72 md:flex-none">
            <div className="shrink-0 px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Column order
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 pb-4">
              {selected.length === 0 ? (
                <p className="py-10 text-center text-xs text-muted-foreground">
                  No columns yet. Tick metrics on the left — they land here in the order you pick
                  them.
                </p>
              ) : (
                selected.map((key, i) => (
                  <div
                    key={key}
                    className="flex items-center gap-1 rounded-md border border-border bg-background py-1 pl-2 pr-1"
                  >
                    <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                      {i + 1}
                    </span>
                    {/* A saved template can name a key the catalog has since dropped, and an
                        unavailable one is filtered out of the left pane — either way this row is
                        the only handle on it, so fall back to the raw key rather than blank. */}
                    <span className="flex-1 truncate text-xs">{metric(key)?.label ?? key}</span>
                    <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ChevronUp className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label="Move down"
                      disabled={i === selected.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ChevronDown className="size-3.5" />
                    </IconButton>
                    <IconButton label="Remove" onClick={() => toggle(key)}>
                      <X className="size-3.5" />
                    </IconButton>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{selected.length} selected</span>
          {availableKeys && (
            <>
              <span>
                {availableKeys.length} of {REPORT_METRICS.length} metrics have data for this client
                and range
              </span>
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                  className="size-3.5 accent-primary"
                />
                Show all
              </label>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
  );
}
