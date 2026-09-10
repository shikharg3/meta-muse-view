import { test, expect } from "bun:test";
import {
  buildStatusLines,
  MAX_CYCLE_MIN,
  STALE_AFTER_MIN,
  WRITE_BACK_STALE_AFTER_MIN,
  type HealthInput,
} from "./health-lines";

const NOW = Date.parse("2026-08-31T12:00:00Z");
const minsAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

const healthy: HealthInput = {
  tokenValid: true,
  checkedAt: minsAgo(10),
  tier: "standard",
  note: null,
  notion: { ok: true, checkedAt: minsAgo(10), note: null },
  notionBudget: { ok: true, checkedAt: minsAgo(10), note: "51 updated, 39 unchanged" },
  // A core pass finished 10 min ago. Every existing assertion below is about the stamps' own ages,
  // so the cycle here is deliberately unremarkable and never supplies an excuse.
  syncCycle: { ok: true, checkedAt: minsAgo(10), note: "core: completed" },
};

const notionOf = (over: Partial<HealthInput>) =>
  buildStatusLines({ ...healthy, ...over }, NOW).find((l) => l.label.startsWith("Notion"));

/**
 * A worker that has stopped: no pass has stamped anything for hours, so the cycle cannot explain a
 * stale sub-service stamp away.
 *
 * Staleness tests have to say this explicitly. The token check and the `notion` read are stamped at
 * the TOP of a cycle, so a fresh cycle legitimately accounts for an old stamp — which is exactly
 * what `cycleExcuse` is for, and what these tests must opt out of to be about staleness at all.
 */
const workerDown: Pick<HealthInput, "syncCycle"> = {
  syncCycle: { ok: true, checkedAt: minsAgo(STALE_AFTER_MIN * 4), note: "core: completed" },
};

test("a healthy board reports one OK line naming both directions", () => {
  const lines = buildStatusLines(healthy, NOW);
  expect(lines).toHaveLength(2);
  expect(lines[0].tone).toBe("ok");
  expect(lines[1]).toMatchObject({ tone: "ok", label: "Notion OK" });
  expect(lines[1].title).toContain("sync");
  expect(lines[1].title).toContain("writes");
});

test("a failing write-back turns the Notion line red even while the read sync is green", () => {
  // The regression this line exists for. `notion` was ok for six days while `notion-budget` skipped
  // every cell, and the badge rendered only the read half — so the board silently went stale.
  const line = notionOf({
    notionBudget: {
      ok: false,
      checkedAt: minsAgo(20),
      note: '0 updated, 0 unchanged, 658 skipped — no "Account Status" column on this board',
    },
  })!;
  expect(line.tone).toBe("bad");
  expect(line.label).toBe("Notion: board writes failing");
  expect(line.title).toContain("658 skipped");
});

test("the read half is named first when both directions are failing", () => {
  // The write-back re-reads the same board, so a broken read is the likelier root cause.
  const line = notionOf({
    notion: { ok: false, checkedAt: minsAgo(20), note: "Notion 401: API token is invalid" },
    notionBudget: { ok: false, checkedAt: minsAgo(20), note: "0 updated" },
  })!;
  expect(line).toMatchObject({ tone: "bad", label: "Notion: sync failing" });
});

test("a failure outranks staleness rather than being masked by it", () => {
  const line = notionOf({
    notion: { ok: true, checkedAt: minsAgo(STALE_AFTER_MIN * 4), note: null },
    notionBudget: { ok: false, checkedAt: minsAgo(20), note: "column renamed" },
  })!;
  expect(line).toMatchObject({ tone: "bad", label: "Notion: board writes failing" });
});

