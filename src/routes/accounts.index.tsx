import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { StatusPill } from "@/components/dashboard/StatusPill";
import { Sparkline } from "@/components/dashboard/Sparkline";
import { listAccounts } from "@/lib/api/dashboard";
import { fmtCurrency, fmtCompact, fmtPct, fmtRelTime } from "@/lib/format";
import { ArrowUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { scopedSearch, accountScope, rangeSpec } from "@/lib/range";
import { sortByKey } from "@/lib/sort";
import { downloadCsvRows } from "@/lib/download";

export const Route = createFileRoute("/accounts/")({
  head: () => ({
    meta: [
      { title: "Ad Accounts — MetaConsole" },
      {
        name: "description",
        content: "All ad accounts under the Business Manager with key performance metrics.",
      },
    ],
  }),
  validateSearch: scopedSearch,
  loaderDeps: ({ search }) => rangeSpec(search),
  loader: async ({ deps }) => ({ accounts: await listAccounts({ data: deps }) }),
  component: Accounts,
});

type SortKey =
  | "name"
  | "spend"
  | "results"
  | "ctr"
  | "cpm"
  | "conversions"
  | "status"
  | "disabledSince";

function Accounts() {
  const { accounts } = Route.useLoaderData();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("spend");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [status, setStatus] = useState<string>("ALL");
  const [copied, setCopied] = useState(false);
  const scopeParam = Route.useSearch().accounts ?? "";

  const filtered = useMemo(() => {
    const scope = accountScope(scopeParam);
    const list = accounts.filter(
      (a) =>
        (scope.size === 0 || scope.has(a.id)) &&
        (status === "ALL" || a.status === status) &&
        (q.trim() === "" || a.name.toLowerCase().includes(q.toLowerCase()) || a.id.includes(q)),
    );
    return sortByKey(list, sort, dir);
  }, [accounts, q, sort, dir, status, scopeParam]);

  const toggle = (k: SortKey) => {
    if (sort === k) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(k);
      setDir("desc");
    }
  };

  // Export/copy act on the FILTERED rows, so the status filter doubles as the selector for BM work:
  // DISABLED -> the prune list, ACTIVE -> the list to share into a business manager.
  const bareIds = () => filtered.map((a) => a.id.replace(/^act_/, ""));
  const exportCsv = () => {
    downloadCsvRows(
      [
        [
          "account_id",
          "name",
          "status",
          "disabled_since",
          "disable_reason",
          "spend",
          "conversions",
        ],
        ...filtered.map((a) => [
          a.id.replace(/^act_/, ""),
          a.name,
          a.status,
          a.disabledSince ?? "",
          a.disableReason ?? "",
          a.spend.toFixed(2),
          String(a.conversions),
        ]),
      ],
      `ad-accounts-${status.toLowerCase()}-${filtered.length}.csv`,
    );
  };
  const copyIds = async () => {
    await navigator.clipboard.writeText(bareIds().join(","));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Ad Accounts"
        description={`${accounts.length} accounts under Vantage Media Group.`}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search accounts…"
            className="w-full h-9 rounded-md border border-border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex rounded-md border border-border bg-card overflow-hidden text-xs">
          {["ALL", "ACTIVE", "PAUSED", "PENDING", "DISABLED"].map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={cn(
                "px-3 h-9 font-medium transition-colors",
                status === s
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="h-9 px-3 rounded-md border border-border bg-card text-xs font-medium hover:bg-accent disabled:opacity-50"
          title="Download the filtered accounts as CSV"
        >
          Export CSV
        </button>
        <button
          onClick={() => void copyIds()}
          disabled={filtered.length === 0}
          className="h-9 px-3 rounded-md border border-border bg-card text-xs font-medium hover:bg-accent disabled:opacity-50"
          title="Copy the filtered account IDs (comma-separated) for Business Manager bulk actions"
        >
          {copied ? `Copied ${filtered.length}` : "Copy IDs"}
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30">
                <Th
                  label="Account"
                  sortable
                  onClick={() => toggle("name")}
                  active={sort === "name"}
                  dir={dir}
                />
                <Th
                  label="Status"
                  sortable
                  onClick={() => toggle("status")}
                  active={sort === "status"}
                  dir={dir}
                />
                <Th
                  label="Disabled"
                  sortable
                  onClick={() => toggle("disabledSince")}
                  active={sort === "disabledSince"}
                  dir={dir}
                />
                <Th
                  label="Spend"
                  align="right"
                  sortable
                  onClick={() => toggle("spend")}
                  active={sort === "spend"}
                  dir={dir}
                />
                <Th
                  label="Results"
                  align="right"
                  sortable
                  onClick={() => toggle("results")}
                  active={sort === "results"}
                  dir={dir}
                />
                <Th
                  label="CTR"
                  align="right"
                  sortable
                  onClick={() => toggle("ctr")}
                  active={sort === "ctr"}
                  dir={dir}
                />
                <Th
                  label="CPM"
                  align="right"
                  sortable
                  onClick={() => toggle("cpm")}
                  active={sort === "cpm"}
                  dir={dir}
                />
                <Th
                  label="Conv."
                  align="right"
                  sortable
                  onClick={() => toggle("conversions")}
                  active={sort === "conversions"}
                  dir={dir}
                />
                <Th label="Cost/Conv" align="right" />
                <Th label="Reach" align="right" />
                <Th label="14d trend" align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((a) => (
                <tr key={a.id} className="hover:bg-accent/40 transition-colors">
                  <td className="px-5 py-3">
                    <Link
                      to="/accounts/$id"
                      params={{ id: a.id }}
                      className="font-medium hover:text-primary"
                    >
                      {a.name}
                    </Link>
                    <div className="font-mono text-[10px] text-muted-foreground">{a.id}</div>
                    {a.lastChecked && (
                      <div className="text-[10px] text-muted-foreground">
                        checked {fmtRelTime(a.lastChecked)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <StatusPill status={a.status} />
                  </td>
                  <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground">
                    {a.disabledSince ? (
                      <span className="text-amber-500" title={a.disableReason ?? undefined}>
                        {a.disabledSince}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{fmtCurrency(a.spend)}</td>
                  <td className="px-3 py-3 text-right font-mono">
                    {fmtCompact(a.results)}{" "}
                    <span className="text-muted-foreground text-[10px]">
                      {a.resultLabel.toLowerCase()}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                    {fmtPct(a.ctr)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                    {fmtCurrency(a.cpm)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{fmtCompact(a.conversions)}</td>
                  <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                    {a.conversions > 0 ? fmtCurrency(a.spend / a.conversions) : "—"}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-muted-foreground">
                    {fmtCompact(a.reach)}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end">
                      <Sparkline data={a.spark} />
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-5 py-12 text-center text-sm text-muted-foreground">
                    No accounts match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-border text-[11px] text-muted-foreground font-mono">
          {filtered.length} of {accounts.length} accounts
        </div>
      </div>
    </div>
  );
}

function Th({
  label,
  sortable,
  onClick,
  active,
  dir,
  align = "left",
}: {
  label: string;
  sortable?: boolean;
  onClick?: () => void;
  active?: boolean;
  dir?: "asc" | "desc";
  align?: "left" | "right";
}) {
  return (
    <th className={cn("px-3 first:pl-5 last:pr-5 py-2.5", align === "right" && "text-right")}>
      {sortable ? (
        <button
          onClick={onClick}
          className={cn(
            "inline-flex items-center gap-1 hover:text-foreground",
            active && "text-foreground",
          )}
        >
          {label} <ArrowUpDown className={cn("size-3 opacity-50", active && "opacity-100")} />
        </button>
      ) : (
        label
      )}
    </th>
  );
}
