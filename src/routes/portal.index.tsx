import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Quote } from "lucide-react";

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
import {
  ACCOUNT_NOTE,
  campaignRows,
  derive,
  EVENT,
  pacingFor,
  rangeDays,
  totalsFor,
} from "@/portal/mock";
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

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <PacingPanel pacing={pacingFor(brand)} delay={300} />
          </div>
          <AccountNote delay={340} />
        </div>

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

/**
 * The account team's read on the period. Without this the portal is a data dump — this is where the
 * account manager explains the dip a client would otherwise email about.
 */
function AccountNote({ delay }: { delay: number }) {
  return (
    <Panel delay={delay} className="flex flex-col">
      <SectionHead eyebrow="From your account team" title="What happened, and why" />
      <div className="flex-1 px-5 pb-5 md:px-6">
        <Quote className="mb-2 size-4 text-[color:var(--pf-gold)]" />
        <p className="text-[13px] leading-[1.72] text-[color:var(--pf-dim)]">{ACCOUNT_NOTE.body}</p>
      </div>
      <div className="flex items-center gap-3 border-t px-5 py-3.5 md:px-6">
        <span
          className="pf-num grid size-8 place-items-center rounded-full text-[11px] font-semibold"
          style={{ color: "oklch(0.2 0.02 80)", background: "var(--pf-gold)" }}
        >
          PR
        </span>
        <div className="leading-tight">
          <p className="text-[12.5px] font-semibold">{ACCOUNT_NOTE.author}</p>
          <p className="text-[11px] text-[color:var(--pf-faint)]">{ACCOUNT_NOTE.role}</p>
        </div>
      </div>
    </Panel>
  );
}
