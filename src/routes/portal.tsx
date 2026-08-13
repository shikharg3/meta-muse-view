import { createFileRoute, Outlet } from "@tanstack/react-router";

import portalCss from "../portal/theme.css?url";
import { PortalViewProvider } from "@/portal/state";
import { ControlBar, DemoRibbon, PortalFooter, PortalNav } from "@/portal/components/Shell";

/**
 * Client portal shell — the design preview for the AgencyAnalytics replacement (roadmap Track A).
 *
 * This route tree renders entirely from `src/portal/mock.ts`: no server functions, no database, no
 * session. That is the point of the MVP — we are agreeing on the UI, and generated data means there
 * is nothing real to leak while the scope boundary does not exist yet.
 */
export const Route = createFileRoute("/portal")({
  head: () => ({
    meta: [
      { title: "Northwind Group — Performance Portal" },
      { name: "description", content: "Client-facing Meta Ads performance portal by DOT." },
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
  component: PortalLayout,
});

function PortalLayout() {
  return (
    <PortalViewProvider>
      <div className="dot-portal pf-grain pf-glow">
        <DemoRibbon />
        <PortalNav />
        <ControlBar />
        <main className="relative pb-4">
          <Outlet />
        </main>
        <PortalFooter />
      </div>
    </PortalViewProvider>
  );
}
