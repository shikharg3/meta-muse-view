import { test, expect } from "bun:test";
import { renderDailyReport, TELEGRAM_TEXT_LIMIT } from "./daily-report-render";
import type { EngagementRow } from "./daily-report";

const DAY = "2026-08-31"; // a Monday

const row = (over: Partial<EngagementRow> = {}): EngagementRow => ({
  clientId: "cl1",
  name: "wildcasino.ag (June/July 2026)",
  spend: [{ currency: "USD", amount: 1240.5 }],
  sortSpend: 1240.5,
  results: [{ label: "Purchases", count: 83 }],
  health: { status: "ACTIVE", reason: null },
  campaignCount: 2,
  trailingSpend: 500,
  notionStatus: "Live",
  ...over,
});

test("a healthy engagement renders name, spend, results and a bare tick", () => {
  const [msg] = renderDailyReport(DAY, [row()]);
  expect(msg).toContain("📊 Yesterday · Mon 31 Aug");
  expect(msg).toContain("1. wildcasino.ag (June/July 2026) — $1,240.50 · 83 Purchases ✅");
});

test("a dead engagement names the reason", () => {
  const [msg] = renderDailyReport(DAY, [
    row({ name: "Farside (2)", health: { status: "DISABLED", reason: "payment failed" } }),
  ]);
  expect(msg).toContain("Farside (2) — $1,240.50 · 83 Purchases · 🚫 DISABLED (payment failed)");
});

test("account counts never appear, however many accounts are dead", () => {
  // The old "1/3 accounts" fraction fired on nearly every line and said nothing actionable.
  const [msg] = renderDailyReport(DAY, [
    row({ health: { status: "ACTIVE", reason: null } }),
    row({ clientId: "cl2", health: { status: "DISABLED", reason: "Ads integrity policy" } }),
  ]);
  expect(msg).not.toMatch(/\d+\/\d+ accounts/);
});

test("an exhausted prepaid account reads as out of budget, not disabled", () => {
  const [msg] = renderDailyReport(DAY, [
    row({ health: { status: "OUT_OF_BUDGET", reason: null } }),
  ]);
  expect(msg).toContain("· 💸 OUT OF BUDGET");
  expect(msg).not.toContain("DISABLED");
});

test("mixed objectives are listed, mixed currencies are joined not summed", () => {
  const [msg] = renderDailyReport(DAY, [
    row({
      spend: [
        { currency: "USD", amount: 800 },
        { currency: "EUR", amount: 300 },
      ],
      results: [
        { label: "Leads", count: 27 },
        { label: "Purchases", count: 4 },
      ],
    }),
  ]);
  expect(msg).toContain("$800.00 + €300.00");
  expect(msg).toContain("27 Leads, 4 Purchases");
  expect(msg).not.toContain("1,100");
});

test("the total names engagements rather than claiming to be the day's spend", () => {
  const [msg] = renderDailyReport(DAY, [
    row({ spend: [{ currency: "USD", amount: 1000 }], sortSpend: 1000 }),
    row({ clientId: "cl2", name: "Farside (2)", spend: [{ currency: "USD", amount: 500 }] }),
  ]);
  expect(msg).toContain("Total: $1,500.00 across 2 engagements");
  expect(msg).not.toContain("Total spend");
});

test("one engagement is singular", () => {
  const [msg] = renderDailyReport(DAY, [row()]);
  expect(msg).toContain("across 1 engagement");
  expect(msg).not.toContain("1 engagements");
});

test("an empty day still says something", () => {
  const msgs = renderDailyReport(DAY, []);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toContain("No active campaigns.");
});

test("a single message carries no chunk counter", () => {
  const [msg] = renderDailyReport(DAY, [row()]);
  expect(msg).not.toContain("(1/1)");
});

test("a long list splits into numbered messages that all fit Telegram's limit", () => {
  const rows = Array.from({ length: 200 }, (_, i) =>
    row({
      clientId: `cl${i}`,
      name: `Engagement number ${i} with a fairly long board title (Aug/Sep 2026)`,
      spend: [{ currency: "USD", amount: 1000 - i }],
      sortSpend: 1000 - i,
    }),
  );
  const msgs = renderDailyReport(DAY, rows);
  expect(msgs.length).toBeGreaterThan(1);
  for (const m of msgs) expect(m.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  expect(msgs[0]).toContain(`(1/${msgs.length})`);
  expect(msgs.at(-1)).toContain(`(${msgs.length}/${msgs.length})`);
});

test("splitting loses no engagement and totals only once, on the last message", () => {
  const rows = Array.from({ length: 120 }, (_, i) =>
    row({
      clientId: `cl${i}`,
      name: `Engagement ${i} with a deliberately long padded board title here`,
      spend: [{ currency: "USD", amount: 10 }],
      sortSpend: 10,
    }),
  );
  const msgs = renderDailyReport(DAY, rows);
  const body = msgs.join("\n");
  for (let i = 1; i <= rows.length; i++) expect(body).toContain(`\n${i}. Engagement ${i - 1} `);
  expect(body.match(/Total: /g)).toHaveLength(1);
  expect(msgs.at(-1)).toContain("across 120 engagements");
});

test("an absurdly long board title cannot make a message unsendable", () => {
  const [msg] = renderDailyReport(DAY, [row({ name: "x".repeat(9000) })]);
  expect(msg!.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
});
