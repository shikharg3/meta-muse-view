import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { fmtCurrency, fmtPct, fmtCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSort, SortHeader } from "@/components/dashboard/SortableTable";
import { CampaignTable } from "@/components/dashboard/CampaignTable";
import { StatusPill } from "@/components/dashboard/StatusPill";
import type { ClientDetail, CampaignBudget } from "@/server/fns/clients";

interface Props {
  detail: ClientDetail;
  budgets: CampaignBudget[];
  isAdmin: boolean;
  onMutate: (
    action: "add" | "remove",
    accountId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

/** Full client performance detail — every ad account, every campaign (with drill-down), objective-
 *  aware KPIs, budget and pacing. Shared by the /clients list preview and the standalone /clients/$id
 *  page so both stay in sync. Range is controlled by the caller (loader window). */
export function ClientDetailView({ detail, budgets, isAdmin, onMutate }: Props) {
  const [newAccount, setNewAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("ALL");

  // Objective-aware client total (leads/purchases/…), summed from its campaigns.
  const clientResults = useMemo(() => {
    const labelSpend = new Map<string, number>();
    for (const c of detail.campaigns)
      labelSpend.set(c.resultLabel, (labelSpend.get(c.resultLabel) ?? 0) + c.spend);
    let label = "Results";
    let best = -1;
    for (const [l, s] of labelSpend)
      if (s > best) {
        best = s;
        label = l;
      }
    return { value: detail.campaigns.reduce((n, c) => n + c.results, 0), label };
  }, [detail]);

  const accountSort = useSort(
    detail.accounts,
    {
      account: (a) => a.name ?? a.id,
      spend: (a) => a.spend,
      impressions: (a) => a.impressions,
      ctr: (a) => a.ctr,
      cpc: (a) => a.cpc,
    },
    "spend",
  );

  const statuses = useMemo(
    () => ["ALL", ...Array.from(new Set(detail.campaigns.map((c) => c.status)))],
    [detail],
  );
  const visibleCampaigns = useMemo(
    () => detail.campaigns.filter((c) => status === "ALL" || c.status === status),
    [detail, status],
  );

  const mutate = async (action: "add" | "remove", accountId: string) => {
    setError(null);
    const r = await onMutate(action, accountId);
    if (!r.ok) setError(r.error ?? "Update failed");
    else setNewAccount("");
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Kpi label="Spend" value={fmtCurrency(detail.kpis.spend)} />
        <Kpi label={clientResults.label} value={fmtCompact(clientResults.value)} />
        <Kpi label="Impressions" value={fmtCompact(detail.kpis.impressions)} />
        <Kpi label="CTR" value={fmtPct(detail.kpis.ctr)} />
        <Kpi label="CPC" value={fmtCurrency(detail.kpis.cpc)} />
      </div>

      {detail.budget.total != null && (
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3">Budget</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Kpi label="Total budget" value={fmtCurrency(detail.budget.total)} />
            <Kpi label="Spent" value={fmtCurrency(detail.budget.spent)} />
            <Kpi
              label="Remaining"
              value={detail.budget.remaining != null ? fmtCurrency(detail.budget.remaining) : "—"}
            />
            <Kpi label="Expected end" value={detail.budget.endDate ?? "—"} />
          </div>
          {detail.budget.total > 0 && (
            <div className="mt-3 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary"
                style={{
                  width: `${Math.min(100, Math.max(0, Math.round((detail.budget.spent / detail.budget.total) * 100)))}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center gap-3 p-4 border-b border-border">
          <h3 className="text-sm font-semibold flex-1">
            Ad accounts{" "}
            <span className="text-muted-foreground font-normal">({detail.accounts.length})</span>
          </h3>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <input
                value={newAccount}
                onChange={(e) => setNewAccount(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && newAccount.trim() && void mutate("add", newAccount)
                }
                placeholder="act_1234567890"
                className="h-8 w-44 rounded-md border border-border bg-background px-2.5 text-xs font-mono"
              />
              <button
                onClick={() => newAccount.trim() && void mutate("add", newAccount)}
                className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1"
              >
                <Plus className="size-3.5" /> Add
              </button>
            </div>
          )}
        </div>
        {error && (
          <div className="px-4 py-2 text-xs text-destructive border-b border-border">{error}</div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/30">
                <SortHeader
                  label="Account"
                  sortKey="account"
                  active={accountSort.key}
                  dir={accountSort.dir}
                  onSort={accountSort.toggle}
                />
                <th className="px-3 py-2.5 font-semibold text-left">Source</th>
                <SortHeader
                  label="Spend"
                  sortKey="spend"
                  active={accountSort.key}
                  dir={accountSort.dir}
                  onSort={accountSort.toggle}
                  align="right"
                />
                <SortHeader
                  label="Impr."
                  sortKey="impressions"
                  active={accountSort.key}
                  dir={accountSort.dir}
                  onSort={accountSort.toggle}
                  align="right"
                />
                <SortHeader
                  label="CTR"
                  sortKey="ctr"
                  active={accountSort.key}
                  dir={accountSort.dir}
                  onSort={accountSort.toggle}
                  align="right"
                />
                <SortHeader
                  label="CPC"
                  sortKey="cpc"
                  active={accountSort.key}
                  dir={accountSort.dir}
                  onSort={accountSort.toggle}
                  align="right"
                />
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {accountSort.sorted.map((a) => (
                <tr key={a.id} className="hover:bg-accent/40">
                  <td className="px-5 py-2.5">
                    <div className="font-medium">
                      {a.name ?? (
                        <span className="text-muted-foreground italic">not in BM sync</span>
                      )}
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">{a.id}</div>
                    {a.status && (
                      <div className="mt-1">
                        <StatusPill status={a.status} />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-mono uppercase",
                        a.source === "notion"
                          ? "bg-primary/10 text-primary"
                          : "bg-accent text-foreground",
                      )}
                    >
                      {a.source}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">
                    {a.hasData ? fmtCurrency(a.spend) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">
                    {a.hasData ? fmtCompact(a.impressions) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">
                    {a.hasData ? fmtPct(a.ctr) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">
                    {a.hasData ? fmtCurrency(a.cpc) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {isAdmin && (
                      <button
                        onClick={() => void mutate("remove", a.id)}
                        title="Remove from client"
                        className="size-6 rounded grid place-items-center text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {detail.accounts.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">
                    No ad accounts mapped. Add one above or fill the Notion board.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold flex-1">
            Campaigns{" "}
            <span className="text-muted-foreground font-normal">({visibleCampaigns.length})</span>
          </h3>
          {statuses.length > 1 && (
            <div className="flex rounded-md border border-border bg-card overflow-hidden text-xs">
              {statuses.map((st) => (
                <button
                  key={st}
                  onClick={() => setStatus(st)}
                  className={cn(
                    "px-2.5 h-8 font-medium font-mono uppercase text-[10px] transition-colors",
                    status === st
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {st}
                </button>
              ))}
            </div>
          )}
        </div>
        <CampaignTable campaigns={visibleCampaigns} />
      </section>

      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold">Budget &amp; Pacing</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Daily budgets &amp; recent spend pace. These campaigns run on daily budgets (no lifetime
            cap or end date in Meta), so &ldquo;remaining&rdquo; isn&rsquo;t shown.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <th className="text-left px-5 py-2.5">Campaign</th>
                <th className="text-left px-3 py-2.5">Status</th>
                <th className="text-right px-3 py-2.5">Spent</th>
                <th className="text-right px-3 py-2.5">Daily budget</th>
                <th className="text-right px-3 py-2.5">~ $/day (7d)</th>
                <th className="text-right px-5 py-2.5">Pace</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {budgets.map((b) => {
                const pace =
                  b.dailyBudget && b.dailyBudget > 0 ? b.recentDaily / b.dailyBudget : null;
                return (
                  <tr key={b.id} className="hover:bg-accent/40">
                    <td className="px-5 py-2.5 font-medium truncate max-w-[360px]">
                      {b.name ?? b.id}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[10px] uppercase text-muted-foreground">
                      {b.status ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">{fmtCurrency(b.spent)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {b.dailyBudget != null ? fmtCurrency(b.dailyBudget) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                      {fmtCurrency(b.recentDaily)}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono">
                      {pace != null ? (
                        <span
                          className={cn(
                            pace > 1.1
                              ? "text-warning"
                              : pace < 0.1
                                ? "text-muted-foreground"
                                : "text-success",
                          )}
                        >
                          {Math.round(pace * 100)}%
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
              {budgets.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-xs text-muted-foreground">
                    No campaigns.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </div>
      <div className="text-lg font-semibold font-mono mt-1">{value}</div>
    </div>
  );
}
