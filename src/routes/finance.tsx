import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getCurrentUser, listUsers } from "@/lib/api/auth";
import { getFinance } from "@/lib/api/finance";
import { isSuperadmin } from "@/lib/auth/roles";
import type { FinanceSummary } from "@/server/fns/finance";
import { cn } from "@/lib/utils";

const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** since/until for a preset; days=0 means all-time (no bounds). */
function rangeFor(days: number): { since?: string; until?: string } {
  if (days <= 0) return {};
  const until = new Date();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return { since: ymd(since), until: ymd(until) };
}

const PRESETS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "All", days: 0 },
];

const usd = (n: number) => `$${n.toFixed(n >= 1 ? 2 : 4)}`;

export const Route = createFileRoute("/finance")({
  head: () => ({ meta: [{ title: "Finance — MetaConsole" }] }),
  loader: async () => {
    const me = await getCurrentUser();
    if (!isSuperadmin(me?.role)) return { denied: true as const };
    const [users, initial] = await Promise.all([listUsers(), getFinance({ data: rangeFor(30) })]);
    return {
      denied: false as const,
      users: "error" in users ? [] : users.users,
      initial: "error" in initial ? null : initial,
    };
  },
  component: Finance,
});

type SortKey = "cost" | "calls" | "conversations" | "avg" | "email";

function Finance() {
  const data = Route.useLoaderData();
  if (data.denied) {
    return (
      <div className="p-6 md:p-8">
        <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          This page is restricted to superadmins.
        </div>
      </div>
    );
  }
  return <FinanceView users={data.users} initial={data.initial} />;
}

