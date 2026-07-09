import { useQuery } from "@tanstack/react-query";
import { getMetaHealth } from "@/lib/api/health";

type Tone = "ok" | "warn" | "bad" | "idle";

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  idle: "bg-muted-foreground",
};

interface StatusLine {
  tone: Tone;
  label: string;
  title: string;
}

/** Always-visible health indicator in the sidebar footer: the Meta app + system token, and the
 *  background Notion client-board sync — so a dead token or a stalled/failing Notion sync is visible
 *  without opening Settings or reading server logs. Polls ~hourly. */
export function MetaStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ["meta-health"],
    queryFn: () => getMetaHealth(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const lines: StatusLine[] = [];

  if (isLoading || !data) {
    lines.push({ tone: "idle", label: "Meta: checking…", title: "App health" });
  } else {
    const ageMin = data.checkedAt ? (Date.now() - Date.parse(data.checkedAt)) / 60_000 : null;
    const tierLabel =
      data.tier === "standard" ? "Standard" : data.tier === "development" ? "Dev tier" : null;
    if (data.tokenValid === false) {
      lines.push({
        tone: "bad",
        label: "Meta: token invalid",
        title: data.note
          ? `Meta system-user token invalid/blocked: ${data.note}`
          : "Meta system-user token is invalid or blocked — check Settings.",
      });
    } else if (data.tokenValid === null) {
      lines.push({
        tone: "idle",
        label: "Meta: not checked",
        title: "Meta token not verified yet — the sync will check it on the next cycle.",
      });
    } else if (ageMin !== null && ageMin > 120) {
      lines.push({
        tone: "warn",
        label: "Meta: sync stale",
        title: `Token OK, but last verified ${Math.round(ageMin / 60)}h ago — the sync worker may be down.`,
      });
    } else {
      const checked = data.checkedAt
        ? ` · checked ${new Date(data.checkedAt).toLocaleTimeString()}`
        : "";
      lines.push({
        tone: "ok",
        label: tierLabel ? `Meta OK · ${tierLabel}` : "Meta OK",
        title: `Meta app + system token OK${tierLabel ? ` · ${tierLabel} rate limits` : ""}${checked}`,
      });
    }

    // Notion client-board sync (only once it has run at least once).
    if (data.notion) {
      const nAge = data.notion.checkedAt
        ? (Date.now() - Date.parse(data.notion.checkedAt)) / 60_000
        : null;
      if (!data.notion.ok) {
        lines.push({
          tone: "bad",
          label: "Notion: sync failing",
          title: data.notion.note
            ? `Notion client-board sync failing: ${data.notion.note}`
            : "Notion client-board sync is failing — re-share the board with the integration.",
        });
      } else if (nAge !== null && nAge > 120) {
        lines.push({
          tone: "warn",
          label: "Notion: stale",
          title: `Notion sync OK but last succeeded ${Math.round(nAge / 60)}h ago.`,
        });
      } else {
        lines.push({
          tone: "ok",
          label: "Notion OK",
          title: `Notion client sync OK${data.notion.checkedAt ? ` · ${new Date(data.notion.checkedAt).toLocaleTimeString()}` : ""}`,
        });
      }
    }
  }

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
