import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, Minus, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TraceItem } from "./trace";

type RowState = "running" | "ok" | "fail" | "cancelled";

/**
 * The live trace under an in-flight answer: one row per tool, spinner while it runs, tick/cross and
 * the honest duration once it lands. Labels come off the event — the UI keeps no name→label table,
 * because the one it used to keep went stale the moment a tool was added.
 */
export function ToolTraceLive({ items, status }: { items: TraceItem[]; status?: string }) {
  if (items.length === 0 && !status) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 space-y-1">
      {items.map((item, i) => (
        <TraceRow key={`${item.name}-${i}`} item={item} live />
      ))}
      {status && (
        <div className="flex items-center gap-2 text-[11px] leading-5 text-muted-foreground">
          <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
          <span className="truncate">{status}</span>
        </div>
      )}
    </div>
  );
}

/**
 * The same trace on a finished message, collapsed to one line so a long thread stays readable.
 * Expanding shows every call with its duration — the answer to "why did that take nine seconds".
 */
export function ToolTraceSummary({ items }: { items: TraceItem[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const total = items.reduce((sum, t) => sum + (t.ms ?? 0), 0);
  const failed = items.filter((t) => t.ok === false).length;
  return (
    <div className="min-w-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Wrench className="size-3" />
        {items.length} tool{items.length === 1 ? "" : "s"}
        {total > 0 && <span className="font-mono">· {fmtMs(total)}</span>}
        {failed > 0 && <span className="text-destructive">· {failed} failed</span>}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1 rounded-lg border border-border bg-muted/20 px-3 py-2">
          {items.map((item, i) => (
            <TraceRow key={`${item.name}-${i}`} item={item} live={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function TraceRow({ item, live }: { item: TraceItem; live: boolean }) {
  const state: RowState =
    item.ok === undefined ? (live ? "running" : "cancelled") : item.ok ? "ok" : "fail";
  return (
    <div className="flex items-center gap-2 text-[11px] leading-5">
      <span className="grid size-3.5 shrink-0 place-items-center">
        {state === "running" ? (
          <Loader2 className="size-3 animate-spin text-primary" />
        ) : state === "ok" ? (
          <Check className="size-3 text-success" />
        ) : state === "fail" ? (
          <X className="size-3 text-destructive" />
        ) : (
          <Minus className="size-3 text-muted-foreground" />
        )}
      </span>
      <span
        className={cn(
          "shrink-0 font-medium",
          state === "fail" ? "text-destructive" : "text-foreground/80",
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
