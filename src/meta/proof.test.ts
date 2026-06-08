import { test, expect } from "bun:test";
import { appsecretProof } from "./proof";

test("computes the known HMAC-SHA256 hex vector", () => {
  expect(appsecretProof("test-token", "test-secret")).toBe(
    "4bd72343ca044f8aab1d98f07606cdb1cf47df0c089ff7b5b2df44e40d869970",
  );
});

test("is 64 hex chars and changes with the token", () => {
  const a = appsecretProof("a", "secret");
  const b = appsecretProof("b", "secret");
  expect(a).toHaveLength(64);
  expect(a).not.toBe(b);
});
