import { test, expect, beforeEach } from "bun:test";
import { sql as dsql } from "drizzle-orm";
import { deriveKpis, deriveRoas } from "@/server/agg";
import { db, schema } from "@/db/client";
import { fetchAccounts, fetchBusinessSummary } from "./dashboard";

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
  const accts = await fetchAccounts();
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
