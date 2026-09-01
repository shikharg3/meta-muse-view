import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Flag, IdCard, ShieldOff } from "lucide-react";
import { RiskBadge } from "@/components/infra/RiskBadge";
import { StatusPill } from "@/components/dashboard/StatusPill";
import type { InfraGraphNode } from "@/lib/infra-graph";
import type { SpinePageGroup } from "@/lib/infra-spine";
import { cn } from "@/lib/utils";

/**
 * Pages, grouped under the profile that owns them.
 *
 * Deliberately not on the canvas. Owner-to-page is one-to-many and nothing else — on the live registry
 * no page is linked to a BM at all, and a single profile owns 33 of them. Drawn as graph nodes they
 * were a fan of near-identical leaves that swamped the relationships that matter; as a list they
 * answer the only question worth asking of them, which is whether anyone besides the owner can get in.
 */
export function InfraPageGroups({
  groups,
  unattached,
}: {
  groups: SpinePageGroup[];
  unattached: InfraGraphNode[];
}) {
  const total = groups.reduce((sum, g) => sum + g.pages.length, 0);
  const atRisk = groups.reduce((sum, g) => sum + g.atRisk, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">Pages by owner</h2>
        <span className="font-mono text-[11px] text-muted-foreground">
          {atRisk} at risk of {total}
        </span>
        <span className="text-[11px] text-muted-foreground">
          A page is only as reachable as the profile that owns it.
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-5 py-8 text-center text-sm text-muted-foreground">
          No pages registered yet.
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {groups.map((group) => (
            <PageGroupCard key={group.owner.id} group={group} />
          ))}
        </div>
      )}

      {unattached.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-5 py-3">
          <IdCard className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">
            {unattached.length} profile{unattached.length === 1 ? "" : "s"} admin no Business
            Manager and own no page
          </span>
          <span className="text-[11px] text-muted-foreground">
            In the registry, absent from every access path — kept off the map on purpose.
          </span>
          <Link
            to="/infrastructure/profiles"
            className="ml-auto text-[11px] font-medium text-primary hover:underline"
          >
            Review profiles
          </Link>
        </div>
      )}
    </div>
  );
}

function PageGroupCard({ group }: { group: SpinePageGroup }) {
  // Collapsed by default: the header already carries the verdict, and 33 rows of detail is the exact
  // noise this redesign set out to remove.
  const [open, setOpen] = useState(false);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card",
        group.dead ? "border-destructive/50" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-accent/40"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {group.dead ? (
          <ShieldOff className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <IdCard className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-[13px] font-semibold">{group.owner.name}</span>
        <RiskBadge risk={group.owner.risk} className="shrink-0" />
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
          {group.atRisk > 0 && <span className="text-warning">{group.atRisk} at risk · </span>}
          {group.pages.length} page{group.pages.length === 1 ? "" : "s"}
        </span>
      </button>

      {group.dead && (
        <div className="border-t border-destructive/30 bg-destructive/[0.06] px-4 py-2 text-[11px] text-destructive">
          The owner cannot carry access, so every page below is held by a dead hand.
        </div>
      )}

      {open && (
        <ul className="divide-y divide-border border-t border-border">
          {group.pages.map((page) => (
            <li key={page.id} className="flex items-center gap-2.5 px-4 py-2">
              <Flag className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate text-[12px]">{page.name}</span>
              <StatusPill status={page.status} />
              <RiskBadge risk={page.risk} className="shrink-0" />
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {page.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
