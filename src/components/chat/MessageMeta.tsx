import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, Minus, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtCost, HIGH_TURN_COST } from "./thread-cost";
import type { TraceItem } from "./trace";

type RowState = "running" | "ok" | "fail" | "cancelled";

/**
 * What a finished answer cost, in a bar you can actually read.
 *
 * The previous version was `1 tool · 7.5s · $0.04` at 10-11px in muted grey, and it was reported
 * unreadable twice. The numbers are the point of this row — cost especially, since not reading it is
 * what let one thread reach $59 — so it is now a bordered bar at 12px with the cost in a filled chip
 * that goes amber, then red, as a single question gets expensive.
 */
export function MessageMeta({ items, costUsd }: { items: TraceItem[]; costUsd?: number }) {
  const [open, setOpen] = useState(false);
  const hasCost = costUsd != null && costUsd > 0;
  if (items.length === 0 && !hasCost) return null;

  const total = items.reduce((sum, t) => sum + (t.ms ?? 0), 0);
  const failed = items.filter((t) => t.ok === false).length;
  const pricey = hasCost && costUsd >= HIGH_TURN_COST;

  return (
    <div className="min-w-0">
      <div className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5">
        {items.length > 0 && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/80 hover:text-foreground"
            title="Show which data was fetched, and how long each call took"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            <Wrench className="size-3.5 text-muted-foreground" />
            <span>
              {items.length} tool{items.length === 1 ? "" : "s"}
            </span>
          </button>
        )}
        {total > 0 && (
          <span
            className="font-mono text-xs tabular-nums text-muted-foreground"
            title="Time spent fetching data"
          >
            {fmtMs(total)}
          </span>
        )}
        {failed > 0 && (
          <span className="text-xs font-medium text-destructive">{failed} failed</span>
        )}
        {hasCost && (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums",
              pricey
                ? "bg-warning/20 text-warning ring-1 ring-warning/40"
                : "bg-primary/15 text-foreground",
            )}
            title={
              "What this one question cost.\n" +
              "The running total for the whole chat is in the header — every question re-sends the thread."
            }
          >
            {fmtCost(costUsd)}
          </span>
        )}
      </div>
      {open && items.length > 0 && (
        <div className="mt-1.5 space-y-1 rounded-lg border border-border bg-muted/20 px-3 py-2">
          {items.map((item, i) => (
            <TraceRow key={`${item.name}-${i}`} item={item} live={false} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The live trace under an in-flight answer: one row per tool, spinner while it runs, tick/cross and
 * the honest duration once it lands. Labels come off the event — the UI keeps no name→label table,
 * because the one it used to keep went stale the moment a tool was added.
 */
export function ToolTraceLive({ items, status }: { items: TraceItem[]; status?: string }) {
  if (items.length === 0 && !status) return null;
  return (
    <div className="space-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2">
      {items.map((item, i) => (
        <TraceRow key={`${item.name}-${i}`} item={item} live />
      ))}
      {status && (
        <div className="flex items-center gap-2 text-xs leading-5 text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          {status}
        </div>
      )}
    </div>
  );
}

function TraceRow({ item, live }: { item: TraceItem; live: boolean }) {
  const state: RowState =
    item.ok === undefined ? (live ? "running" : "cancelled") : item.ok ? "ok" : "fail";
  return (
    <div className="flex items-center gap-2 text-xs leading-5">
      <span className="grid size-3.5 shrink-0 place-items-center">
        {state === "running" ? (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        ) : state === "ok" ? (
          <Check className="size-3.5 text-success" />
        ) : state === "fail" ? (
          <X className="size-3.5 text-destructive" />
        ) : (
          <Minus className="size-3.5 text-muted-foreground" />
        )}
      </span>
      <span
        className={cn(
          "shrink-0 font-medium",
          state === "fail" ? "text-destructive" : "text-foreground/90",
        )}
      >
        {item.label ?? item.name}
      </span>
      {item.detail && (
        <span className="truncate font-mono text-muted-foreground" title={item.detail}>
          {item.detail}
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">
        {item.ms == null ? (state === "cancelled" ? "stopped" : "") : fmtMs(item.ms)}
      </span>
    </div>
  );
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
