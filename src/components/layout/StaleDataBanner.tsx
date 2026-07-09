import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { getMetaHealth } from "@/lib/api/health";
import { fmtRelTime } from "@/lib/format";

// Refresh runs hourly, so a healthy last-refresh is < 1h old; 3h means several missed cycles.
const STALE_HOURS = 3;

/** Prominent, always-on banner shown when live data has gone stale (Meta sync blocked, worker down,
 *  …) so the freshness of every figure on the page is unambiguous during an outage. Auto-hides once a
 *  refresh succeeds. Shares the health badge's polling query. */
export function StaleDataBanner() {
  const { data } = useQuery({
    queryKey: ["meta-health"],
    queryFn: () => getMetaHealth(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  if (!data) return null; // don't flash while loading
  const last = data.lastRefreshAt;
  const ageHours = last ? (Date.now() - Date.parse(last)) / 3_600_000 : Infinity;
  if (last && ageHours < STALE_HOURS) return null; // data is fresh — no banner

  const exact = last
    ? new Date(last).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : null;
  return (
    <div className="flex items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive md:px-6">
      <AlertTriangle className="size-4 shrink-0" />
      {last ? (
        <span>
          Data last refreshed <strong>{fmtRelTime(last)}</strong>
          {exact ? ` (${exact})` : ""} — live Meta sync appears interrupted, so the figures below
          may be out of date.
        </span>
      ) : (
        <span>No successful data refresh has been recorded yet.</span>
      )}
    </div>
  );
}
