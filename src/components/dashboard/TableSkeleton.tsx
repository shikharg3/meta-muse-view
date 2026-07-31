import { cn } from "@/lib/utils";

/** Column width recipe: first column is the wide "name" cell, rest are metrics. */
const CELL_WIDTHS = ["w-48", "w-16", "w-20", "w-16", "w-20", "w-14"];

function HeaderSkeleton() {
  return (
    <div className="mb-6 space-y-2">
      <div className="h-7 w-64 animate-pulse rounded bg-muted" />
      <div className="h-4 w-96 animate-pulse rounded bg-muted/70" />
    </div>
  );
}

/**
 * Shimmering stand-in for a data table. Used via the route pending components
 * below so a slow loader reads as "loading" instead of a blank content area.
 */
export function TableSkeleton({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
      <div className="flex h-10 items-center gap-4 border-b border-border bg-muted/30 px-4">
        {CELL_WIDTHS.map((w, i) => (
          <div
            key={i}
            className={cn("h-2.5 animate-pulse rounded bg-muted", w, i === 1 && "ml-auto")}
          />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="flex h-12 items-center gap-4 border-b border-border/50 px-4 last:border-b-0"
        >
          {CELL_WIDTHS.map((w, i) => (
            <div
              key={i}
              className={cn("h-3 animate-pulse rounded bg-muted", w, i === 1 && "ml-auto")}
              style={{ animationDelay: `${row * 70}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Page shell for list routes: title block, optional KPI strip, table.
 * Wired as the router's `defaultPendingComponent`.
 */
export function PagePendingSkeleton({ rows = 8, kpis = 4 }: { rows?: number; kpis?: number }) {
  return (
    <div className="max-w-[1600px] space-y-6 p-6 md:p-8">
      <HeaderSkeleton />
      {kpis > 0 && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: kpis }, (_, i) => (
            <div key={i} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div
                className="h-2.5 w-20 animate-pulse rounded bg-muted"
                style={{ animationDelay: `${i * 70}ms` }}
              />
              <div
                className="h-6 w-28 animate-pulse rounded bg-muted"
                style={{ animationDelay: `${i * 70}ms` }}
              />
            </div>
          ))}
        </div>
      )}
      <TableSkeleton rows={rows} />
    </div>
  );
}

/**
 * Page shell for card/panel grids — the creative gallery (`media`) and the
 * audience breakdown panels.
 */
export function PanelGridSkeleton({
  panels = 6,
  bars = 5,
  media = false,
}: {
  panels?: number;
  bars?: number;
  media?: boolean;
}) {
  return (
    <div className="max-w-[1600px] space-y-6 p-6 md:p-8">
      <HeaderSkeleton />
      <div
        className={cn(
          "grid grid-cols-1 gap-4",
          media ? "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "lg:grid-cols-2",
        )}
      >
        {Array.from({ length: panels }, (_, panel) => (
          <div key={panel} className="overflow-hidden rounded-xl border border-border bg-card">
            {media && (
              <div
                className="aspect-[4/3] animate-pulse bg-muted"
                style={{ animationDelay: `${panel * 70}ms` }}
              />
            )}
            <div className="space-y-3 p-4">
              <div className="h-3 w-32 animate-pulse rounded bg-muted" />
              {Array.from({ length: bars }, (_, bar) => (
                <div
                  key={bar}
                  className="h-2.5 animate-pulse rounded bg-muted"
                  style={{ width: `${90 - bar * 14}%`, animationDelay: `${bar * 70}ms` }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
