import { createFileRoute, redirect, notFound, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { RiskBadge } from "@/components/infra/RiskBadge";
import { getInfraBmDetail } from "@/lib/api/infrastructure";
import { getCurrentUser } from "@/lib/api/auth";
import { isAdmin } from "@/lib/auth/roles";
import { fmtRelTime } from "@/lib/format";
import { redundancy } from "@/lib/infra-risk";
import { cn } from "@/lib/utils";
import type { BmDetail } from "@/server/fns/infra/bms";

export const Route = createFileRoute("/infrastructure/business-managers/$id")({
  loader: async ({ params }) => {
    const me = await getCurrentUser();
    if (!isAdmin(me?.role)) throw redirect({ to: "/" });
    const detail = await getInfraBmDetail({ data: params.id });
    if (!detail) throw notFound();
    return detail;
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.bm.name ?? "Business Manager"} — MetaConsole` }],
  }),
  component: BmDetailPage,
  notFoundComponent: () => (
    <div className="p-6 md:p-8 space-y-4 max-w-[1100px]">
      <Link
        to="/infrastructure/business-managers"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" /> All Business Managers
      </Link>
      <p className="text-sm text-muted-foreground">Business Manager not found.</p>
    </div>
  ),
});

/**
 * The access chain, top to bottom: this BM is reachable only through a profile that can still log in.
 * Unusable profiles stay listed rather than filtered out — a struck-through row is the evidence that
 * a path existed and was lost, which is the whole point of keeping the registry.
 */
function AccessChain({ profiles }: { profiles: BmDetail["profiles"] }) {
  const usable = profiles.filter((p) => p.usable).length;
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold">Access chain</h2>
        <span className="text-[11px] text-muted-foreground font-mono">
          {usable} of {profiles.length} usable
        </span>
      </div>
      <div className="px-5 py-4 space-y-3">
        <p className="text-[11px] text-muted-foreground">
          Business Manager → profiles. Every usable profile is one independent way back in.
        </p>
        {profiles.length > 0 && (
          <ul className="divide-y divide-border">
            {profiles.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <span className={cn("text-sm", !p.usable && "opacity-60 line-through")}>
                  {p.name}
                </span>
                <StatusPill status={p.status} />
              </li>
            ))}
          </ul>
        )}
        {usable === 0 && (
          <p className="text-xs text-destructive">No usable profile — this BM is unreachable.</p>
        )}
      </div>
    </div>
  );
}

function AdAccountsCard({ adAccounts }: { adAccounts: BmDetail["adAccounts"] }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold">Ad accounts</h2>
        <span className="text-[11px] text-muted-foreground font-mono">
          {adAccounts.length} linked
        </span>
      </div>
      {adAccounts.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          No ad accounts are linked to this Business Manager.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {adAccounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
              <span className="text-sm">{a.label ?? a.id}</span>
              {a.label && (
                <span className="font-mono text-[10px] text-muted-foreground">{a.id}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Why a status is what it is, in the operator's own words.
 *
 * Keyed by index because the rows are an immutable, server-ordered slice: two events can share a
 * timestamp and kind, so nothing else here is guaranteed unique.
 */
function HistoryCard({ history }: { history: BmDetail["history"] }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold">History</h2>
        <span className="text-[11px] text-muted-foreground font-mono">
          {history.length} event{history.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
              <th className="text-left px-5 py-2.5">When</th>
              <th className="text-left px-3 py-2.5">Event</th>
              <th className="text-left px-3 py-2.5">Change</th>
              <th className="text-left px-3 py-2.5">Reason</th>
              <th className="text-left px-5 py-2.5">By</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {history.map((h, i) => (
              <tr key={`${h.at}-${i}`} className="hover:bg-accent/40 transition-colors">
                <td className="px-5 py-3 text-[11px] text-muted-foreground whitespace-nowrap">
                  {fmtRelTime(h.at)}
                </td>
                <td className="px-3 py-3 text-xs">{h.event}</td>
                <td className="px-3 py-3 text-xs font-mono whitespace-nowrap">
                  {h.event === "verify"
                    ? "verified"
                    : `${h.fromStatus ?? "—"} → ${h.toStatus ?? "—"}`}
                </td>
                <td className="px-3 py-3 text-xs text-muted-foreground">{h.reason ?? "—"}</td>
                <td className="px-5 py-3 text-xs text-muted-foreground">{h.actorEmail}</td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-sm text-muted-foreground">
                  No recorded changes yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BmDetailPage() {
  const detail = Route.useLoaderData();
  const usableProfiles = detail.profiles.filter((p) => p.usable).length;

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1100px]">
      <Link
        to="/infrastructure/business-managers"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" /> All Business Managers
      </Link>

      <PageHeader title={detail.bm.name} description={`BM ${detail.bm.bmId}`}>
        <StatusPill status={detail.bm.status} />
        <RiskBadge risk={redundancy(usableProfiles)} />
      </PageHeader>

      <AccessChain profiles={detail.profiles} />
      <AdAccountsCard adAccounts={detail.adAccounts} />
      <HistoryCard history={detail.history} />
    </div>
  );
}
