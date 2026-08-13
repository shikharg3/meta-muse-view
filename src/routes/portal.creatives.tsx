import { createFileRoute } from "@tanstack/react-router";
import { Check, Clock, Flame, MessageSquareDashed, Play, Sparkles, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";

import { fmtCurrency } from "@/lib/format";
import { Eyebrow, Panel, SectionHead, Segmented } from "@/portal/components/bits";
import { PageIntro } from "@/portal/components/Shell";
import { pct, usd2 } from "@/portal/format";
import { creativesFor, longDay, type Creative, type CreativeReview } from "@/portal/mock";
import { usePortalView } from "@/portal/state";

export const Route = createFileRoute("/portal/creatives")({
  head: () => ({ meta: [{ title: "Creative — Northwind Group" }] }),
  component: Creatives,
});

type Filter = "all" | "pending" | "fatiguing" | "approved";

const REVIEW_TONE: Record<CreativeReview, string> = {
  approved: "var(--pf-mint)",
  pending: "var(--pf-gold)",
  changes: "var(--pf-violet)",
};
const REVIEW_LABEL: Record<CreativeReview, string> = {
  approved: "Approved",
  pending: "Awaiting your approval",
  changes: "Change requested",
};
const FATIGUE_LABEL: Record<Creative["fatigue"], string> = {
  fresh: "New this fortnight",
  steady: "Holding steady",
  fatiguing: "Tiring — needs a refresh",
};

function Creatives() {
  const { brand, brandLabel } = usePortalView();
  const base = creativesFor(brand);
  // The approval loop is what turns the portal from a report into workflow. Decisions live in local
  // state for the preview; in the real portal they post back and feed the creative pipeline.
  const [decided, setDecided] = useState<Record<string, CreativeReview>>({});
  const [filter, setFilter] = useState<Filter>("all");

  const items = useMemo(
    () => base.map((c) => ({ ...c, review: decided[c.id] ?? c.review })),
    [base, decided],
  );
  const shown = items.filter((c) =>
    filter === "all"
      ? true
      : filter === "fatiguing"
        ? c.fatigue === "fatiguing"
        : filter === "approved"
          ? c.review === "approved"
          : c.review === "pending",
  );
  const waiting = items.filter((c) => c.review === "pending").length;

  return (
    <>
      <PageIntro
        eyebrow={`${brandLabel} · creative`}
        title={
          <>
            The work, and how it{" "}
            <span className="pf-display-em text-[color:var(--pf-gold)]">landed</span>
          </>
        }
        lede="Every ad currently in rotation, with its own numbers since launch. Approve what you are happy with, or ask for a change — your account team picks it up the same day."
      >
        <div
          className="pf-rise pf-panel flex items-center gap-3 px-4 py-3"
          style={{ "--d": "200ms" } as React.CSSProperties}
        >
          <span
            className="grid size-9 place-items-center rounded-full"
            style={{ background: "oklch(0.845 0.115 82 / 0.14)", color: "var(--pf-gold)" }}
          >
            <Clock className="size-4" />
          </span>
          <div className="leading-tight">
            <p className="pf-num text-[19px]">{waiting}</p>
            <p className="text-[11px] text-[color:var(--pf-faint)]">awaiting your approval</p>
          </div>
        </div>
      </PageIntro>

      <div className="mx-auto max-w-[1240px] space-y-4 px-4 pt-6 md:px-7">
        <Panel delay={140}>
          <SectionHead
            eyebrow={`${shown.length} of ${items.length} ads`}
            title="Creative in rotation"
            aside={
              <Segmented
                label="Creative filter"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "pending", label: "Needs approval" },
                  { value: "fatiguing", label: "Tiring" },
                  { value: "approved", label: "Approved" },
                ]}
              />
            }
          />
          <div className="grid gap-4 px-5 pb-6 sm:grid-cols-2 lg:grid-cols-3 md:px-6 xl:grid-cols-4">
            {shown.map((c, i) => (
              <CreativeCard
                key={c.id}
                creative={c}
                delay={i * 45}
                onDecide={(r) => setDecided((d) => ({ ...d, [c.id]: r }))}
              />
            ))}
            {shown.length === 0 ? (
              <p className="col-span-full py-10 text-center text-[13px] text-[color:var(--pf-faint)]">
                Nothing in this list right now.
              </p>
            ) : null}
          </div>
        </Panel>
      </div>
    </>
  );
}

