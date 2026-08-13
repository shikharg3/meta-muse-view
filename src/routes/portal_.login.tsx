import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Lock, Mail } from "lucide-react";
import { useState } from "react";

import portalCss from "../portal/theme.css?url";
import { CLIENT, EVENT } from "@/portal/mock";

/**
 * Client sign-in. Deliberately outside the `/portal` layout (the `portal_` segment un-nests it), so
 * the shell, brand filter and navigation never render for a visitor who is not signed in.
 *
 * There is no sign-up link on purpose: `clients.id` is a guessable slug, so client logins are
 * created by an admin and bound to one client record — never self-served.
 */
export const Route = createFileRoute("/portal_/login")({
  head: () => ({
    meta: [
      { title: "Sign in — DOT Client Portal" },
      { name: "robots", content: "noindex, nofollow" },
    ],
    links: [
      { rel: "stylesheet", href: portalCss },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300&family=Manrope:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap",
      },
    ],
  }),
  component: PortalLogin,
});

const PROMISES = [
  ["Every campaign", "in the words your account team uses with you"],
  [`${EVENT.reg} and ${EVENT.dep.toLowerCase()}`, "counted the same way every day"],
  ["Your own exports", "spreadsheet or PDF, whenever you need one"],
] as const;

function PortalLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("finance@northwind.group");
  const [password, setPassword] = useState("preview");

  return (
    <div className="dot-portal pf-grain grid min-h-screen lg:grid-cols-[1.05fr_0.95fr]">
      {/* Statement side */}
      <div className="pf-glow relative hidden flex-col justify-between overflow-hidden p-10 lg:flex xl:p-14">
        <div
          className="pointer-events-none absolute -top-40 -left-24 size-[560px] rounded-full opacity-[0.16] blur-3xl"
          style={{
            background:
              "conic-gradient(from 140deg, var(--pf-gold), var(--pf-violet), var(--pf-mint), var(--pf-gold))",
          }}
        />
        <div className="relative flex items-baseline gap-3">
          <span className="pf-display text-[24px] text-[color:var(--pf-gold)]">DOT</span>
          <span className="h-3.5 w-px bg-[color:var(--pf-line-strong)]" />
          <span className="text-[11px] font-semibold tracking-[0.2em] text-[color:var(--pf-faint)] uppercase">
            Client Portal
          </span>
        </div>

        <div className="relative max-w-xl">
          <h1 className="pf-display pf-rise text-[52px] leading-[0.98] xl:text-[64px]">
            Your media,
            <br />
            <span className="pf-display-em text-[color:var(--pf-gold)]">as it happens</span>.
          </h1>
          <p
            className="pf-rise mt-6 max-w-md text-[14px] leading-relaxed text-[color:var(--pf-dim)]"
            style={{ "--d": "120ms" } as React.CSSProperties}
          >
            Performance, pacing and creative for {CLIENT.name} — updated hourly from Meta, and
            reported the same way every single day.
          </p>

          <dl className="mt-10 space-y-4">
            {PROMISES.map(([term, detail], i) => (
              <div
                key={term}
                className="pf-rise grid grid-cols-[2rem_1fr] gap-4 border-t pt-4"
                style={{ "--d": `${200 + i * 90}ms` } as React.CSSProperties}
              >
                <span aria-hidden="true" className="pf-num text-[11px] text-[color:var(--pf-gold)]">
                  0{i + 1}
                </span>
                <div>
                  <dt className="text-[13.5px] font-semibold">{term}</dt>
                  <dd className="text-[12.5px] text-[color:var(--pf-faint)]">{detail}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>

        <p className="relative text-[11px] text-[color:var(--pf-faint)]">
          © 2026 DOT Agency · Design preview running on sample data
        </p>
      </div>

      {/* Form side */}
      <div className="flex items-center justify-center bg-[color:var(--pf-bg-2)] px-5 py-12 sm:px-10">
        <form
          className="pf-rise w-full max-w-[380px]"
          onSubmit={(e) => {
            e.preventDefault();
            void navigate({ to: "/portal" });
          }}
        >
          <div className="mb-8 lg:hidden">
            <span className="pf-display text-[22px] text-[color:var(--pf-gold)]">DOT</span>
          </div>

          <p className="pf-eyebrow">Client access</p>
          <h2 className="pf-display mt-2 text-[30px]">Sign in</h2>
          <p className="mt-2 text-[12.5px] text-[color:var(--pf-faint)]">
            Use the address your account director set up for you.
          </p>

          <label className="mt-7 block">
            <span className="pf-eyebrow">Email</span>
            <span className="mt-1.5 flex items-center gap-2.5 rounded-lg border px-3 focus-within:border-[color:var(--pf-gold)]">
              <Mail className="size-4 shrink-0 text-[color:var(--pf-faint)]" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="h-11 w-full bg-transparent text-[13.5px] outline-none placeholder:text-[color:var(--pf-faint)]"
                placeholder="you@company.com"
              />
            </span>
          </label>

          <label className="mt-4 block">
            <span className="pf-eyebrow">Password</span>
            <span className="mt-1.5 flex items-center gap-2.5 rounded-lg border px-3 focus-within:border-[color:var(--pf-gold)]">
              <Lock className="size-4 shrink-0 text-[color:var(--pf-faint)]" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="h-11 w-full bg-transparent text-[13.5px] outline-none"
                placeholder="••••••••"
              />
            </span>
          </label>

          <div className="mt-4 flex items-center justify-between text-[12px]">
            <label className="inline-flex items-center gap-2 text-[color:var(--pf-dim)]">
              <input type="checkbox" defaultChecked className="accent-[var(--pf-gold)]" />
              Keep me signed in
            </label>
            <span className="text-[color:var(--pf-faint)]">Forgot password?</span>
          </div>

          <button type="submit" className="pf-btn pf-btn-gold mt-6 w-full">
            Open my dashboard <ArrowRight className="size-4" />
          </button>

          <p className="mt-6 border-t pt-4 text-[11.5px] leading-relaxed text-[color:var(--pf-faint)]">
            Accounts are created by your account director — there is no public sign-up. Each login
            sees only its own brands.
          </p>
        </form>
      </div>
    </div>
  );
}
