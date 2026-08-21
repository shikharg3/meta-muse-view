import { test, expect } from "bun:test";
import { lifetimeSpend } from "./account-lifetime-spend";

/**
 * The rule behind the lifetime figure shown on the account page and returned by Ask.
 *
 * Worth defending because both inputs are plausible-looking numbers that mean different things: our
 * daily records are lifetime, Meta's counter is scoped to the current `spend_cap` cycle. Preferring
 * the wrong one is silent — it just renders a smaller number.
 */

test("our own daily record is the answer when Meta's cycle counter is behind it", () => {
  // The measured case that started this: Meta reported 0 for a disabled account holding $1,135.25.
  expect(lifetimeSpend(0, 113525)).toBe(113525);
  expect(lifetimeSpend(null, 113525)).toBe(113525);
});

test("Meta's counter is only a floor, for accounts whose insights are not backfilled yet", () => {
  // No daily rows at all: showing 0 would be worse than showing the counter.
  expect(lifetimeSpend(50000, 0)).toBe(50000);
});

test("a cycle counter that has been reset cannot drag the lifetime figure down", () => {
  // Meta resets `amount_spent` when a cap is topped up. An account that has spent $17,089.23 over its
  // life but only $1,000.01 against its current cap must still read as $17,089.23 here.
  expect(lifetimeSpend(100001, 1708923)).toBe(1708923);
});

test("agreement is a no-op, and zero stays zero", () => {
  expect(lifetimeSpend(4235, 4235)).toBe(4235);
  expect(lifetimeSpend(0, 0)).toBe(0);
  expect(lifetimeSpend(null, 0)).toBe(0);
});

test("the result is never below either input", () => {
  for (const [reported, recorded] of [
    [0, 0],
    [1, 999999],
    [999999, 1],
    [null, 12345],
    [500000, 500001],
  ] as [number | null, number][]) {
    const out = lifetimeSpend(reported, recorded);
    expect(out).toBeGreaterThanOrEqual(reported ?? 0);
    expect(out).toBeGreaterThanOrEqual(recorded);
  }
});