test("the daily write-back is not called stale on the hourly threshold", () => {
  // `syncNotionDailyBudgets` runs only under runCycle({ full: true }), once per calendar day. Judged
  // by the hourly window it would sit amber ~22h out of every 24, and a badge that cries wolf daily
  // is a badge nobody reads — which is the exact failure this line exists to prevent.
  expect(
    notionOf({ notionBudget: { ok: true, checkedAt: minsAgo(STALE_AFTER_MIN + 60), note: null } })!
      .tone,
  ).toBe("ok");
  expect(
    notionOf({ notionBudget: { ok: true, checkedAt: minsAgo(23 * 60), note: null } })!.tone,
  ).toBe("ok");
  expect(
    notionOf({
      notionBudget: { ok: true, checkedAt: minsAgo(WRITE_BACK_STALE_AFTER_MIN + 60), note: null },
    })!,
  ).toMatchObject({ tone: "warn", label: "Notion: board writes stale" });
});

test("staleness is judged against each half's own window, not one shared clock", () => {
  // A 35h-old write-back is healthy; a 2.5h-old read sync is not. Comparing raw ages would invert it.
  expect(
    notionOf({
      ...workerDown,
      notion: { ok: true, checkedAt: minsAgo(STALE_AFTER_MIN + 30), note: null },
      notionBudget: { ok: true, checkedAt: minsAgo(WRITE_BACK_STALE_AFTER_MIN - 60), note: null },
    })!,
  ).toMatchObject({ tone: "warn", label: "Notion: sync stale" });
  // Once both have blown their own window, the older one is the one worth naming.
  expect(
    notionOf({
      ...workerDown,
      notion: { ok: true, checkedAt: minsAgo(STALE_AFTER_MIN + 30), note: null },
      notionBudget: { ok: true, checkedAt: minsAgo(WRITE_BACK_STALE_AFTER_MIN * 3), note: null },
    })!,
  ).toMatchObject({ tone: "warn", label: "Notion: board writes stale" });
});

test("a service one minute inside its window is not called stale", () => {
  // Boundary: a run at exactly the threshold is a normal gap, not an outage.
  expect(
    notionOf({
      ...workerDown,
      notion: { ok: true, checkedAt: minsAgo(STALE_AFTER_MIN), note: null },
    })!.tone,
  ).toBe("ok");
  expect(
    notionOf({
      ...workerDown,
      notion: { ok: true, checkedAt: minsAgo(STALE_AFTER_MIN + 1), note: null },
    })!.tone,
  ).toBe("warn");
});

test("a write-back that has never run is said so, not folded into an OK claim", () => {
  const line = notionOf({ notionBudget: null })!;
  expect(line.tone).toBe("ok");
  expect(line.title).toContain("write-back has not run yet");
});

test("no Notion line at all until one of the two jobs has run", () => {
  const lines = buildStatusLines({ ...healthy, notion: null, notionBudget: null }, NOW);
  expect(lines).toHaveLength(1);
  expect(lines[0].label).toContain("Meta");
});

test("an unparseable timestamp reads as never-checked instead of painting the service green", () => {
  // `(now - NaN) / 60_000 > threshold` is false, so an unguarded comparison reports a dead service OK.
  const line = notionOf({ notionBudget: { ok: true, checkedAt: "not a date", note: null } })!;
  expect(line.tone).toBe("ok");
  expect(line.title).toContain("writes never");
});

test("loading shows a single idle line and never a false green", () => {
  const lines = buildStatusLines(null, NOW);
  expect(lines).toHaveLength(1);
  expect(lines[0].tone).toBe("idle");
});

test("Meta token problems still outrank everything on their own line", () => {
  const lines = buildStatusLines({ ...healthy, tokenValid: false, note: "blocked" }, NOW);
  expect(lines[0]).toMatchObject({ tone: "bad", label: "Meta: token invalid" });
  // …and do not suppress the Notion line beneath them.
  expect(lines[1].label).toBe("Notion OK");
});

test("a never-verified token reads as unknown rather than invalid", () => {
  const lines = buildStatusLines({ ...healthy, tokenValid: null, checkedAt: null }, NOW);
  expect(lines[0]).toMatchObject({ tone: "idle", label: "Meta: not checked" });
});

test("a valid but long-unverified token warns that the worker may be down", () => {
  const lines = buildStatusLines(
    { ...healthy, ...workerDown, checkedAt: minsAgo(STALE_AFTER_MIN * 3) },
    NOW,
  );
  expect(lines[0]).toMatchObject({ tone: "warn", label: "Meta: sync stale" });
});

