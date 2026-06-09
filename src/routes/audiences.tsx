import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { BreakdownBar } from "@/components/dashboard/BreakdownBar";
import { getBreakdowns } from "@/lib/api/dashboard";
import { fmtCurrency, fmtCompact } from "@/lib/format";
import { rangeSearch, toRange } from "@/lib/range";

export const Route = createFileRoute("/audiences")({
  head: () => ({
    meta: [
      { title: "Audiences — MetaConsole" },
      { name: "description", content: "Audience and placement breakdowns across the Business Manager." },
    ],
  }),
  validateSearch: rangeSearch,
  loaderDeps: ({ search }) => ({ range: toRange(search.range) }),
  loader: async ({ deps: { range } }) => await getBreakdowns({ data: range }),
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
  const breakdowns = Route.useLoaderData();
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Audience &amp; Placement Insights"
        description="Where spend goes and where conversions come from."
      />

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
          <BreakdownBar rows={breakdowns.publisher_platform} valueKey="spend" format={fmtCurrency} />
        </Panel>
        <Panel title="Top Countries — Spend">
          <BreakdownBar rows={breakdowns.country} valueKey="spend" format={fmtCurrency} />
        </Panel>
      </div>
    </div>
  );
}
