import { ChevronDown } from "lucide-react";
import { Fragment, useState } from "react";

import { fmtCurrency, fmtNumber } from "@/lib/format";
import { EVENT, type CampaignRow } from "../mock";
import { pct, usd2 } from "../format";
import { Sparkline, StatusPill } from "./bits";

type SortKey = "spend" | "regs" | "costPerReg" | "ctr" | "name";

/**
 * Fixed column geometry. A `colgroup` plus `table-fixed` keeps the header and body in the same
 * grid whatever the content does, and the table scrolls horizontally on narrow screens rather than
 * dropping columns — a client comparing figures wants the same columns on a phone.
 */
const COLUMNS: { key: SortKey; label: string; width: string }[] = [
  { key: "name", label: "Campaign", width: "34%" },
  { key: "spend", label: "Spend", width: "14%" },
  { key: "ctr", label: "Click rate", width: "12%" },
  { key: "regs", label: EVENT.reg, width: "13%" },
  { key: "costPerReg", label: "Cost each", width: "13%" },
];

export function CampaignTable({ rows, showBrand }: { rows: CampaignRow[]; showBrand: boolean }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "spend", desc: true });
  const [open, setOpen] = useState<string | null>(null);

  const sorted = [...rows].sort((a, b) => {
    const dir = sort.desc ? -1 : 1;
    if (sort.key === "name") return a.name.localeCompare(b.name) * -dir;
    return (a[sort.key] - b[sort.key]) * dir;
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] table-fixed border-collapse text-left">
        <colgroup>
          {COLUMNS.map((c) => (
            <col key={c.key} style={{ width: c.width }} />
          ))}
          <col style={{ width: "14%" }} />
        </colgroup>
        <thead>
          <tr className="text-[10px] font-semibold tracking-[0.14em] text-[color:var(--pf-faint)] uppercase">
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                className={`border-b px-3 py-2.5 font-semibold first:pl-5 md:first:pl-6 ${
                  c.key === "name" ? "" : "text-right"
                }`}
              >
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-[color:var(--pf-text)]"
                  onClick={() =>
                    setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : true }))
                  }
                >
                  {c.label}
                  <ChevronDown
                    className={`size-3 transition ${
                      sort.key === c.key
                        ? sort.desc
                          ? "opacity-90"
                          : "rotate-180 opacity-90"
                        : "opacity-0"
                    }`}
                  />
                </button>
              </th>
            ))}
            <th className="border-b px-3 py-2.5 pr-5 text-right font-semibold md:pr-6">Trend</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const isOpen = open === r.id;
            // A campaign that never delivered has no figures to show — em dashes, not zeroes.
            const cell = (v: string): string => (r.spend === 0 ? "—" : v);
            return (
              <Fragment key={r.id}>
                <tr
                  className="pf-row cursor-pointer border-b align-middle"
                  onClick={() => setOpen(isOpen ? null : r.id)}
                >
                  <td className="px-3 py-3 pl-5 md:pl-6">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="text-[13.5px] font-semibold">{r.name}</span>
                      <StatusPill status={r.status} />
                    </div>
                    <p className="mt-1 text-[11px] text-[color:var(--pf-faint)]">
                      {showBrand ? `${r.brandName} · ` : ""}
                      {r.goal} · {r.adSets.length} audience{r.adSets.length === 1 ? "" : "s"}
                    </p>
                  </td>
                  <td className="pf-num px-3 py-3 text-right text-[13px]">
                    {cell(fmtCurrency(r.spend))}
                  </td>
                  <td className="pf-num px-3 py-3 text-right text-[13px] text-[color:var(--pf-dim)]">
                    {cell(pct(r.ctr, 2))}
                  </td>
                  <td className="pf-num px-3 py-3 text-right text-[13px]">
                    {cell(fmtNumber(r.regs))}
                  </td>
                  <td className="pf-num px-3 py-3 text-right text-[13px]">
                    {r.regs === 0 ? "—" : cell(usd2(r.costPerReg))}
                  </td>
                  <td className="px-3 py-3 pr-5 md:pr-6">
                    <div className="flex items-center justify-end gap-2">
                      <Sparkline values={r.trend} width={78} />
                      <ChevronDown
                        className={`size-4 shrink-0 text-[color:var(--pf-faint)] transition ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                    </div>
                  </td>
                </tr>
                {isOpen ? (
                  <tr className="border-b bg-[oklch(1_0_0_/_0.018)]">
                    <td colSpan={6} className="px-5 py-4 md:px-6">
                      <p className="pf-eyebrow mb-2">Audiences in this campaign</p>
                      <div className="space-y-1.5">
                        {r.adSets.map((s) => (
                          <div
                            key={s.id}
                            className="grid grid-cols-[1fr_6rem_5rem_6rem] items-center gap-x-4 rounded-lg border px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-[12.5px] font-medium">{s.name}</p>
                              <p className="text-[11px] text-[color:var(--pf-faint)]">
                                {s.audience}
                              </p>
                            </div>
                            <span className="pf-num text-right text-[12.5px]">
                              {cell(fmtCurrency(s.spend))}
                            </span>
                            <span className="pf-num text-right text-[12.5px]">
                              {cell(fmtNumber(s.regs))}
                            </span>
                            <span className="pf-num text-right text-[12.5px] text-[color:var(--pf-dim)]">
                              {s.regs === 0 ? "—" : cell(usd2(s.costPerReg))}
                            </span>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
