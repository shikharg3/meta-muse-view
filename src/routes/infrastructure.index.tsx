import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { CheckCircle2, Network, Star, Table2 } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { PagePendingSkeleton } from "@/components/dashboard/TableSkeleton";
import { FindingRow, type Finding } from "@/components/infra/FindingRow";
import { KIND_META } from "@/components/infra/kinds";
import { InfraPageGroups } from "@/components/infra/InfraPageGroups";
import { InfraSpineCanvas } from "@/components/infra/InfraSpineCanvas";
import { RiskMatrix, type MatrixCell, type MatrixLevel } from "@/components/infra/RiskMatrix";
import { RiskVerdict } from "@/components/infra/RiskVerdict";
import { getInfraRiskMap } from "@/lib/api/infrastructure";
import { getCurrentUser } from "@/lib/api/auth";
import { isAdmin } from "@/lib/auth/roles";
import { focusMain, INFRA_NODE_KINDS, type InfraNodeKind } from "@/lib/infra-graph";
import { RISK_ORDER } from "@/lib/infra-risk";
import { buildSpine } from "@/lib/infra-spine";
import { cn } from "@/lib/utils";

/**
 * The matrix is the default. "Where is the risk" is answered by counts in one glance; the drawn map
 * answers the different and slower question of what a specific ban would cost.
 */
type InfraView = "matrix" | "map";

function isKind(value: unknown): value is InfraNodeKind {
  return typeof value === "string" && (INFRA_NODE_KINDS as readonly string[]).includes(value);
}

export const Route = createFileRoute("/infrastructure/")({
  head: () => ({
    meta: [
      { title: "Infrastructure — MetaConsole" },
      {
        name: "description",
        content:
          "Access-path risk across profiles, Business Managers, ad accounts, pixels and pages.",
      },
    ],
  }),
  /**
   * The selected matrix cell lives in the URL so a finding can be linked to and survives a reload.
   * `type` without `level` is meaningless — a cell is both — so a half-specified pair falls back to
   * the unfiltered list rather than inventing one of the two.
   */
  validateSearch: (
    s: Record<string, unknown>,
  ): { view?: InfraView; type?: InfraNodeKind; level?: MatrixLevel; main?: true } => {
    const level = s.level === "critical" || s.level === "warning" ? s.level : undefined;
    const type = isKind(s.type) ? s.type : undefined;
    return {
      view: s.view === "map" ? "map" : undefined,
      // Present-or-absent, never `main=false`: a lens is on or it is not in the URL at all.
      ...(s.main === true || s.main === "1" || s.main === "true" ? { main: true as const } : {}),
      ...(type && level ? { type, level } : {}),
    };
  },
  loader: async () => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    return await getInfraRiskMap();
  },
  component: InfrastructurePage,
  pendingComponent: () => <PagePendingSkeleton rows={10} kpis={0} />,
});

