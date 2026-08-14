import { setTimeout as sleep } from "node:timers/promises";
import { runCycle, runBackfillCycle } from "./cycle";
import {
  runDailyCheckin,
  escalateUnanswered,
  pollTelegramOnce,
  flushPendingComments,
  sendDailyLists,
} from "./jobs/checkin";
import { berlinNow } from "@/lib/berlin-time";
import { CHECKIN_HOUR, ESCALATION_HOUR } from "@/lib/checkin";

const HOUR_MS = 3_600_000;
// Backfill always gets at least this much time each loop, so a slow daily full refresh can never
// starve it (the bug where refresh > 1h left backfill with a deadline already in the past).
const BACKFILL_MIN_MS = 20 * 60_000;
const today = () => new Date().toISOString().slice(0, 10);
// Minimum spacing between check-in iterations, matching `POLL_TIMEOUT_SEC` in ./jobs/checkin so the
// loop's cadence is the same whether or not the long-poll is actually blocking.
const CHECKIN_INTERVAL_MS = 30_000;

/**
 * SINGLE INSTANCE ASSUMPTION — read this before scaling the worker.
 *
 * Exactly one `meta-sync` process may run per database. Nothing in this repo takes an advisory or
 * row lock (no `pg_advisory_*`, no `FOR UPDATE`, no `SKIP LOCKED` anywhere in `src/`), so the only
 * thing keeping the two loops below from racing themselves is that there is one of each.
 *
 * The two daily gates would survive a second process — `checkin_runs.run_date` is claimed by an
 * in-transaction insert and `escalated_at` by a conditional update, so the loser of a race just sees
 * "already claimed" — but nothing else here would: the hourly refresh and the backfill would
 * duplicate every Meta API call against a shared rate limit, `pollTelegramOnce` advances one shared
 * `getUpdates` offset so two pollers would each consume updates the other needed, and
 * `flushPendingComments` selects its batch before it writes, so two flushers can post the same
 * comment onto a client's Notion card twice.
 *
 * A second replica, or a manual `bun run src/sync/worker.ts` beside the systemd unit, therefore
 * turns several theoretical races into real ones. Add a lock before adding a second instance.
 */

/**
 * The check-in loop runs INDEPENDENTLY of the sync loop below, and must keep doing so.
 * `runCycle({ full: true })` can occupy hours, so a 17:00 prompt sequenced behind it would arrive
 * around midnight. Each iteration long-polls Telegram for ~30s and then re-evaluates both time
 * gates, which puts scheduling precision at ~30s and costs nothing while idle.
 *
 * Re-entering the gates every 30s is intended: idempotency lives in the database (the `run_date`
 * claim and the `escalated_at` conditional update), not in this process. There is deliberately no
 * `lastRunDate` variable here — it would forget across a restart and would duplicate the claim
 * logic in a second place, where it could disagree with the first.
 *
 * With `TELEGRAM_BOT_TOKEN` unset, `telegram()` returns null and every send path short-circuits, so
 * the feature is inert rather than throwing; Settings surfaces the missing token. "Inert" has to mean
 * idle as well, which is what `CHECKIN_INTERVAL_MS` is for.
 */
