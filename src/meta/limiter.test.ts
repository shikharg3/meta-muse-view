import { test, expect } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Limiter } from "./limiter";

test("never exceeds max concurrency", async () => {
  const limiter = new Limiter(2);
  let active = 0;
  let peak = 0;
  const task = async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(10);
    active--;
  };
  await Promise.all(Array.from({ length: 6 }, () => limiter.run(task)));
  expect(peak).toBe(2);
});

test("returns each wrapped result", async () => {
  const limiter = new Limiter(3);
  const results = await Promise.all([1, 2, 3, 4].map((n) => limiter.run(async () => n * 2)));
  expect(results).toEqual([2, 4, 6, 8]);
});

test("min interval paces successive starts", async () => {
  const limiter = new Limiter(1, 20);
  const starts: number[] = [];
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) await limiter.run(async () => void starts.push(Date.now() - t0));
  expect(starts[2]).toBeGreaterThanOrEqual(35);
});
