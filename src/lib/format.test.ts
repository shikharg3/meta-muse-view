import { test, expect } from "bun:test";
import { fmtCurrency, fmtNumber, fmtCompact, fmtPct } from "./format";

test("formatters match the previous mock-data behavior", () => {
  expect(fmtCurrency(1500)).toBe("$1,500");
  expect(fmtNumber(12345)).toBe("12,345");
  expect(fmtCompact(1500000)).toBe("1.5M");
  expect(fmtPct(3.14159)).toBe("3.14%");
});
