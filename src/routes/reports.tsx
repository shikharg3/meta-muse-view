import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { FileText } from "lucide-react";

const TABS = [
  { to: "/reports", label: "History" },
  { to: "/reports/new", label: "New report" },
  { to: "/reports/templates", label: "Templates" },
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

      <nav className="mb-6 flex items-center gap-4 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            // Only the index tab needs `exact`: "/reports" prefix-matches every child route, so
            // without it History would render active while on /reports/new or /reports/templates.
            activeOptions={{ exact: t.to === "/reports" }}
            className="-mb-px border-b-2 border-transparent px-0.5 pb-2 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            activeProps={{ className: "border-primary text-foreground" }}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
