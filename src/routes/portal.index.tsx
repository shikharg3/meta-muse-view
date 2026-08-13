import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { fmtCurrency, fmtNumber } from "@/lib/format";
import { CampaignTable } from "@/portal/components/CampaignTable";
import { Panel, SectionHead } from "@/portal/components/bits";
import {
  BreakdownPanel,
  FunnelPanel,
  HeadlineMetrics,
  PacingPanel,
  TrendPanel,
} from "@/portal/components/panels";
import { FreshnessNote, PageIntro } from "@/portal/components/Shell";
import { usd2 } from "@/portal/format";
import { campaignRows, derive, EVENT, pacingFor, rangeDays, totalsFor } from "@/portal/mock";
import { usePortalView } from "@/portal/state";

export const Route = createFileRoute("/portal/")({
  head: () => ({ meta: [{ title: "Overview — Northwind Group" }] }),
  component: Overview,
});

function Overview() {
  const { range, brand, brandLabel } = usePortalView();
  const t = derive(totalsFor(range, brand));
  const rows = campaignRows(range, brand);
  const live = rows.filter((r) => r.status === "running").length;

  return (
    <>
      <PageIntro
        eyebrow={`${brandLabel} · performance report`}
        title={
          <>
            Your last{" "}
            <span className="pf-display-em text-[color:var(--pf-gold)]">
              {rangeDays(range)} days
            </span>
          </>
        }
        lede={`${fmtCurrency(t.spend)} invested across ${live} live campaign${live === 1 ? "" : "s"}, returning ${fmtNumber(t.regs)} ${EVENT.reg.toLowerCase()} at ${usd2(t.costPerReg)} each and ${fmtNumber(t.deposits)} ${EVENT.dep.toLowerCase()}.`}
      >
        <div className="pf-rise" style={{ "--d": "220ms" } as React.CSSProperties}>
          <FreshnessNote />
        </div>
      </PageIntro>

      <div className="mx-auto max-w-[1240px] space-y-4 px-4 pt-6 md:px-7">
        <HeadlineMetrics range={range} brand={brand} />

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <TrendPanel range={range} brand={brand} delay={200} />
          </div>
          <FunnelPanel range={range} brand={brand} delay={260} />
        </div>

        <PacingPanel pacing={pacingFor(brand)} delay={300} />

        <BreakdownPanel range={range} brand={brand} delay={380} />

        <Panel delay={420}>
          <SectionHead
            eyebrow="Biggest movers"
            title="Top campaigns"
            aside={
              <Link
                to="/portal/campaigns"
                className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[color:var(--pf-gold)] hover:gap-2.5"
              >
                All {rows.length} campaigns <ArrowRight className="size-3.5" />
              </Link>
            }
          />
          <CampaignTable rows={rows.slice(0, 5)} showBrand={brand === null} />
        </Panel>
      </div>
    </>
  );
}
