import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Star } from "lucide-react";
import type { AccessConcentration, InfraRiskSummary, RiskTallyRow } from "@/lib/infra-summary";
import { cn } from "@/lib/utils";

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
  main,
  mainOnly,
  onToggleMainOnly,
}: {
  tally: RiskTallyRow[];
  concentration: AccessConcentration | null;
  main: InfraRiskSummary["main"];
  mainOnly: boolean;
  onToggleMainOnly: () => void;
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

      {main.bms + main.profiles > 0 && (
        <button
          type="button"
          onClick={onToggleMainOnly}
          aria-pressed={mainOnly}
          className={cn(
            "mt-4 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs ring-1 transition-colors",
            mainOnly
              ? "bg-primary/10 ring-primary/40"
              : "bg-muted/40 ring-border hover:bg-accent/40",
          )}
        >
          <Star className={cn("size-3.5 shrink-0", mainOnly && "fill-primary", "text-primary")} />
          <span>
            <span className="font-semibold uppercase tracking-wider">Main</span>
            {" · "}
            <MainCount at={main.bmsAttention} of={main.bms} noun="Business Manager" />
            {main.profiles > 0 && (
              <>
                {" · "}
                <MainCount at={main.profilesAttention} of={main.profiles} noun="profile" />
              </>
            )}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {mainOnly ? "showing main only — show everything" : "show main only"}
          </span>
        </button>
      )}

      {concentration && (
        <div
          className={cn(
            "mt-4 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ring-1",
            concentration.blocked
              ? "bg-destructive/[0.08] ring-destructive/25"
              : "bg-warning/[0.07] ring-warning/20",
          )}
        >
          <AlertTriangle
            className={cn(
              "mt-0.5 size-3.5 shrink-0",
              concentration.blocked ? "text-destructive" : "text-warning",
            )}
          />
          <span>
            <Link
              to="/infrastructure/profiles"
              className="font-semibold underline decoration-dotted underline-offset-2"
            >
              {concentration.name}
            </Link>{" "}
            {concentration.blocked ? (
              <>
                cannot carry access, and{" "}
                <span className="font-semibold">
                  {concentration.bms} Business Managers it admins have no usable admin left
                </span>
                {concentration.assets > 0 ? (
                  <>
                    {" — "}
                    <span className="font-semibold">
                      {concentration.assets} asset{concentration.assets === 1 ? "" : "s"}
                    </span>{" "}
                    now sit behind a BM nobody can administer. Restoring this one profile is the
                    shortest way back in.
                  </>
                ) : (
                  ". Restoring this one profile is the shortest way back in."
                )}
              </>
            ) : (
              <>
                is the only usable admin of{" "}
                <span className="font-semibold">{concentration.bms} Business Managers</span>
                {concentration.assets > 0 ? (
                  <>
                    {" — one ban strands "}
                    <span className="font-semibold">
                      {concentration.assets} asset{concentration.assets === 1 ? "" : "s"}
                    </span>
                    .
                  </>
                ) : (
                  " — every asset behind them has another live path."
                )}
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * "2 of 4 Business Managers need attention" — or "all 4 … are redundant" when none do. Phrased in
 * full so the number cannot be read as a total; a bare "2/4" on this row has been mistaken for
 * "2 main BMs exist" every time it has been tried.
 */
function MainCount({ at, of, noun }: { at: number; of: number; noun: string }) {
  const plural = `${noun}${of === 1 ? "" : "s"}`;
  if (at === 0) {
    return (
      <span className="text-muted-foreground">
        all {of} {plural} redundant
      </span>
    );
  }
  return (
    <span>
      <span className="font-semibold">
        {at} of {of}
      </span>{" "}
      {plural} need{at === 1 ? "s" : ""} attention
    </span>
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
