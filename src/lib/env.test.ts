import { test, expect } from "bun:test";
import { parseEnv } from "./env";

const KEY = "a".repeat(64);
const base = { APP_ENCRYPTION_KEY: KEY, DATABASE_URL: "postgres://localhost/meta" };

test("parses minimal env and defaults the API version", () => {
  const env = parseEnv(base);
  expect(env.META_API_VERSION).toBe("v25.0");
  expect(env.META_AD_ACCOUNT_IDS).toEqual([]);
});

test("splits ad account ids", () => {
  expect(parseEnv({ ...base, META_AD_ACCOUNT_IDS: "act_1, act_2" }).META_AD_ACCOUNT_IDS).toEqual(["act_1", "act_2"]);
});

test("throws when APP_ENCRYPTION_KEY is missing or wrong length", () => {
  expect(() => parseEnv({ DATABASE_URL: "x" })).toThrow();
  expect(() => parseEnv({ ...base, APP_ENCRYPTION_KEY: "short" })).toThrow();
});
