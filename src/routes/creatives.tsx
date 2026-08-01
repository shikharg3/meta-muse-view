import { createFileRoute } from "@tanstack/react-router";
import { Construction } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { scopedSearch } from "@/lib/range";

export const Route = createFileRoute("/creatives")({
  head: () => ({
    meta: [
      { title: "Creatives — MetaConsole" },
      { name: "description", content: "Creative reporting is being rebuilt." },
    ],
  }),
  // Creative tracking is paused, so this route intentionally loads no data.
  validateSearch: scopedSearch,
  component: Creatives,
});

function Creatives() {
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1600px]">
      <PageHeader title="Creatives" description="Creative reporting is being rebuilt." />
      <div className="rounded-xl border border-border bg-card p-12 flex flex-col items-center text-center gap-3">
        <Construction className="size-8 text-muted-foreground" />
        <h2 className="text-base font-semibold">Work in progress</h2>
        <p className="text-sm text-muted-foreground max-w-md">
          Creative tracking is paused while this section is rebuilt. Campaign, ad set and ad
          performance are unaffected.
        </p>
      </div>
    </div>
  );
}
