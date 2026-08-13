import { createFileRoute } from "@tanstack/react-router";

import { fmtCurrency, fmtNumber } from "@/lib/format";
import { CampaignTable } from "@/portal/components/CampaignTable";
import { Eyebrow, Panel, SectionHead } from "@/portal/components/bits";
import { FreshnessNote, PageIntro } from "@/portal/components/Shell";
import { pct, usd2 } from "@/portal/format";
import { campaignRows, derive, EVENT, rangeDays, totalsFor } from "@/portal/mock";
import { usePortalView } from "@/portal/state";

export const Route = createFileRoute("/portal/campaigns")({
  head: () => ({ meta: [{ title: "Campaigns — Northwind Group" }] }),
  component: Campaigns,
});

function Campaigns() {
  const { range, brand, brandLabel } = usePortalView();
  const rows = campaignRows(range, brand);
  const t = derive(totalsFor(range, brand));
  const delivering = rows.filter((r) => r.spend > 0);

  return (
    <>
      <PageIntro
        eyebrow={`${brandLabel} · last ${rangeDays(range)} days`}
        title={
          <>
            Every <span className="pf-display-em text-[color:var(--pf-gold)]">campaign</span>, in
            your words
          </>
        }
        lede="Open a campaign to see the audiences inside it. Names and statuses are the ones your account team uses with you, not the internal set-up."
      >
        <div className="pf-rise" style={{ "--d": "200ms" } as React.CSSProperties}>
          <FreshnessNote />
        </div>
      </PageIntro>

      <div className="mx-auto max-w-[1240px] space-y-4 px-4 pt-6 md:px-7">
        <div className="pf-panel grid grid-cols-2 divide-x divide-y md:grid-cols-4 md:divide-y-0">
          {[
            { k: "Campaigns delivering", v: `${delivering.length} of ${rows.length}` },
            { k: "Amount spent", v: fmtCurrency(t.spend) },
            { k: EVENT.reg, v: fmtNumber(t.regs) },
            { k: "Blended cost each", v: usd2(t.costPerReg) },
          ].map((x, i) => (
            <div
              key={x.k}
              className="pf-rise px-5 py-4 md:px-6"
              style={{ "--d": `${60 + i * 50}ms` } as React.CSSProperties}
            >
              <Eyebrow>{x.k}</Eyebrow>
              <p className="pf-num mt-1.5 text-[21px]">{x.v}</p>
            </div>
          ))}
        </div>

        <Panel delay={260}>
          <SectionHead
            eyebrow="Sorted by spend"
            title="Campaign performance"
            aside={
              <span className="text-[11.5px] text-[color:var(--pf-faint)]">
                Click rate {pct(t.ctr, 2)} across the account
              </span>
            }
          />
          <CampaignTable rows={rows} showBrand={brand === null} />
          <div className="border-t px-5 py-3 text-[11.5px] text-[color:var(--pf-faint)] md:px-6">
            A paused campaign keeps its history — figures stop moving from the day it paused. A
            scheduled campaign has no figures yet.
          </div>
        </Panel>
      </div>
    </>
  );
}
