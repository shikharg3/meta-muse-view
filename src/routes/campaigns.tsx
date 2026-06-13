import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { CampaignTable } from "@/components/dashboard/CampaignTable";
import { listCampaigns } from "@/lib/api/dashboard";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { rangeSearch, toRange } from "@/lib/range";

export const Route = createFileRoute("/campaigns")({
  head: () => ({
    meta: [
      { title: "Campaigns — MetaConsole" },
      { name: "description", content: "Hierarchical campaign, ad set, and ad explorer." },
    ],
  }),
  validateSearch: rangeSearch,
  loaderDeps: ({ search }) => ({ range: toRange(search.range) }),
  loader: async ({ deps: { range } }) => ({ campaigns: await listCampaigns({ data: range }) }),
  component: CampaignsExplorer,
});

function CampaignsExplorer() {
  const { campaigns } = Route.useLoaderData();
  const [q, setQ] = useState("");
  const [objective, setObjective] = useState("ALL");

  const objectives = useMemo(
    () => ["ALL", ...Array.from(new Set(campaigns.map((c) => c.objective)))],
    [campaigns],
  );
  const filtered = useMemo(
    () =>
      campaigns.filter(
        (c) =>
          (objective === "ALL" || c.objective === objective) &&
          (q.trim() === "" ||
            c.name.toLowerCase().includes(q.toLowerCase()) ||
            c.accountName.toLowerCase().includes(q.toLowerCase())),
      ),
    [campaigns, q, objective],
  );

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        title="Campaign Explorer"
        description="Hierarchical view of campaigns, ad sets, and ads across the BM."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search campaigns or accounts…"
            className="w-full h-9 rounded-md border border-border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex rounded-md border border-border bg-card overflow-hidden text-xs">
          {objectives.map((o) => (
            <button
              key={o}
              onClick={() => setObjective(o)}
              className={cn(
                "px-2.5 h-9 font-medium font-mono uppercase text-[10px] transition-colors",
                objective === o
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {o}
            </button>
          ))}
        </div>
      </div>

      <CampaignTable campaigns={filtered} />
    </div>
  );
}
