import { useQuery } from "@tanstack/react-query";
import { getMetaHealth } from "@/lib/api/health";
import { buildStatusLines, type Tone } from "@/lib/health-lines";

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  idle: "bg-muted-foreground",
};

/** Always-visible health indicator in the sidebar footer: the Meta app + system token, and the
 *  background Notion board integration in BOTH directions — so a dead token, a stalled read sync or
 *  a write-back that has quietly stopped maintaining the 🤖 columns is visible without opening
 *  Settings or reading server logs. Which line to show is decided by `buildStatusLines`; this
 *  component only paints. Polls ~hourly. */
export function MetaStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ["meta-health"],
    queryFn: () => getMetaHealth(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const lines = buildStatusLines(isLoading ? null : data);

  return (
    <div className="space-y-0.5">
      {lines.map((l) => (
        <div
          key={l.label}
          title={l.title}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-[11px] text-muted-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <span className={`size-2 shrink-0 rounded-full ${DOT[l.tone]}`} />
          <span className="truncate group-data-[collapsible=icon]:hidden">{l.label}</span>
        </div>
      ))}
    </div>
  );
}
