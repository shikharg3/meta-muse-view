import { createFileRoute } from "@tanstack/react-router";
import { Download, FileText, Table2 } from "lucide-react";
import { useState } from "react";

import { fmtCurrency, fmtNumber } from "@/lib/format";
import type { ReportColumnKind } from "@/lib/report-catalog";
import { downloadReportCsv, downloadReportPdf, type ReportDoc } from "@/lib/report-export";
import { Eyebrow, Panel, SectionHead, Segmented } from "@/portal/components/bits";
import { PageIntro } from "@/portal/components/Shell";
import { pct, usd2 } from "@/portal/format";
import {
  campaignRows,
  CLIENT,
  derive,
  dimensionTotals,
  DIMENSIONS,
  EVENT,
  FRESHNESS,
  longDay,
  rangeDays,
  seriesFor,
  shortDay,
  totalsFor,
  windowFor,
  type BrandFilter,
  type Derived,
  type Dimension,
  type RangeKey,
} from "@/portal/mock";
import { usePortalView } from "@/portal/state";

export const Route = createFileRoute("/portal/reports")({
  head: () => ({ meta: [{ title: "Reports — Northwind Group" }] }),
  component: Reports,
});

// ------------------------------------------------------------------ report shape

type Group = "total" | "day" | "campaign" | Dimension;

const GROUPS: { value: Group; label: string }[] = [
  { value: "total", label: "One total" },
  { value: "day", label: "Day" },
  { value: "campaign", label: "Campaign" },
  ...DIMENSIONS.map((d) => ({ value: d.key as Group, label: d.label })),
];

interface Col {
  key: string;
  label: string;
  kind: ReportColumnKind;
  /** Display form for the on-screen preview. */
  show: (d: Derived) => string;
  /** Raw number, which the exporter formats for CSV cells and draws as chart bars. */
  num: (d: Derived) => number;
}

const COLS: Col[] = [
  {
    key: "spend",
    label: "Spend",
    kind: "money",
    show: (d) => fmtCurrency(d.spend),
    num: (d) => d.spend,
  },
  {
    key: "impressions",
    label: "Views",
    kind: "int",
    show: (d) => fmtNumber(d.impressions),
    num: (d) => d.impressions,
  },
  {
    key: "clicks",
    label: "Clicks",
    kind: "int",
    show: (d) => fmtNumber(d.clicks),
    num: (d) => d.clicks,
  },
  {
    key: "ctr",
    label: "Click rate",
    kind: "pct",
    show: (d) => pct(d.ctr, 2),
    num: (d) => d.ctr,
  },
  {
    key: "regs",
    label: EVENT.reg,
    kind: "int",
    show: (d) => fmtNumber(d.regs),
    num: (d) => d.regs,
  },
  {
    key: "costPerReg",
    label: `Cost per ${EVENT.reg.toLowerCase().replace(/s$/, "")}`,
    kind: "money",
    show: (d) => (d.regs ? usd2(d.costPerReg) : "—"),
    num: (d) => d.costPerReg,
  },
  {
    key: "deposits",
    label: EVENT.dep,
    kind: "int",
    show: (d) => fmtNumber(d.deposits),
    num: (d) => d.deposits,
  },
  {
    key: "costPerDep",
    label: `Cost per ${EVENT.dep.toLowerCase().replace(/s$/, "")}`,
    kind: "money",
    show: (d) => (d.deposits ? usd2(d.costPerDep) : "—"),
    num: (d) => d.costPerDep,
  },
];
const DEFAULT_COLS = ["spend", "impressions", "clicks", "ctr", "regs", "costPerReg"];

interface Row {
  label: string;
  d: Derived;
}

function buildRows(group: Group, range: RangeKey, brand: BrandFilter): Row[] {
  if (group === "total") return [{ label: "All campaigns", d: derive(totalsFor(range, brand)) }];
  if (group === "day")
    return seriesFor(range, brand).map((r) => ({ label: shortDay(r.date), d: derive(r) }));
  if (group === "campaign")
    return campaignRows(range, brand)
      .filter((c) => c.spend > 0)
      .map((c) => ({ label: c.name, d: c }));
  return dimensionTotals(range, brand, group).map((s) => ({ label: s.label, d: derive(s.totals) }));
}

// ------------------------------------------------------------------ page

