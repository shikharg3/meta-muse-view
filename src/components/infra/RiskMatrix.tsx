import { Link } from "@tanstack/react-router";
import { KIND_META } from "@/components/infra/kinds";
import type { InfraNodeKind } from "@/lib/infra-graph";
import type { RiskTallyRow } from "@/lib/infra-summary";
import { cn } from "@/lib/utils";

export type MatrixLevel = "critical" | "warning";
export interface MatrixCell {
  kind: InfraNodeKind;
  level: MatrixLevel;
}

/**
 * Type down, severity across: where the risk is, in one glance, and the filter for the list below.
 *
 * This grid is also why the screen no longer needs a row of count tiles — `Registered` carries the
 * inventory, and each number still deep-links to that entity's own page.
 *
 * Profiles sit below the totals rather than in them. A profile is a means of access, not an asset to
 * protect, so counting a blocked profile as a finding would double-count the BM it strands — the
 * arithmetic here is the same contract `profileRisk` and `buildRiskSummary` document.
 */
export function RiskMatrix({
  tally,
  selected,
  onSelect,
}: {
  tally: RiskTallyRow[];
  selected: MatrixCell | null;
  onSelect: (cell: MatrixCell | null) => void;
}) {
  const assets = tally.filter((row) => row.kind !== "profile");
  const profiles = tally.find((row) => row.kind === "profile");
  const sum = (pick: (row: RiskTallyRow) => number) => assets.reduce((n, row) => n + pick(row), 0);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <th className="px-5 py-2.5 text-left">Asset type</th>
            <th className="w-32 px-3 py-2.5 text-center text-destructive">No backup</th>
            <th className="w-32 px-3 py-2.5 text-center text-warning">Single access</th>
            <th className="w-32 px-3 py-2.5 text-center text-success">Redundant</th>
            <th className="w-32 px-5 py-2.5 text-right">Registered</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {assets.map((row) => (
            <Row key={row.kind} row={row} selected={selected} onSelect={onSelect} />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border bg-muted/20 text-[11px]">
            <td className="px-5 py-2.5">
              <button
                type="button"
                onClick={() => onSelect(null)}
                className={cn(
                  "uppercase tracking-wider hover:text-foreground",
                  selected ? "text-muted-foreground" : "font-semibold text-foreground",
                )}
              >
                all assets
              </button>
            </td>
            <td className="px-3 py-2.5 text-center font-mono font-semibold text-destructive">
              {sum((row) => row.critical)}
            </td>
            <td className="px-3 py-2.5 text-center font-mono font-semibold text-warning">
              {sum((row) => row.warning)}
            </td>
            <td className="px-3 py-2.5 text-center font-mono text-success">
              {sum((row) => row.safe)}
            </td>
            <td className="px-5 py-2.5 text-right font-mono text-muted-foreground">
              {sum((row) => row.registered)}
            </td>
          </tr>
          {profiles && (
            <tr className="border-t border-border">
              <td colSpan={5} className="px-5 pb-1 pt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Access paths — counted through the assets they strand, not as findings
                </p>
              </td>
            </tr>
          )}
          {profiles && <Row row={profiles} selected={selected} onSelect={onSelect} muted />}
        </tfoot>
      </table>
    </div>
  );
}

function Row({
  row,
  selected,
  onSelect,
  muted = false,
}: {
  row: RiskTallyRow;
  selected: MatrixCell | null;
  onSelect: (cell: MatrixCell | null) => void;
  muted?: boolean;
}) {
  const meta = KIND_META[row.kind];
  const Icon = meta.icon;
  const on = selected?.kind === row.kind;
  // Registry rows the risk model does not score: retired ad accounts, which are excluded on purpose.
  const unscored = row.registered - row.scored;

  return (
    <tr className={cn(on && "bg-accent/30", muted && "text-muted-foreground")}>
      <td className="px-5 py-3">
        <span className="flex items-center gap-2 font-medium">
          <Icon className="size-4 text-muted-foreground" />
          {meta.label}
        </span>
      </td>
      <Cell
        n={row.critical}
        tone="critical"
        on={on && selected?.level === "critical"}
        onClick={() => onSelect({ kind: row.kind, level: "critical" })}
      />
      <Cell
        n={row.warning}
        tone="warning"
        on={on && selected?.level === "warning"}
        onClick={() => onSelect({ kind: row.kind, level: "warning" })}
      />
      <Cell n={row.safe} tone="safe" />
      <td className="px-5 py-3 text-right">
        <Link
          to={meta.to}
          className="font-mono text-xs text-muted-foreground hover:text-foreground"
        >
          {row.registered}
          {unscored > 0 && <span className="ml-1 text-[10px]">({unscored} retired)</span>}
        </Link>
      </td>
    </tr>
  );
}

const TONE: Record<"critical" | "warning" | "safe", string> = {
  critical: "bg-destructive/15 text-destructive hover:brightness-125",
  warning: "bg-warning/15 text-warning hover:brightness-125",
  safe: "bg-success/10 text-success/90",
};

/**
 * A zero renders as a dot, not as `0`. On a screen read at a glance, fifteen zeroes are visual noise
 * competing with the two numbers that matter.
 */
function Cell({
  n,
  tone,
  on = false,
  onClick,
}: {
  n: number;
  tone: "critical" | "warning" | "safe";
  on?: boolean;
  onClick?: () => void;
}) {
  return (
    <td className="px-3 py-3 text-center">
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick || n === 0}
        className={cn(
          "inline-flex h-9 w-16 items-center justify-center rounded-lg font-mono text-base font-semibold tabular-nums",
          n === 0 ? "text-muted-foreground/40" : TONE[tone],
          on && "ring-2 ring-ring",
        )}
      >
        {n === 0 ? "·" : n}
      </button>
    </td>
  );
}