async function checkinLoop(): Promise<void> {
  console.log("[checkin] loop started (17:00 prompt, 09:00 escalation, 30s poll)");
  for (;;) {
    const startedAt = Date.now();
    try {
      const now = new Date();
      const local = berlinNow(now);

      // Plan + send today's prompts. Non-null only on the iteration that wins the day's claim.
      if (local.hour >= CHECKIN_HOUR) {
        const run = await runDailyCheckin(now);
        if (run) {
          console.log(
            `[checkin] planned ${run.created} prompt(s) for ${local.date}: ` +
              `${run.sent} sent, ${run.failed} failed`,
          );
        }
      }

      // Escalate YESTERDAY's unanswered prompts. Non-null only on the iteration that wins the claim.
      if (local.hour >= ESCALATION_HOUR) {
        const escalated = await escalateUnanswered(now);
        if (escalated !== null)
          console.log(`[checkin] escalated ${escalated} unanswered prompt(s)`);
      }

      // Retry the list sends `runDailyCheckin` could not complete (a buyer whose list never went
      // out). A no-op once every buyer has a list message, which is the normal case after 17:00.
      if (local.hour >= CHECKIN_HOUR) {
        const lists = await sendDailyLists(local.date);
        if (lists.sent || lists.failed) {
          console.log(`[checkin] lists: ${lists.sent} sent, ${lists.failed} failed`);
        }
      }

      // Flush BEFORE polling, not after. `flushPendingComments` is bounded by a LIMIT, so even a
      // large backlog cannot starve the poll — it drains one batch per iteration and returns.
      // Polling first would instead park every answer behind a full 30s long-poll before its
      // comment reached Notion, and on the iteration a reply actually arrives that delay lands on
      // the very comment just created.
      const flushed = await flushPendingComments();
      if (flushed) console.log(`[checkin] flushed ${flushed} comment(s) to Notion`);

      // Normally paces the loop on its own: it blocks for POLL_TIMEOUT_SEC (30s) of long-poll.
      const updates = await pollTelegramOnce();
      if (updates) console.log(`[checkin] handled ${updates} Telegram update(s)`);
    } catch (e) {
      console.error("[checkin] loop iteration failed:", e);
      await sleep(5_000);
    }
    // A floor on the iteration, because the long-poll above cannot be relied on to provide one: with
    // no bot token `pollTelegramOnce` returns 0 IMMEDIATELY, and a failing `getUpdates` returns
    // nearly as fast. Without this, "inert" degrades into a busy-wait whose only brake is network
    // latency: measured against the throwaway smoke DB, this loop re-ran the escalation claim and the
    // flush credential lookup every ~2.2s over the SSH tunnel (~27 iterations/min against an
    // intended 2), and the droplet's Postgres is local to the worker, so there it would be faster
    // still. Costs nothing on the healthy path, where the long-poll has already spent the budget, so
    // the gates are re-evaluated every ~30s either way.
    const rest = startedAt + CHECKIN_INTERVAL_MS - Date.now();
    if (rest > 0) await sleep(rest);
  }
}

if (process.argv.includes("--once")) {
  // Manual one-shot: a full (all-metrics) refresh. Forced past the restart cooldown — someone ran
  // this on purpose.
  runCycle({ full: true, force: true })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[sync] cycle failed:", e);
      process.exit(1);
    });
} else {
  console.log("[sync] scheduler started (hourly CORE refresh + daily full + continuous backfill)");
  // Started ALONGSIDE the sync loop, never inside it — see checkinLoop's comment for why.
  void checkinLoop();
  void (async () => {
    // Seed with today so a restart/deploy does NOT re-trigger the ~4.5h full refresh; it runs once
    // at the next UTC day boundary, and nothing in the UI can force it: Settings → "Sync now" calls
    // triggerSync(), which passes `full: false`. The daily pass is therefore the only SCHEDULED
    // writer of the board's `🤖 Account Status`; "Sync Notion" re-runs that write on demand.
    let lastFullDay = today();
    for (;;) {
      const t0 = Date.now();
      // One full (all 219 metrics + breakdowns) refresh per calendar day; every other hour pulls
      // just the CORE KPIs so the refresh stays fast and leaves the hour to backfill.
      const full = today() !== lastFullDay;
      const ran = await runCycle({ full }).catch((e) => {
        console.error("[sync] refresh failed:", e);
        return true; // it started and failed; treat the slot as spent
      });
      if (full && ran) lastFullDay = today();
      // The backfill is skipped with it. If the cooldown just decided it is too soon to talk to
      // Meta, that applies to history too — otherwise a run of deploys still grants each restart a
      // fresh hour-long backfill budget, which is most of the traffic the refresh cooldown saves.
      if (ran) {
        // Backfill until the next hour, but ALWAYS at least BACKFILL_MIN_MS.
        await runBackfillCycle(Math.max(t0 + HOUR_MS, Date.now() + BACKFILL_MIN_MS)).catch((e) =>
          console.error("[sync] backfill failed:", e),
        );
      }
      // Always pace to the top of the hour, whether or not this tick did any work — a skipped
      // cycle must not turn the loop into a spin.
      const rest = t0 + HOUR_MS - Date.now();
      if (rest > 0) await sleep(rest);
    }
  })();
}
