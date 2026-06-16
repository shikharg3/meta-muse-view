import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getLibrary } from "@/lib/api/library";

export const Route = createFileRoute("/library")({
  head: () => ({
    meta: [
      { title: "Library — MetaConsole" },
      {
        name: "description",
        content: "Audiences, pixels, conversions and other reference objects captured from Meta.",
      },
    ],
  }),
  loader: async () => ({ groups: await getLibrary() }),
  component: LibraryPage,
});

function LibraryPage() {
  const { groups } = Route.useLoaderData();
  const total = groups.reduce((s, g) => s + g.count, 0);
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1200px]">
      <PageHeader
        title="Library"
        description="Custom & saved audiences, pixels, custom conversions, creative assets and automated rules captured from Meta."
      >
        <span className="rounded-full bg-muted text-muted-foreground text-xs font-semibold px-2.5 py-1">
          {total.toLocaleString()} objects
        </span>
      </PageHeader>

      {groups.length === 0 && (
        <div className="rounded-xl border border-border bg-card px-5 py-12 text-center text-sm text-muted-foreground">
          No reference objects synced yet — they populate on the next sync cycle.
        </div>
      )}

      {groups.map((g) => (
        <section key={g.type} className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <h3 className="text-sm font-semibold">{g.label}</h3>
            <span className="text-xs text-muted-foreground">{g.count.toLocaleString()}</span>
          </div>
          <div className="divide-y divide-border">
            {g.items.map((it) => (
              <div key={`${g.type}:${it.id}`} className="flex items-center gap-3 px-5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{it.name ?? it.id}</div>
                  {it.detail && <div className="text-xs text-muted-foreground">{it.detail}</div>}
                </div>
                <Link
                  to="/accounts/$id"
                  params={{ id: it.accountId }}
                  className="shrink-0 font-mono text-[10px] text-muted-foreground hover:text-primary"
                >
                  {it.accountId}
                </Link>
              </div>
            ))}
            {g.count > g.items.length && (
              <div className="px-5 py-2 text-xs text-muted-foreground">
                +{(g.count - g.items.length).toLocaleString()} more
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
