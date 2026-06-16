import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { BreakdownBar } from "@/components/dashboard/BreakdownBar";
import { getBreakdowns, getCampaignOptions } from "@/lib/api/dashboard";
import { listClients } from "@/lib/api/clients";
import { fmtCurrency, fmtCompact } from "@/lib/format";
import { rangeSearch, accountScope, rangeSpec, type RangeDays } from "@/lib/range";

export const Route = createFileRoute("/audiences")({
  head: () => ({
    meta: [
      { title: "Audiences — MetaConsole" },
      {
        name: "description",
        content: "Audience and placement breakdowns across the Business Manager.",
      },
    ],
  }),
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    range?: RangeDays;
    from?: string;
    to?: string;
    client?: string;
    campaign?: string;
    accounts?: string;
  } => ({
    ...rangeSearch(search),
    ...(typeof search.client === "string" && search.client ? { client: search.client } : {}),
    ...(typeof search.campaign === "string" && search.campaign
      ? { campaign: search.campaign }
      : {}),
    ...(typeof search.accounts === "string" && search.accounts
      ? { accounts: search.accounts }
      : {}),
  }),
  loaderDeps: ({ search }) => ({
    ...rangeSpec(search),
    client: search.client,
    campaign: search.campaign,
    accounts: search.accounts,
  }),
  loader: async ({ deps: { days, from, to, client, campaign, accounts } }) => {
    // Page-local client/campaign override the global header account scope.
    const accountIds = client || campaign ? undefined : [...accountScope(accounts)];
    const [breakdowns, clients, campaigns] = await Promise.all([
      getBreakdowns({
        data: { days, from, to, clientId: client, campaignId: campaign, accountIds },
      }),
      listClients(),
      client ? getCampaignOptions({ data: { clientId: client } }) : Promise.resolve([]),
    ]);
    return {
      breakdowns,
      clients,
      campaigns,
      client: client ?? null,
      campaign: campaign ?? null,
    };
  },
  component: Audiences,
});

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold mb-4">{title}</h3>
      {children}
    </div>
  );
}

function Audiences() {
  const { breakdowns, clients, campaigns, client, campaign } = Route.useLoaderData();
  const navigate = useNavigate();
  const sorted = [...clients].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Audience &amp; Placement Insights"
        description="Where spend goes and where conversions come from."
      />

      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Client</span>
        <select
          value={client ?? ""}
          onChange={(e) =>
            navigate({
              to: ".",
              search: (prev) => ({
                ...prev,
                client: e.target.value || undefined,
                campaign: undefined,
              }),
            })
          }
          className="h-9 rounded-md border border-border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="">All clients</option>
          {sorted.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {client && (
          <>
            <span className="ml-2 text-xs font-medium text-muted-foreground">Campaign</span>
            <select
              value={campaign ?? ""}
              onChange={(e) =>
                navigate({
                  to: ".",
                  search: (prev) => ({ ...prev, campaign: e.target.value || undefined }),
                })
              }
              className="h-9 max-w-[280px] rounded-md border border-border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? c.id}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Age Distribution — Spend">
          <BreakdownBar rows={breakdowns.age} valueKey="spend" format={fmtCurrency} />
        </Panel>
        <Panel title="Age Distribution — Conversions">
          <BreakdownBar rows={breakdowns.age} valueKey="conversions" format={fmtCompact} />
        </Panel>
        <Panel title="Gender Split — Spend">
          <BreakdownBar rows={breakdowns.gender} valueKey="spend" format={fmtCurrency} />
        </Panel>
        <Panel title="Device — Spend">
          <BreakdownBar rows={breakdowns.device_platform} valueKey="spend" format={fmtCurrency} />
        </Panel>
        <Panel title="Placement — Spend">
          <BreakdownBar
            rows={breakdowns.publisher_platform}
            valueKey="spend"
            format={fmtCurrency}
          />
        </Panel>
        <Panel title="Top Countries — Spend">
          <BreakdownBar rows={breakdowns.country} valueKey="spend" format={fmtCurrency} />
        </Panel>
      </div>
    </div>
  );
}
