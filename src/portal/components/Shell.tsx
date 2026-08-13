import { Link } from "@tanstack/react-router";
import { CircleCheck, LogOut, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { BRANDS, CLIENT, FRESHNESS, RANGES, type BrandFilter } from "../mock";
import { usePortalView } from "../state";
import { Eyebrow, Segmented } from "./bits";

const NAV = [
  { to: "/portal", label: "Overview" },
  { to: "/portal/campaigns", label: "Campaigns" },
  { to: "/portal/creatives", label: "Creative" },
  { to: "/portal/reports", label: "Reports" },
] as const;

/** Wordmark: the agency signs the report, the client owns it. */
function Wordmark() {
  return (
    <Link to="/portal" className="group flex items-baseline gap-2.5">
      <span className="pf-display text-[21px] tracking-[0.02em] text-[color:var(--pf-gold)]">
        DOT
      </span>
      <span className="hidden h-3.5 w-px bg-[color:var(--pf-line-strong)] sm:block" />
      <span className="hidden text-[11px] font-semibold tracking-[0.2em] text-[color:var(--pf-faint)] uppercase transition group-hover:text-[color:var(--pf-dim)] sm:block">
        Client Portal
      </span>
    </Link>
  );
}

export function PortalNav() {
  return (
    <header className="sticky top-0 z-50 border-b bg-[color-mix(in_oklab,var(--pf-bg)_96%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex h-[62px] max-w-[1240px] items-center gap-3 px-4 md:gap-5 md:px-7">
        <Wordmark />

        {/* `min-w-0` is what actually lets the scroll container shrink below its content width. */}
        <nav className="ml-auto flex min-w-0 items-center gap-0.5 overflow-x-auto md:ml-6 md:gap-1">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === "/portal" }}
              className="relative rounded-lg px-2.5 pt-2 pb-2.5 text-[13px] font-medium whitespace-nowrap text-[color:var(--pf-dim)] transition hover:text-[color:var(--pf-text)] md:px-3"
              activeProps={{
                // The indicator must stay INSIDE the nav: `overflow-x-auto` also clips the y axis,
                // so an underline hung below the element would disappear on narrow screens.
                className:
                  "text-[color:var(--pf-text)] after:absolute after:inset-x-2.5 after:bottom-0 after:h-[2px] after:rounded-full after:bg-[color:var(--pf-gold)] md:after:inset-x-3",
              }}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3 md:ml-0">
          <div className="hidden text-right leading-tight sm:block">
            <p className="text-[12.5px] font-semibold">{CLIENT.name}</p>
            <p className="text-[10.5px] text-[color:var(--pf-faint)]">
              Client since {CLIENT.since}
            </p>
          </div>
          <span
            className="pf-num grid size-9 shrink-0 place-items-center rounded-full text-[12px] font-semibold"
            style={{
              color: "oklch(0.2 0.02 80)",
              background: "linear-gradient(160deg, var(--pf-gold), var(--pf-gold-deep))",
            }}
          >
            NG
          </span>
          <Link
            to="/portal/login"
            aria-label="Sign out"
            className="text-[color:var(--pf-faint)] transition hover:text-[color:var(--pf-text)]"
          >
            <LogOut className="size-4" />
          </Link>
        </div>
      </div>
    </header>
  );
}

/**
 * Brand filter + reporting window. Multi-brand clients switch brands here rather than holding
 * several logins, which is the identity decision the portal is built around.
 */
export function ControlBar() {
  const { range, setRange, brand, setBrand } = usePortalView();
  const brandOptions: { value: BrandFilter; label: string }[] = [
    { value: null, label: "All brands" },
    ...BRANDS.map((b) => ({ value: b.id as BrandFilter, label: b.name })),
  ];

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-3 px-4 pt-5 md:flex-row md:items-end md:justify-between md:px-7">
      <div>
        <Eyebrow className="mb-1.5">Brand</Eyebrow>
        <div className="flex flex-wrap gap-1.5">
          <Segmented label="Brand" value={brand} onChange={setBrand} options={brandOptions} />
        </div>
      </div>
      <div className="md:text-right">
        <Eyebrow className="mb-1.5">Reporting window</Eyebrow>
        <Segmented
          label="Reporting window"
          value={range}
          onChange={setRange}
          options={RANGES.map((r) => ({ value: r.key, label: r.label }))}
        />
      </div>
    </div>
  );
}

/** Page title block. The serif line is the only place the portal raises its voice. */
export function PageIntro({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[1240px] px-4 pt-7 pb-1 md:px-7">
      <div className="pf-rise flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="pf-display mt-2 text-[34px] md:text-[46px]">{title}</h1>
          {lede ? (
            <p className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-[color:var(--pf-dim)]">
              {lede}
            </p>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Data-trust surface: what the numbers are, when they were taken, how they are counted. */
export function FreshnessNote() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11.5px] text-[color:var(--pf-faint)]">
      <span className="inline-flex items-center gap-1.5">
        <span className="relative grid place-items-center">
          <span className="absolute size-2.5 animate-ping rounded-full bg-[color:var(--pf-mint)] opacity-40" />
          <span className="size-1.5 rounded-full bg-[color:var(--pf-mint)]" />
        </span>
        Data as of {FRESHNESS.syncedAt}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <CircleCheck className="size-3.5" /> Final through {FRESHNESS.completeThrough}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <ShieldCheck className="size-3.5" /> {FRESHNESS.attribution}
      </span>
      <span>{FRESHNESS.cadence}</span>
    </div>
  );
}

/** Honest label for this build: the whole portal is running on generated numbers. */
export function DemoRibbon() {
  return (
    <div className="border-b bg-[oklch(0.845_0.115_82_/_0.07)]">
      <div className="mx-auto flex max-w-[1240px] items-center gap-2 px-4 py-1.5 text-[11px] text-[color:var(--pf-gold)] md:px-7">
        <span className="relative h-3 w-8 overflow-hidden rounded-full bg-[oklch(0.845_0.115_82_/_0.2)]">
          <span className="pf-sweep absolute inset-y-0 w-3 rounded-full bg-[color:var(--pf-gold)] opacity-70" />
        </span>
        Design preview — every figure on this site is generated sample data, not client data.
      </div>
    </div>
  );
}

export function PortalFooter() {
  return (
    <footer className="mt-14 border-t">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-3 px-4 py-8 text-[11.5px] text-[color:var(--pf-faint)] md:flex-row md:items-center md:justify-between md:px-7">
        <p>
          Prepared by DOT for <span className="text-[color:var(--pf-dim)]">{CLIENT.name}</span>.
          Your account director is{" "}
          <span className="text-[color:var(--pf-dim)]">{CLIENT.contact}</span>.
        </p>
        <p className="pf-num">© 2026 DOT Agency · Reported in USD</p>
      </div>
    </footer>
  );
}
