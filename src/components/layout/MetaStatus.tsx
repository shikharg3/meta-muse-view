import { useQuery } from "@tanstack/react-query";
import { getMetaHealth } from "@/lib/api/health";

type Tone = "ok" | "warn" | "bad" | "idle";

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  idle: "bg-muted-foreground",
};

/** Always-visible Meta app + system-token health indicator in the sidebar footer. Polls hourly-ish
 *  so a dead token, a stalled sync worker, or a tier downgrade is visible without opening Settings. */
export function MetaStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ["meta-health"],
    queryFn: () => getMetaHealth(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  let tone: Tone = "idle";
  let label = "Meta: checking…";
  let title = "Meta app health";

  if (!isLoading && data) {
    const ageMin = data.checkedAt ? (Date.now() - Date.parse(data.checkedAt)) / 60_000 : null;
    const tierLabel =
      data.tier === "standard" ? "Standard" : data.tier === "development" ? "Dev tier" : null;
    if (data.tokenValid === false) {
      tone = "bad";
      label = "Meta: token invalid";
      title = data.note
        ? `Meta system-user token invalid: ${data.note}`
        : "Meta system-user token is invalid or expired — update credentials on Settings.";
    } else if (data.tokenValid === null) {
      tone = "idle";
      label = "Meta: not checked";
      title = "Meta token not verified yet — the sync will check it on the next cycle.";
    } else if (ageMin !== null && ageMin > 120) {
      tone = "warn";
      label = "Meta: sync stale";
      title = `Token OK, but last verified ${Math.round(ageMin / 60)}h ago — the sync worker may be down.`;
    } else {
      tone = "ok";
      label = tierLabel ? `Meta OK · ${tierLabel}` : "Meta OK";
      const checked = data.checkedAt
        ? ` · checked ${new Date(data.checkedAt).toLocaleTimeString()}`
        : "";
      title = `Meta app + system token OK${tierLabel ? ` · ${tierLabel} rate limits` : ""}${checked}`;
    }
  }

  return (
    <div
      title={title}
      className="flex items-center gap-2 rounded-md px-2 py-1 text-[11px] text-muted-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
    >
      <span className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} />
      <span className="truncate group-data-[collapsible=icon]:hidden">{label}</span>
    </div>
  );
}
