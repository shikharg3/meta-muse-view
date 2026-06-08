import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { BreakdownBar } from "@/components/dashboard/BreakdownBar";
import {
  ageBreakdown, genderBreakdown, placementBreakdown,
  deviceBreakdown, countryBreakdown, fmtCurrency, fmtCompact,
} from "@/lib/mock-data";

export const Route = createFileRoute("/audiences")({
  head: () => ({
    meta: [
      { title: "Audiences — MetaConsole" },
      { name: "description", content: "Audience and placement breakdowns across the Business Manager." },
    ],
  }),
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
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Audience &amp; Placement Insights"
        description="Where spend goes and where conversions come from."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Age Distribution — Spend">
          <BreakdownBar rows={ageBreakdown} valueKey="spend" format={fmtCurrency} />
        </Panel>
        <Panel title="Age Distribution — Conversions">
          <BreakdownBar rows={ageBreakdown} valueKey="conversions" format={fmtCompact} />
        </Panel>
        <Panel title="Gender Split — Spend">
          <BreakdownBar rows={genderBreakdown} valueKey="spend" format={fmtCurrency} />
        </Panel>
        <Panel title="Device — Spend">
          <BreakdownBar rows={deviceBreakdown} valueKey="spend" format={fmtCurrency} />
        </Panel>
        <Panel title="Placement — Spend">
          <BreakdownBar rows={placementBreakdown} valueKey="spend" format={fmtCurrency} />
        </Panel>
        <Panel title="Top Countries — Spend">
          <BreakdownBar rows={countryBreakdown} valueKey="spend" format={fmtCurrency} />
        </Panel>
      </div>
    </div>
  );
}
