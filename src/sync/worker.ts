import { setTimeout as sleep } from "node:timers/promises";
import { runCycle, runBackfillCycle } from "./cycle";

const HOUR_MS = 3_600_000;
// Backfill always gets at least this much time each loop, so a slow daily full refresh can never
// starve it (the bug where refresh > 1h left backfill with a deadline already in the past).
const BACKFILL_MIN_MS = 20 * 60_000;
const today = () => new Date().toISOString().slice(0, 10);

if (process.argv.includes("--once")) {
  // Manual one-shot: a full (all-metrics) refresh.
  runCycle({ full: true })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[sync] cycle failed:", e);
      process.exit(1);
    });
} else {
  console.log("[sync] scheduler started (hourly CORE refresh + daily full + continuous backfill)");
  void (async () => {
    let lastFullDay = "";
    for (;;) {
      const t0 = Date.now();
      // One full (all 219 metrics + breakdowns) refresh per calendar day (and on every boot);
      // every other hour pulls just the CORE KPIs so the refresh stays fast.
      const full = today() !== lastFullDay;
      await runCycle({ full }).catch((e) => console.error("[sync] refresh failed:", e));
      if (full) lastFullDay = today();
      // Backfill until the next hour, but ALWAYS at least BACKFILL_MIN_MS.
      await runBackfillCycle(Math.max(t0 + HOUR_MS, Date.now() + BACKFILL_MIN_MS)).catch((e) =>
        console.error("[sync] backfill failed:", e),
      );
      const rest = t0 + HOUR_MS - Date.now();
      if (rest > 0) await sleep(rest);
    }
  })();
}