function CreativeCard({
  creative: c,
  delay,
  onDecide,
}: {
  creative: Creative;
  delay: number;
  onDecide: (r: CreativeReview) => void;
}) {
  const tone = REVIEW_TONE[c.review];
  return (
    <article
      className="pf-rise group flex flex-col overflow-hidden rounded-xl border transition hover:border-[color:var(--pf-line-strong)]"
      style={{ "--d": `${delay}ms` } as React.CSSProperties}
    >
      {/*
       * Stand-in for the ad artwork: a deterministic poster keyed off the creative's hue. Chroma is
       * kept low on purpose — twelve saturated tiles would fight the ink-and-gold palette, and these
       * are placeholders for real thumbnails, not decoration.
       */}
      <div
        className="relative aspect-[4/5] overflow-hidden"
        style={{
          background: `radial-gradient(115% 85% at 24% 14%, oklch(0.52 0.075 ${c.hue}) 0%, transparent 60%),
             radial-gradient(90% 80% at 84% 82%, oklch(0.38 0.06 ${(c.hue + 52) % 360}) 0%, transparent 64%),
             linear-gradient(168deg, oklch(0.26 0.035 ${c.hue}), oklch(0.155 0.012 264))`,
        }}
      >
        <div className="absolute inset-0 bg-[linear-gradient(to_top,oklch(0.12_0.01_264/0.9),transparent_56%)]" />
        {/* Faint 45° rake, so a placeholder still reads as a piece of artwork. */}
        <div className="absolute inset-0 opacity-[0.07] bg-[repeating-linear-gradient(45deg,transparent,transparent_7px,white_7px,white_8px)]" />
        <span className="absolute top-2.5 left-2.5 rounded-md bg-[oklch(0.12_0.01_264/0.6)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide backdrop-blur-sm">
          {c.format}
        </span>
        {c.format.startsWith("Video") ? (
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-11 place-items-center rounded-full border border-white/25 bg-white/10 backdrop-blur-sm transition group-hover:scale-110">
              <Play className="size-4 translate-x-[1px] fill-white/90 text-white/90" />
            </span>
          </span>
        ) : null}
        <p className="pf-display absolute right-3 bottom-3 left-3 text-[15px] leading-tight">
          {c.hook}
        </p>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-[11.5px] text-[color:var(--pf-dim)]">{c.brandName}</p>
            <p className="text-[10.5px] text-[color:var(--pf-faint)]">
              Live since {longDay(c.firstSeen)}
            </p>
          </div>
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold"
            style={{ color: c.fatigue === "fatiguing" ? "var(--pf-rose)" : "var(--pf-faint)" }}
            title={FATIGUE_LABEL[c.fatigue]}
          >
            {c.fatigue === "fatiguing" ? (
              <Flame className="size-3" />
            ) : c.fatigue === "fresh" ? (
              <Sparkles className="size-3" />
            ) : null}
            {c.fatigue === "steady" ? "Steady" : c.fatigue === "fresh" ? "New" : "Tiring"}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {[
            { k: "Spent", v: fmtCurrency(c.spend) },
            { k: "Click rate", v: pct(c.ctr, 2) },
            { k: "Cost each", v: usd2(c.costPerReg) },
          ].map((m) => (
            <div key={m.k}>
              <Eyebrow className="!text-[9px]">{m.k}</Eyebrow>
              <p className="pf-num mt-0.5 text-[12.5px]">{m.v}</p>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold"
            style={{ color: tone }}
          >
            {c.review === "approved" ? (
              <Check className="size-3.5" />
            ) : c.review === "changes" ? (
              <MessageSquareDashed className="size-3.5" />
            ) : (
              <Clock className="size-3.5" />
            )}
            {REVIEW_LABEL[c.review]}
          </span>
          {c.review === "pending" ? (
            <span className="flex gap-1.5">
              <button type="button" className="pf-chip !h-7" onClick={() => onDecide("changes")}>
                Change
              </button>
              <button
                type="button"
                className="pf-chip !h-7"
                data-on="true"
                onClick={() => onDecide("approved")}
              >
                Approve
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-[color:var(--pf-faint)] hover:text-[color:var(--pf-text)]"
              onClick={() => onDecide("pending")}
            >
              <Undo2 className="size-3" /> Undo
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
