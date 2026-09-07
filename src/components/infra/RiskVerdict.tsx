import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { AccessConcentration, RiskTallyRow } from "@/lib/infra-summary";

/**
 * The one-look verdict: severity at display scale, and the single fact a count of assets can never
 * carry — that one profile can be the whole estate's point of failure.
 *
 * Deliberately not five inventory tiles. "How many BMs do I own" is answered by the matrix's
 * Registered column; the top of a triage screen belongs to what is wrong.
 */
export function RiskVerdict({
  tally,
  concentration,
}: {
  tally: RiskTallyRow[];
  concentration: AccessConcentration | null;
}) {
  // Assets only. Profiles arrive in `tally` as the access-path line and are counted through what
  // they strand, so folding them in here would double-count the same incident.
  const assets = tally.filter((row) => row.kind !== "profile");
  const critical = assets.reduce((n, row) => n + row.critical, 0);
  const warning = assets.reduce((n, row) => n + row.warning, 0);
  const safe = assets.reduce((n, row) => n + row.safe, 0);
  const scored = critical + warning + safe;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex items-end gap-7">
          <Count
            value={critical}
            label="no backup"
            caption="unreachable if one more thing goes"
            tone="text-destructive"
          />
          <div className="h-12 w-px bg-border" />
          <Count
            value={warning}
            label="single access"
            caption="one access path left"
            tone="text-warning"
          />
        </div>
        <div className="text-right text-xs text-success">
          <CheckCircle2 className="mr-1 inline size-3.5 align-[-2px]" />
          {safe} of {scored} assets have two or more independent paths
        </div>
      </div>

      <div className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-muted">
        <Segment value={critical} of={scored} className="bg-destructive" />
        <Segment value={warning} of={scored} className="bg-warning" />
        <Segment value={safe} of={scored} className="bg-success/45" />
      </div>

      {concentration && (
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-warning/[0.07] px-3 py-2 text-xs ring-1 ring-warning/20">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            <Link
              to="/infrastructure/profiles"
              className="font-semibold underline decoration-dotted underline-offset-2"
            >
              {concentration.name}
            </Link>{" "}
            is the only usable admin of{" "}
            <span className="font-semibold">{concentration.bms} Business Managers</span>
            {concentration.strandedAssets > 0 ? (
              <>
                {" "}
                — one ban strands{" "}
                <span className="font-semibold">
                  {concentration.strandedAssets} asset
                  {concentration.strandedAssets === 1 ? "" : "s"}
                </span>
                .
              </>
            ) : (
              " — every asset behind them has another live path."
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function Count({
  value,
  label,
  caption,
  tone,
}: {
  value: number;
  label: string;
  caption: string;
  tone: string;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className={`text-5xl font-semibold leading-none tabular-nums ${tone}`}>{value}</span>
        <span className={`text-sm font-semibold uppercase tracking-wider ${tone}`}>{label}</span>
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground">{caption}</div>
    </div>
  );
}

/** An empty registry has nothing to divide by; the bar then renders as bare track. */
function Segment({ value, of, className }: { value: number; of: number; className: string }) {
  if (of === 0 || value === 0) return null;
  return <div className={className} style={{ width: `${(value / of) * 100}%` }} />;
}
