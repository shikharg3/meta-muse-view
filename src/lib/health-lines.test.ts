import { test, expect } from "bun:test";
import {
  buildStatusLines,
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
};

const notionOf = (over: Partial<HealthInput>) =>
  buildStatusLines({ ...healthy, ...over }, NOW).find((l) => l.label.startsWith("Notion"));

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
      notion: { ok: true, checkedAt: minsAgo(STALE_AFTER_MIN + 30), note: null },
      notionBudget: { ok: true, checkedAt: minsAgo(WRITE_BACK_STALE_AFTER_MIN - 60), note: null },
    })!,
  ).toMatchObject({ tone: "warn", label: "Notion: sync stale" });
  // Once both have blown their own window, the older one is the one worth naming.
  expect(
    notionOf({
      notion: { ok: true, checkedAt: minsAgo(STALE_AFTER_MIN + 30), note: null },
      notionBudget: { ok: true, checkedAt: minsAgo(WRITE_BACK_STALE_AFTER_MIN * 3), note: null },
    })!,
  ).toMatchObject({ tone: "warn", label: "Notion: board writes stale" });
});

test("a service one minute inside its window is not called stale", () => {
  // Boundary: a run at exactly the threshold is a normal gap, not an outage.
  expect(
    notionOf({ notion: { ok: true, checkedAt: minsAgo(STALE_AFTER_MIN), note: null } })!.tone,
  ).toBe("ok");
  expect(
    notionOf({ notion: { ok: true, checkedAt: minsAgo(STALE_AFTER_MIN + 1), note: null } })!.tone,
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
  const lines = buildStatusLines({ ...healthy, checkedAt: minsAgo(STALE_AFTER_MIN * 3) }, NOW);
  expect(lines[0]).toMatchObject({ tone: "warn", label: "Meta: sync stale" });
});
