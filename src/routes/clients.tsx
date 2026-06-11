import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getClientDetail, listClients, mutateClientAccounts } from "@/lib/api/clients";
import { fmtCurrency, fmtPct, fmtCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Briefcase, ChevronDown, Plus, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { rangeSearch, toRange, type RangeDays } from "@/lib/range";

type ClientSearch = { client?: string; range?: RangeDays };

export const Route = createFileRoute("/clients")({
  head: () => ({ meta: [{ title: "Clients — MetaConsole" }] }),
  validateSearch: (s: Record<string, unknown>): ClientSearch => ({
    ...rangeSearch(s),
    client: typeof s.client === "string" ? s.client : undefined,
  }),
  loaderDeps: ({ search }) => ({ range: toRange(search.range), client: search.client }),
  loader: async ({ deps }) => {
    const clients = await listClients();
    const selected = deps.client ?? clients[0]?.id;
    const detail = selected
      ? await getClientDetail({ data: { id: selected, days: deps.range } })
      : null;
    return { clients, detail };
  },
  component: Clients,
});

const STATUS_TONE: Record<string, string> = {
  Live: "text-success",
  Paused: "text-warning",
  "On Boarding": "text-primary",
};

function Clients() {
  const { clients, detail } = Route.useLoaderData();
  const navigate = useNavigate({ from: "/clients" });
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [newAccount, setNewAccount] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutate = async (action: "add" | "remove", accountId: string) => {
    if (!detail) return;
    setError(null);
    const r = await mutateClientAccounts({ data: { id: detail.id, action, accountId } });
    if (!r.ok) setError(r.error ?? "Update failed");
    else setNewAccount("");
    await router.invalidate();
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1400px]">
      <PageHeader
        title="Clients"
        description="Per-client performance across every ad account they've ever used, synced from Notion."
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button className="flex items-center gap-2 rounded-md border border-border bg-card hover:bg-accent px-3 h-9 text-xs transition-colors">
              <Briefcase className="size-3.5 text-muted-foreground" />
              <span className="font-medium">{detail?.name ?? "Select client"}</span>
              {detail?.status && (
                <span
                  className={cn(
                    "font-mono text-[10px]",
                    STATUS_TONE[detail.status] ?? "text-muted-foreground",
                  )}
                >
                  {detail.status}
                </span>
              )}
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="p-0 w-80">
            <Command>
              <CommandInput placeholder="Search clients…" className="text-xs" />
              <CommandList>
                <CommandEmpty>No clients. Configure Notion in Settings.</CommandEmpty>
                <CommandGroup>
                  {clients.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={c.name}
                      className="text-xs gap-2"
                      onSelect={() => {
                        setOpen(false);
                        navigate({ search: (s) => ({ ...s, client: c.id }) });
                      }}
                    >
                      <span className="truncate">{c.name}</span>
                      <span
                        className={cn(
                          "ml-auto font-mono text-[10px]",
                          STATUS_TONE[c.status ?? ""] ?? "text-muted-foreground",
                        )}
                      >
                        {c.status ?? "—"} · {c.accountCount}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </PageHeader>

      {!detail ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          No clients synced yet — add the Notion token and board in Settings, then run a sync.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <Kpi label="Spend" value={fmtCurrency(detail.kpis.spend)} />
            <Kpi label="Impressions" value={fmtCompact(detail.kpis.impressions)} />
            <Kpi label="Clicks" value={fmtCompact(detail.kpis.clicks)} />
            <Kpi label="CTR" value={fmtPct(detail.kpis.ctr)} />
            <Kpi label="CPC" value={fmtCurrency(detail.kpis.cpc)} />
          </div>

          <section className="rounded-xl border border-border bg-card">
            <div className="flex items-center gap-3 p-4 border-b border-border">
              <h3 className="text-sm font-semibold flex-1">
                Ad accounts{" "}
                <span className="text-muted-foreground font-normal">
                  ({detail.accounts.length})
                </span>
              </h3>
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
            </div>
            {error && (
              <div className="px-4 py-2 text-xs text-destructive border-b border-border">
                {error}
              </div>
            )}
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2.5 font-semibold">Account</th>
                  <th className="px-4 py-2.5 font-semibold">Source</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Spend</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Impressions</th>
                  <th className="px-4 py-2.5 font-semibold text-right">CTR</th>
                  <th className="px-4 py-2.5 font-semibold text-right">CPC</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {detail.accounts.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="px-4 py-2.5">
                      <div className="font-medium">
                        {a.name ?? (
                          <span className="text-muted-foreground italic">not in BM sync</span>
                        )}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground">{a.id}</div>
                    </td>
                    <td className="px-4 py-2.5">
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
                    <td className="px-4 py-2.5 text-right font-mono">
                      {a.hasData ? fmtCurrency(a.spend) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {a.hasData ? fmtCompact(a.impressions) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {a.hasData ? fmtPct(a.ctr) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {a.hasData ? fmtCurrency(a.cpc) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => void mutate("remove", a.id)}
                        title="Remove from client"
                        className="size-6 rounded grid place-items-center text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      >
                        <X className="size-3.5" />
                      </button>
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
          </section>

          <section className="rounded-xl border border-border bg-card">
            <div className="p-4 border-b border-border">
              <h3 className="text-sm font-semibold">
                Campaigns{" "}
                <span className="text-muted-foreground font-normal">
                  ({detail.campaigns.length})
                </span>
              </h3>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2.5 font-semibold">Campaign</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Spend</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Impressions</th>
                  <th className="px-4 py-2.5 font-semibold text-right">CTR</th>
                  <th className="px-4 py-2.5 font-semibold text-right">CPC</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Results</th>
                </tr>
              </thead>
              <tbody>
                {detail.campaigns.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-4 py-2.5">
                      <div className="font-medium truncate max-w-md">{c.name}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {c.accountId}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">{c.status ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmtCurrency(c.spend)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {fmtCompact(c.impressions)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmtPct(c.ctr)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmtCurrency(c.cpc)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {fmtCompact(c.results)}{" "}
                      <span className="text-muted-foreground">{c.resultLabel.toLowerCase()}</span>
                    </td>
                  </tr>
                ))}
                {detail.campaigns.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">
                      No synced campaigns for these accounts (old accounts have no data).
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
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
