import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { getActivity } from "@/lib/api/activity";
import { fmtRelTime } from "@/lib/format";

export const Route = createFileRoute("/activity")({
  head: () => ({
    meta: [
      { title: "Activity — MetaConsole" },
      { name: "description", content: "Ad-account change history captured from Meta." },
    ],
  }),
  loader: async () => ({ events: await getActivity() }),
  component: ActivityPage,
});

function ActivityPage() {
  const { events } = Route.useLoaderData();
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-[1100px]">
      <PageHeader
        title="Activity"
        description="Recent changes across ad accounts — budget, status and structure edits captured from Meta."
      />
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {events.length === 0 && (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">
            No activity captured yet — it populates on the next sync cycle.
          </div>
        )}
        {events.map((e) => (
          <div key={e.id} className="flex items-start gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm">
                <span className="font-medium">{e.eventType}</span>
                {e.objectName && <span className="text-muted-foreground"> · {e.objectName}</span>}
              </div>
              <div className="text-xs text-muted-foreground">
                <Link
                  to="/accounts/$id"
                  params={{ id: e.accountId }}
                  className="hover:text-primary hover:underline"
                >
                  {e.accountName ?? e.accountId}
                </Link>
                {e.actorName && <> · {e.actorName}</>}
              </div>
            </div>
            <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {e.eventTime ? fmtRelTime(e.eventTime) : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