function Reports() {
  const { range, brand, brandLabel } = usePortalView();
  const [group, setGroup] = useState<Group>("day");
  const [picked, setPicked] = useState<string[]>(DEFAULT_COLS);

  const cols = COLS.filter((c) => picked.includes(c.key));
  const rows = buildRows(group, range, brand);
  const totals = derive(totalsFor(range, brand));
  const win = windowFor(range);
  const groupLabel = GROUPS.find((g) => g.value === group)!.label;
  const title = `${CLIENT.name} — ${brandLabel} — performance by ${groupLabel.toLowerCase()}`;
  const subtitle = `${longDay(win.since)} to ${longDay(win.until)} · ${FRESHNESS.attribution} · reported in USD`;
  const filename = `${brandLabel.toLowerCase().replace(/\s+/g, "-")}-${group}-${win.since}-to-${win.until}`;

  const doc = (): ReportDoc => ({
    title,
    subtitle,
    columns: [
      { key: "_dim", label: groupLabel, kind: "text" },
      ...cols.map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
    ],
    rows: rows.map((r) => [r.label, ...cols.map((c) => c.num(r.d))]),
    totals: ["Total", ...cols.map((c) => c.num(totals))],
    filename,
  });

  return (
    <>
      <PageIntro
        eyebrow={`${brandLabel} · self-serve export`}
        title={
          <>
            Build your own <span className="pf-display-em text-[color:var(--pf-gold)]">report</span>
          </>
        }
        lede="Pick how the rows are grouped and which columns you need, then take it as a spreadsheet or a PDF. No need to ask us for it."
      />

      <div className="mx-auto max-w-[1240px] space-y-4 px-4 pt-6 md:px-7">
        <Panel delay={120}>
          <SectionHead eyebrow={`Last ${rangeDays(range)} days`} title="Report settings" />
          <div className="space-y-5 px-5 pb-5 md:px-6">
            <div>
              <Eyebrow className="mb-2">Group rows by</Eyebrow>
              <div className="flex flex-wrap gap-1.5">
                <Segmented
                  label="Group rows by"
                  value={group}
                  onChange={setGroup}
                  options={GROUPS}
                />
              </div>
            </div>
            <div>
              <Eyebrow className="mb-2">Columns</Eyebrow>
              <div className="flex flex-wrap gap-1.5">
                {COLS.map((c) => {
                  const on = picked.includes(c.key);
                  return (
                    <button
                      key={c.key}
                      type="button"
                      className="pf-chip"
                      data-on={on}
                      aria-pressed={on}
                      onClick={() =>
                        setPicked((p) => (on ? p.filter((k) => k !== c.key) : [...p, c.key]))
                      }
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Panel>

        <Panel delay={180}>
          <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-4 pb-3 md:px-6">
            <div className="min-w-0">
              <Eyebrow>
                {rows.length} row{rows.length === 1 ? "" : "s"} · {cols.length} column
                {cols.length === 1 ? "" : "s"}
              </Eyebrow>
              <h2 className="pf-display mt-1.5 truncate text-[20px] md:text-[23px]">{title}</h2>
              <p className="mt-1 text-[11.5px] text-[color:var(--pf-faint)]">{subtitle}</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="pf-btn"
                onClick={() => downloadReportCsv(doc())}
                disabled={cols.length === 0}
              >
                <Table2 className="size-4" /> Spreadsheet
              </button>
              <button
                type="button"
                className="pf-btn pf-btn-gold"
                onClick={() => void downloadReportPdf(doc())}
                disabled={cols.length === 0}
              >
                <Download className="size-4" /> PDF
              </button>
            </div>
          </div>

          {cols.length === 0 ? (
            <p className="flex items-center justify-center gap-2 border-t px-5 py-14 text-[13px] text-[color:var(--pf-faint)]">
              <FileText className="size-4" /> Pick at least one column.
            </p>
          ) : (
            <div className="max-h-[62vh] overflow-auto">
              <table className="w-full min-w-[640px] border-collapse text-left">
                <thead className="sticky top-0 z-10 bg-[color-mix(in_oklab,var(--pf-bg)_92%,transparent)] backdrop-blur">
                  <tr className="text-[10px] font-semibold tracking-[0.14em] text-[color:var(--pf-faint)] uppercase">
                    <th className="border-y px-3 py-2.5 pl-5 md:pl-6">{groupLabel}</th>
                    {cols.map((c) => (
                      <th key={c.key} className="border-y px-3 py-2.5 text-right">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label} className="pf-row border-b">
                      <td className="px-3 py-2.5 pl-5 text-[12.5px] md:pl-6">{r.label}</td>
                      {cols.map((c) => (
                        <td key={c.key} className="pf-num px-3 py-2.5 text-right text-[12.5px]">
                          {c.show(r.d)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="bg-[oklch(1_0_0_/_0.03)]">
                    <td className="px-3 py-3 pl-5 text-[12.5px] font-semibold md:pl-6">Total</td>
                    {cols.map((c) => (
                      <td
                        key={c.key}
                        className="pf-num px-3 py-3 text-right text-[12.5px] font-semibold"
                      >
                        {c.show(totals)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div className="border-t px-5 py-3 text-[11.5px] text-[color:var(--pf-faint)] md:px-6">
            Figures are final through {FRESHNESS.completeThrough}; the most recent day can still
            move slightly as conversions report in.
          </div>
        </Panel>
      </div>
    </>
  );
}
