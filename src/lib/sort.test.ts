import { test, expect } from "bun:test";
import { sortByKey } from "./sort";

const rows = [
  { name: "beta", spend: 5, disabledSince: null as string | null },
  { name: "alpha", spend: 10, disabledSince: "2026-06-01" },
  { name: "gamma", spend: 1, disabledSince: "2026-05-01" },
];

test("sorts numbers numerically in both directions", () => {
  expect(sortByKey(rows, "spend", "desc").map((r) => r.spend)).toEqual([10, 5, 1]);
  expect(sortByKey(rows, "spend", "asc").map((r) => r.spend)).toEqual([1, 5, 10]);
});

test("sorts strings via localeCompare", () => {
  expect(sortByKey(rows, "name", "asc").map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
});

test("ISO dates sort chronologically and blanks always sink to the bottom", () => {
  // desc: newest first, null last (not first) despite descending
  expect(sortByKey(rows, "disabledSince", "desc").map((r) => r.disabledSince)).toEqual([
    "2026-06-01",
    "2026-05-01",
    null,
  ]);
  // asc: oldest first, null still last
  expect(sortByKey(rows, "disabledSince", "asc").map((r) => r.disabledSince)).toEqual([
    "2026-05-01",
    "2026-06-01",
    null,
  ]);
});

test("does not mutate the input array", () => {
  const before = rows.map((r) => r.spend);
  sortByKey(rows, "spend", "asc");
  expect(rows.map((r) => r.spend)).toEqual(before);
});
