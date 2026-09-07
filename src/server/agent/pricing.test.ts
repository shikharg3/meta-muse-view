import { test, expect } from "bun:test";
import { costUsd } from "./pricing";

test("blends base, output, and cache-write rates", () => {
  // (10000*5 + 2000*25 + 4000*5*1.25) / 1e6 = (50000+50000+25000)/1e6
  expect(
    costUsd("claude-opus-5", { input: 10000, output: 2000, cacheWrite: 4000, cacheRead: 0 }),
  ).toBeCloseTo(0.125, 4);
});

test("charges cache reads at 0.1x the input rate", () => {
  // 10000*5*0.1 / 1e6
  expect(
    costUsd("claude-opus-5", { input: 0, output: 0, cacheWrite: 0, cacheRead: 10000 }),
  ).toBeCloseTo(0.005, 4);
});

test("unknown model falls back to opus pricing", () => {
  expect(
    costUsd("made-up", { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 }),
  ).toBeCloseTo(5, 4);
});
