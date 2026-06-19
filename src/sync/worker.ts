import { setTimeout as sleep } from "node:timers/promises";
import { runCycle, runBackfillCycle } from "./cycle";

const HOUR_MS = 3_600_000;

if (process.argv.includes("--once")) {
  // Manual one-shot: just the fast refresh (the continuous backfill is a worker-only loop).
  runCycle()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[sync] cycle failed:", e);
      process.exit(1);
    });
} else {
  console.log("[sync] scheduler started (hourly refresh + continuous backfill)");
  void (async () => {
    for (;;) {
      const t0 = Date.now();
      // Fast 28-day refresh first, so recent numbers are fresh at the top of every hour —
      // independent of how far the slow historical backfill has progressed.
      await runCycle().catch((e) => console.error("[sync] refresh failed:", e));
      // Spend the rest of the hour advancing the historical backfill; it stops at the deadline
      // and resumes (from its checkpoints) after the next refresh.
      await runBackfillCycle(t0 + HOUR_MS).catch((e) =>
        console.error("[sync] backfill failed:", e),
      );
      const rest = t0 + HOUR_MS - Date.now();
      if (rest > 0) await sleep(rest);
    }
  })();
}
