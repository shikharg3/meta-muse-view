import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { FileText, History, LayoutTemplate, Plus } from "lucide-react";

const TABS = [
  { to: "/reports", label: "History", icon: History },
  { to: "/reports/new", label: "New report", icon: Plus },
  { to: "/reports/templates", label: "Templates", icon: LayoutTemplate },
] as const;

export const Route = createFileRoute("/reports")({
  head: () => ({
    meta: [
      { title: "Reports — MetaConsole" },
      {
        name: "description",
        content: "Build client-ready CSV/PDF reports from your synced Meta Ads data.",
      },
    ],
  }),
  component: ReportsLayout,
});

function ReportsLayout() {
  return (
    // Wider than the old max-w-6xl page: the report preview now scrolls 100+ columns.
    <div className="mx-auto max-w-[1400px] px-4 md:px-6 py-8">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <FileText className="size-5 text-primary" /> Reports
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
          Build, save, and re-run client-ready CSV or PDF reports from your synced Meta Ads data.
        </p>
      </div>

      {/* A segmented control, not underlined text links: this is the section's primary navigation,
          so each destination has to read as a button at a glance. Colour lives entirely in
          active/inactiveProps — Link concatenates those onto `className` without tailwind-merge, so
          a text colour in the base class would collide with the active one and resolve by
          stylesheet order rather than intent. */}
      <nav className="mb-6 inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1">
        {TABS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            // Only the index tab needs `exact`: "/reports" prefix-matches every child route, so
            // without it History would render active while on /reports/new or /reports/templates.
            activeOptions={{ exact: t.to === "/reports" }}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition"
            activeProps={{ className: "bg-primary text-primary-foreground shadow-sm" }}
            inactiveProps={{
              className: "text-muted-foreground hover:bg-accent hover:text-foreground",
            }}
          >
            <t.icon className="size-3.5" />
            {t.label}
          </Link>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