// ── A long pass is not an outage ────────────────────────────────────────────────────────────────
//
// Observed on 2026-09-10: the daily full pass ran 01:31 → 06:16 (4h45m on dev-tier pacing through
// 943 Meta "Service temporarily unavailable" retries). The token check and the `notion` read are
// stamped at the TOP of a cycle, so at 06:32 both were 301 minutes old and both badges read
// "stale" — while 203/203 accounts had insights, 0 errored, and the last refresh was 16 min old.
// The freshness signal for these two is really "when did the current pass start", and judging it
// on a window calibrated for the hourly core pass cried wolf every single day.

test("a full pass in flight does not make its own start stamps look stale", () => {
  const lines = buildStatusLines(
    {
      ...healthy,
      checkedAt: minsAgo(285),
      notion: { ok: true, checkedAt: minsAgo(285), note: null },
      notionBudget: { ok: true, checkedAt: minsAgo(30), note: "21 updated" },
      syncCycle: { ok: true, checkedAt: minsAgo(285), note: "full: running" },
    },
    NOW,
  );
  expect(lines[0].tone).toBe("ok");
  expect(lines[0].title).toContain("full sync pass has been running");
  expect(lines[1]).toMatchObject({ tone: "ok", label: "Notion OK" });
});

test("the production case: 301-minute stamps, full pass finished 16 minutes ago", () => {
  const lines = buildStatusLines(
    {
      ...healthy,
      tier: "development",
      checkedAt: minsAgo(301),
      notion: { ok: true, checkedAt: minsAgo(301), note: null },
      notionBudget: { ok: true, checkedAt: minsAgo(16), note: "21 updated, 50 unchanged" },
      syncCycle: { ok: true, checkedAt: minsAgo(16), note: "full: completed" },
    },
    NOW,
  );
  expect(lines.map((l) => l.tone)).toEqual(["ok", "ok"]);
  expect(lines[0].label).toBe("Meta OK · Dev tier");
});

test("a pass that claims to be running for ever is the alarm, not an excuse", () => {
  // A worker killed mid-pass leaves `sync-cycle` reading "running" indefinitely. Past MAX_CYCLE_MIN
  // that has to warn — suppressing it forever would hide the exact outage the window exists for.
  const stuck = (age: number) =>
    buildStatusLines(
      {
        ...healthy,
        checkedAt: minsAgo(age),
        notion: { ok: true, checkedAt: minsAgo(age), note: null },
        syncCycle: { ok: true, checkedAt: minsAgo(age), note: "full: running" },
      },
      NOW,
    );
  expect(stuck(MAX_CYCLE_MIN - 1)[0].tone).toBe("ok");
  expect(stuck(MAX_CYCLE_MIN + 1)[0]).toMatchObject({ tone: "warn", label: "Meta: sync stale" });
});

test("a failed cycle never excuses a stale stamp", () => {
  // `ok: false` means the pass itself reported a problem, so it cannot vouch for anything.
  const lines = buildStatusLines(
    {
      ...healthy,
      checkedAt: minsAgo(300),
      notion: { ok: true, checkedAt: minsAgo(300), note: null },
      syncCycle: { ok: false, checkedAt: minsAgo(5), note: "Meta token invalid/expired" },
    },
    NOW,
  );
  expect(lines[0]).toMatchObject({ tone: "warn", label: "Meta: sync stale" });
});

test("the write-back keeps its own 36h window regardless of the cycle", () => {
  // The excuse covers the two stamps written at cycle start. A write-back that has not run for
  // days is a real failure and a running pass must not paper over it.
  const line = notionOf({
    notionBudget: { ok: true, checkedAt: minsAgo(WRITE_BACK_STALE_AFTER_MIN + 60), note: null },
    syncCycle: { ok: true, checkedAt: minsAgo(120), note: "full: running" },
  })!;
  expect(line).toMatchObject({ tone: "warn", label: "Notion: board writes stale" });
});
