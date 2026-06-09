import { test, expect, beforeEach } from "bun:test";
import { sql as dsql } from "drizzle-orm";
import { accountStatus, deriveKpis, deriveRoas } from "@/server/agg";
import { db, schema } from "@/db/client";
import { fetchAccounts, fetchBusinessSummary, searchEntities } from "./dashboard";

test("deriveKpis computes ratios from summed totals", () => {
  const k = deriveKpis({ spend: 100, impressions: 1000, clicks: 50, conversions: 10, revenue: 300, reach: 800 });
  expect(k.ctr).toBeCloseTo(5);      // 50/1000*100
  expect(k.cpc).toBeCloseTo(2);      // 100/50
  expect(k.cpm).toBeCloseTo(100);    // 100/1000*1000
  expect(k.roas).toBeCloseTo(3);     // 300/100
  expect(k.frequency).toBeCloseTo(1.25); // 1000/800
});

test("deriveRoas guards divide-by-zero", () => {
  expect(deriveRoas(0, 0)).toBe(0);
  expect(deriveRoas(300, 100)).toBeCloseTo(3);
});

beforeEach(async () => {
  await db.execute(dsql`truncate table accounts, insights_daily cascade`);
});

test("fetchAccounts aggregates insights_daily into KPIs", async () => {
  const today = new Date().toISOString().slice(0, 10);
  await db.insert(schema.accounts).values({ id: "act_1", name: "Acc", currency: "USD", status: "ACTIVE" });
  await db.insert(schema.insightsDaily).values([
    { level: "account", entityId: "act_1", date: today, accountId: "act_1", spend: 100, impressions: 1000, clicks: 50, conversions: 10, conversionValues: 300, reach: 800 },
  ]);
  const accts = await fetchAccounts(30);
  const a = accts.find((x) => x.id === "act_1")!;
  expect(a.spend).toBeCloseTo(100);
  expect(a.roas).toBeCloseTo(3);     // 300/100
  expect(a.ctr).toBeCloseTo(5);      // 50/1000*100
  expect(a.spark.length).toBeGreaterThan(0);
});

test("fetchBusinessSummary returns live account count and configured business id", async () => {
  await db.execute(dsql`truncate table accounts, meta_credentials cascade`);
  await db.insert(schema.accounts).values([
    { id: "act_1", name: "A", currency: "USD", status: "ACTIVE" },
    { id: "act_2", name: "B", currency: "USD", status: "ACTIVE" },
  ]);
  await db.insert(schema.metaCredentials).values({ id: "singleton", businessId: "biz_42" });
  const s = await fetchBusinessSummary();
  expect(s.accountCount).toBe(2);
  expect(s.businessId).toBe("biz_42");
});

test("fetchBusinessSummary falls back to empty id and zero count when unconfigured", async () => {
  await db.execute(dsql`truncate table accounts, meta_credentials cascade`);
  const s = await fetchBusinessSummary();
  expect(s.accountCount).toBe(0);
  expect(s.businessId).toBe("");
});

test("accountStatus maps Meta numeric codes to labels", () => {
  expect(accountStatus("1")).toBe("ACTIVE");
  expect(accountStatus("2")).toBe("DISABLED");
  expect(accountStatus("101")).toBe("DISABLED");
  expect(accountStatus("3")).toBe("PENDING");
  expect(accountStatus("ACTIVE")).toBe("ACTIVE");
  expect(accountStatus(null)).toBe("ACTIVE");
  expect(accountStatus("999")).toBe("PENDING");
});

test("fetchAccounts respects the range window and maps status", async () => {
  await db.execute(dsql`truncate table accounts, insights_daily cascade`);
  await db.insert(schema.accounts).values({ id: "act_1", name: "Acc", currency: "USD", status: "1" });
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  await db.insert(schema.insightsDaily).values([
    { level: "account", entityId: "act_1", date: today, accountId: "act_1", spend: 100, impressions: 1000, clicks: 50, conversions: 10, conversionValues: 300, reach: 800 },
    { level: "account", entityId: "act_1", date: old, accountId: "act_1", spend: 999, impressions: 1, clicks: 1, conversions: 1, conversionValues: 1, reach: 1 },
  ]);
  const within7 = (await fetchAccounts(7)).find((x) => x.id === "act_1")!;
  const within90 = (await fetchAccounts(90)).find((x) => x.id === "act_1")!;
  expect(within7.spend).toBeCloseTo(100);
  expect(within90.spend).toBeCloseTo(1099);
  expect(within7.status).toBe("ACTIVE");
}, 20000);

test("searchEntities matches accounts by name/id and campaigns by name", async () => {
  await db.execute(dsql`truncate table accounts, campaigns cascade`);
  await db.insert(schema.accounts).values([
    { id: "act_42", name: "Vantage Media", currency: "USD", status: "1" },
    { id: "act_99", name: "Other Co", currency: "USD", status: "1" },
  ]);
  await db.insert(schema.campaigns).values({ id: "c1", accountId: "act_42", name: "Summer Sale", status: "ACTIVE" });
  expect((await searchEntities("vantage")).accounts.map((a) => a.id)).toEqual(["act_42"]);
  expect((await searchEntities("act_99")).accounts.map((a) => a.id)).toEqual(["act_99"]);
  expect((await searchEntities("summer")).campaigns.map((c) => c.id)).toEqual(["c1"]);
  expect((await searchEntities("")).accounts).toEqual([]);
}, 20000);