function InfrastructurePage() {
  const map = Route.useLoaderData();
  const search = Route.useSearch();
  const view: InfraView = search.view ?? "matrix";
  const navigate = useNavigate({ from: "/infrastructure/" });
  const mainExists = map.main.bms + map.main.profiles > 0;
  // A lens nobody can leave is a trap: if every star is cleared while the lens is on, ignore it.
  const focused = search.main === true && mainExists;

  // Presentation grouping, not a second source of truth: the verdicts already came from the server.
  const spine = useMemo(
    () => buildSpine(focused ? focusMain(map.graph) : map.graph),
    [map.graph, focused],
  );

  // Memoised on the two primitives, not rebuilt per render: it is a dependency of `findings` below.
  const selected = useMemo<MatrixCell | null>(
    () => (search.type && search.level ? { kind: search.type, level: search.level } : null),
    [search.type, search.level],
  );

  /**
   * Rows arrive per type, each already sorted critical-first by the server. Tagging them with their
   * kind and re-sorting on `RISK_ORDER` is ordering, never classification — the verdict on every row
   * is the server's, exactly as `infra-risk.ts` requires.
   */
  const findings = useMemo(() => {
    const tagged: Finding[] = [
      ...map.bms.map((r) => ({ ...r, kind: "bm" as InfraNodeKind })),
      ...map.adAccounts.map((r) => ({ ...r, kind: "adAccount" as InfraNodeKind })),
      ...map.pixels.map((r) => ({ ...r, kind: "pixel" as InfraNodeKind })),
      ...map.pages.map((r) => ({ ...r, kind: "page" as InfraNodeKind })),
      ...map.profiles.map((r) => ({ ...r, kind: "profile" as InfraNodeKind })),
    ];
    const scoped = focused ? tagged.filter((r) => r.main) : tagged;
    const rows = selected
      ? scoped.filter((r) => r.kind === selected.kind && r.risk.level === selected.level)
      : // Unfiltered means every asset at risk. Profiles are access paths and appear only when their
        // own matrix cell is picked — or under the main lens, where a starred profile that cannot
        // carry access IS the finding. Otherwise it would be listed twice with the BM it strands.
        scoped.filter((r) => (focused || r.kind !== "profile") && r.risk.level !== "safe");
    // Within a severity band, starred rows lead. Severity still outranks the star: a critical
    // non-main asset is a worse fact than a warning on a main one, and burying it would be a lie.
    return rows.sort(
      (a, b) =>
        RISK_ORDER[a.risk.level] - RISK_ORDER[b.risk.level] ||
        Number(Boolean(b.main)) - Number(Boolean(a.main)) ||
        a.name.localeCompare(b.name),
    );
  }, [map, selected, focused]);

  return (
    <div className="max-w-[1600px] space-y-5 p-6 md:p-8">
      <PageHeader
        title="Infrastructure"
        description="An asset with fewer than two independent access paths is one ban away from unreachable."
        className="mb-0"
      >
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {(
            [
              { id: "matrix", label: "Risk", icon: Table2 },
              { id: "map", label: "Map", icon: Network },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() =>
                navigate({
                  search: (prev) => ({ ...prev, view: tab.id === "matrix" ? undefined : tab.id }),
                  replace: true,
                })
              }
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                view === tab.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <tab.icon className="size-3.5" />
              {tab.label}
            </button>
          ))}
        </div>
      </PageHeader>
      {view === "map" ? (
        <div className="space-y-8">
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-sm font-semibold">Access spine</h2>
              <span className="text-[11px] text-muted-foreground">
                Admin profiles sit inside the Business Manager they hold. A profile drawn outside is
                shared between several — one ban takes out every card it points at.
              </span>
              {mainExists && (
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      search: (prev) => ({ ...prev, main: focused ? undefined : true }),
                      replace: true,
                    })
                  }
                  aria-pressed={focused}
                  className={cn(
                    "ml-auto inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                    focused
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Star className={cn("size-3", focused && "fill-primary", "text-primary")} />
                  {focused ? "Main only" : "Show main only"}
                </button>
              )}
            </div>
            <InfraSpineCanvas spine={spine} />
          </div>
          {/* Under the lens an empty list means "no MAIN pages", but the section's own empty state
              says "No pages registered yet" — a false claim. Hide it rather than let it lie. */}
          {(!focused || spine.pageGroups.length > 0) && (
            <InfraPageGroups groups={spine.pageGroups} unattached={spine.unattached} />
          )}
        </div>
      ) : (
        <>
          <RiskVerdict
            tally={map.tally}
            concentration={map.concentration}
            main={map.main}
            mainOnly={focused}
            onToggleMainOnly={() =>
              navigate({
                search: (prev) => ({ ...prev, main: focused ? undefined : true }),
                replace: true,
              })
            }
          />
          <RiskMatrix
            tally={map.tally}
            selected={selected}
            onSelect={(cell) =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  type: cell?.kind,
                  level: cell?.level,
                }),
                replace: true,
              })
            }
          />
          <Findings
            findings={findings}
            selected={selected}
            atRisk={map.atRisk}
            mainOnly={focused}
          />
        </>
      )}
    </div>
  );
}

function Findings({
  findings,
  selected,
  atRisk,
  mainOnly,
}: {
  findings: Finding[];
  selected: MatrixCell | null;
  atRisk: number;
  mainOnly: boolean;
}) {
  if (findings.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card px-5 py-10 text-center">
        <CheckCircle2 className="mx-auto size-6 text-success" />
        <p className="mt-3 text-sm font-medium">
          {selected
            ? "Nothing in that cell."
            : mainOnly
              ? "Nothing wrong with your main infrastructure."
              : atRisk === 0
                ? "Every registered asset has at least two independent access paths."
                : "Nothing at risk."}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-5 py-2.5">
        <h2 className="text-sm font-semibold">
          {selected
            ? `${KIND_META[selected.kind].label} · ${selected.level === "critical" ? "no backup" : "single access"}`
            : mainOnly
              ? "Main infrastructure, worst first"
              : "Everything at risk, worst first"}
        </h2>
        <span className="font-mono text-[11px] text-muted-foreground">{findings.length}</span>
      </header>
      {findings.map((finding) => (
        <FindingRow key={`${finding.kind}:${finding.id}`} finding={finding} />
      ))}
    </div>
  );
}
