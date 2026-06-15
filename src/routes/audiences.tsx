import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { BreakdownBar } from "@/components/dashboard/BreakdownBar";
import { getBreakdowns } from "@/lib/api/dashboard";
import { listClients } from "@/lib/api/clients";
import { fmtCurrency, fmtCompact } from "@/lib/format";
import { rangeSearch, toRange, type RangeDays } from "@/lib/range";

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
  validateSearch: (search: Record<string, unknown>): { range?: RangeDays; client?: string } => ({
    ...rangeSearch(search),
    ...(typeof search.client === "string" && search.client ? { client: search.client } : {}),
  }),
  loaderDeps: ({ search }) => ({ range: toRange(search.range), client: search.client }),
  loader: async ({ deps: { range, client } }) => {
    const [breakdowns, clients] = await Promise.all([
      getBreakdowns({ data: { days: range, clientId: client } }),
      listClients(),
    ]);
    return { breakdowns, clients, client: client ?? null };
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
  const { breakdowns, clients, client } = Route.useLoaderData();
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
              search: (prev) => ({ ...prev, client: e.target.value || undefined }),
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
