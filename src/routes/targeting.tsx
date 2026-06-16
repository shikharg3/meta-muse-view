import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getTargeting } from "@/lib/api/targeting";

export const Route = createFileRoute("/targeting")({
  head: () => ({
    meta: [
      { title: "Targeting — MetaConsole" },
      { name: "description", content: "Ad-set audience targeting definitions captured from Meta." },
    ],
  }),
  loader: async () => ({ rows: await getTargeting() }),
  component: TargetingPage,
});

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground">
      {children}
    </span>
  );
}

function TargetingPage() {
  const { rows } = Route.useLoaderData();
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1400px]">
      <PageHeader
        title="Targeting"
        description={`Audience targeting for ${rows.length} ad sets — geo, age, gender, custom audiences and interests.`}
      />
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {rows.length === 0 && (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">
            No targeting captured yet — it populates on the next sync cycle.
          </div>
        )}
        {rows.map((r) => (
          <div key={r.id} className="px-5 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{r.name}</div>
                <Link
                  to="/accounts/$id"
                  params={{ id: r.accountId }}
                  className="text-[10px] text-muted-foreground hover:text-primary"
                >
                  {r.accountName ?? r.accountId}
                </Link>
              </div>
              {r.optimizationGoal && (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {r.optimizationGoal}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {r.countries.length > 0 && (
                <Chip>
                  {r.countries.slice(0, 6).join(", ")}
                  {r.countries.length > 6 ? ` +${r.countries.length - 6}` : ""}
                </Chip>
              )}
              <Chip>
                Age {r.ageMin ?? 13}–{r.ageMax ?? 65}
              </Chip>
              <Chip>{r.genders}</Chip>
              {r.customAudiences > 0 && <Chip>{r.customAudiences} custom aud.</Chip>}
              {r.excludedAudiences > 0 && <Chip>{r.excludedAudiences} excluded</Chip>}
              {r.advantageAudience && <Chip>Advantage+ audience</Chip>}
              {r.interests.map((i) => (
                <Chip key={i}>{i}</Chip>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
