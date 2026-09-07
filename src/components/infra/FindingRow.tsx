import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock, Star } from "lucide-react";
import { KIND_META } from "@/components/infra/kinds";
import type { InfraNodeKind } from "@/lib/infra-graph";
import type { RiskLevel } from "@/lib/infra-risk";
import type { InfraRiskRow } from "@/server/fns/infra/risk";
import { cn } from "@/lib/utils";

export interface Finding extends InfraRiskRow {
  kind: InfraNodeKind;
}

const RAIL: Record<RiskLevel, string> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  safe: "bg-success",
};

const VERDICT: Record<RiskLevel, string> = {
  critical: "text-destructive",
  warning: "text-warning",
  safe: "text-success",
};

/**
 * One finding, one line, one severity encoding.
 *
 * The table this replaces spent four columns and four encodings per row — status pill, risk badge,
 * detail text, overdue note — and still never said what would break. Colour appears exactly once,
 * on the rail; the verdict is a word; and a BM carries what it is the last live path to.
 */
export function FindingRow({ finding }: { finding: Finding }) {
  const meta = KIND_META[finding.kind];
  const Icon = meta.icon;
  const body = (
    <>
      <span className={cn("absolute inset-y-0 left-0 w-[3px]", RAIL[finding.risk.level])} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {finding.main && (
            <Star
              className="size-3.5 shrink-0 fill-primary text-primary"
              aria-label="Main"
              role="img"
            />
          )}
          <span className={cn("truncate text-sm", finding.main ? "font-semibold" : "font-medium")}>
            {finding.name}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <Icon className="size-3" />
            {meta.short}
          </span>
          <span
            className={cn(
              "text-[11px] font-semibold uppercase tracking-wider",
              VERDICT[finding.risk.level],
            )}
          >
            {finding.risk.label}
          </span>
          {finding.overdue && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Clock className="size-3" />
              unverified
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          <span className="font-mono">{finding.detail}</span>
          {!meta.normal.includes(finding.status) && (
            <>
              {" · "}
              <span className="font-mono">{finding.status}</span>
            </>
          )}
        </div>
      </div>

      <Strands strands={finding.strands} />

      <ArrowRight className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
    </>
  );

  // Main rows get a faint tint, never a colour: the rail already owns severity, and a starred row
  // competing with it on hue would make "important" look like "urgent".
  const className = cn(
    "group relative flex items-center gap-4 overflow-hidden border-b border-border px-5 py-3.5 transition-colors last:border-b-0 hover:bg-accent/40",
    finding.main && "bg-primary/[0.045]",
  );

  // Only BMs have a detail route; every other kind lands on its registry page.
  return finding.kind === "bm" ? (
    <Link
      to="/infrastructure/business-managers/$id"
      params={{ id: finding.id }}
      className={className}
    >
      {body}
    </Link>
  ) : (
    <Link to={meta.to} className={className}>
      {body}
    </Link>
  );
}

/** BMs only, and only when the ban would actually strand something. */
function Strands({ strands }: { strands?: { adAccounts: number; pixels: number; pages: number } }) {
  if (!strands) return null;
  const parts: string[] = [];
  if (strands.adAccounts) {
    parts.push(`${strands.adAccounts} ad account${strands.adAccounts === 1 ? "" : "s"}`);
  }
  if (strands.pixels) parts.push(`${strands.pixels} pixel${strands.pixels === 1 ? "" : "s"}`);
  if (strands.pages) parts.push(`${strands.pages} page${strands.pages === 1 ? "" : "s"}`);
  if (parts.length === 0) return null;

  return (
    <div className="hidden shrink-0 text-right sm:block">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
        last path to
      </div>
      <div className="text-[11px] text-foreground/80">{parts.join(" · ")}</div>
    </div>
  );
}