function FinanceView({
  users,
  initial,
}: {
  users: { id: string; email: string; name: string | null }[];
  initial: FinanceSummary | null;
}) {
  const [summary, setSummary] = useState<FinanceSummary | null>(initial);
  const [days, setDays] = useState(30);
  const [selected, setSelected] = useState<Set<string>>(new Set(users.map((u) => u.id)));
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("cost");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const load = async (d: number, sel: Set<string>) => {
    setLoading(true);
    const r = rangeFor(d);
    // none or all selected => no user filter (show everyone)
    const userIds = sel.size === 0 || sel.size === users.length ? undefined : [...sel];
    const res = await getFinance({ data: { ...r, userIds } });
    if (!("error" in res)) setSummary(res);
    setLoading(false);
  };

  const pickDays = (d: number) => {
    setDays(d);
    void load(d, selected);
  };
  const toggleUser = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    void load(days, next);
  };
  const allUsers = () => {
    const next = new Set(users.map((u) => u.id));
    setSelected(next);
    void load(days, next);
  };
  const noUsers = () => {
    const next = new Set<string>();
    setSelected(next);
    void load(days, next);
  };

  const sortBy = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir(k === "email" ? "asc" : "desc");
    }
  };

  const rows = [...(summary?.perUser ?? [])].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    const av =
      sortKey === "avg" ? (a.calls ? a.cost / a.calls : 0) : sortKey === "email" ? 0 : a[sortKey];
    const bv =
      sortKey === "avg" ? (b.calls ? b.cost / b.calls : 0) : sortKey === "email" ? 0 : b[sortKey];
    if (sortKey === "email") return a.email.localeCompare(b.email) * dir;
    return ((av as number) - (bv as number)) * dir;
  });

  const maxDaily = Math.max(1, ...(summary?.daily ?? []).map((d) => d.cost));
  const rangeLabel = days === 0 ? "all time" : `last ${days} days`;

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1100px]">
      <PageHeader
        title="Finance"
        description="Total Claude API spend across the assistant, by user and by day. Superadmin only."
      />

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => pickDays(p.days)}
              className={cn(
                "h-7 px-3 rounded-md text-xs font-medium transition-colors",
                days === p.days
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        {loading && <span className="text-xs text-muted-foreground">Loading…</span>}
      </div>

      {/* User filter */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Users ({selected.size === 0 ? "all" : `${selected.size}/${users.length}`})
          </span>
          <div className="space-x-1.5">
            <button
              onClick={allUsers}
              className="h-6 px-2 rounded border border-border text-[11px] hover:bg-accent"
            >
              All
            </button>
            <button
              onClick={noUsers}
              className="h-6 px-2 rounded border border-border text-[11px] hover:bg-accent"
            >
              None
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {users.map((u) => {
            const on = selected.has(u.id);
            return (
              <button
                key={u.id}
                onClick={() => toggleUser(u.id)}
                className={cn(
                  "h-7 px-2.5 rounded-full text-[11px] font-medium border transition-colors",
                  on
                    ? "bg-primary/10 border-primary/40 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
                title={u.email}
              >
                {u.name || u.email}
              </button>
            );
          })}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label={`Total cost · ${rangeLabel}`} value={usd(summary?.total ?? 0)} accent />
        <Stat label="Billed calls" value={(summary?.calls ?? 0).toLocaleString()} />
        <Stat label="Conversations" value={(summary?.conversations ?? 0).toLocaleString()} />
        <Stat
          label="Avg / call"
          value={usd(summary && summary.calls ? summary.total / summary.calls : 0)}
        />
      </div>

      {/* Per-user table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
              <SortTh label="User" k="email" cur={sortKey} dir={sortDir} onClick={sortBy} left />
              <SortTh label="Cost" k="cost" cur={sortKey} dir={sortDir} onClick={sortBy} />
              <SortTh label="Calls" k="calls" cur={sortKey} dir={sortDir} onClick={sortBy} />
              <SortTh
                label="Conversations"
                k="conversations"
                cur={sortKey}
                dir={sortDir}
                onClick={sortBy}
              />
              <SortTh label="Avg / call" k="avg" cur={sortKey} dir={sortDir} onClick={sortBy} />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-xs text-muted-foreground">
                  No Claude API cost recorded for this selection.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.userId} className="hover:bg-accent/40">
                  <td className="px-5 py-2.5">
                    <div className="font-medium">{r.name || "—"}</div>
                    <div className="text-[11px] text-muted-foreground font-mono">{r.email}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono font-semibold">{usd(r.cost)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                    {r.calls.toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                    {r.conversations.toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                    {usd(r.calls ? r.cost / r.calls : 0)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Daily trend */}
      {summary && summary.daily.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-3">Daily cost</h3>
          <div className="rounded-xl border border-border bg-card p-4 space-y-1.5">
            {summary.daily.map((d) => (
              <div key={d.date} className="flex items-center gap-3 text-xs">
                <span className="font-mono text-muted-foreground w-24 shrink-0">{d.date}</span>
                <div className="flex-1 h-4 rounded bg-muted/40 overflow-hidden">
                  <div
                    className="h-full bg-primary/70"
                    style={{ width: `${(d.cost / maxDaily) * 100}%` }}
                  />
                </div>
                <span className="font-mono w-20 text-right shrink-0">{usd(d.cost)}</span>
                <span className="font-mono w-14 text-right text-muted-foreground shrink-0">
                  {d.calls}×
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </div>
      <div className={cn("mt-1 text-2xl font-semibold font-mono", accent && "text-primary")}>
        {value}
      </div>
    </div>
  );
}

function SortTh({
  label,
  k,
  cur,
  dir,
  onClick,
  left,
}: {
  label: string;
  k: SortKey;
  cur: SortKey;
  dir: "asc" | "desc";
  onClick: (k: SortKey) => void;
  left?: boolean;
}) {
  return (
    <th className={cn("px-3 py-2.5", left ? "text-left px-5" : "text-right")}>
      <button
        onClick={() => onClick(k)}
        className="inline-flex items-center gap-1 hover:text-foreground uppercase"
      >
        {label}
        <span className="text-[8px]">{cur === k ? (dir === "desc" ? "▼" : "▲") : "↕"}</span>
      </button>
    </th>
  );
}
