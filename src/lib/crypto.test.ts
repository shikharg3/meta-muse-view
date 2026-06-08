import { test, expect } from "bun:test";
import { encryptSecret, decryptSecret } from "./crypto";

const KEY = "f3c2238d7f1860c1ba7f91813575b5ce63d79a9827692d8c127e093d2c97e9f0";

test("round-trips a secret", () => {
  const blob = encryptSecret("EAAB-super-secret-token", KEY);
  expect(decryptSecret(blob, KEY)).toBe("EAAB-super-secret-token");
});

test("uses a random IV so two encryptions differ", () => {
  expect(encryptSecret("x", KEY)).not.toBe(encryptSecret("x", KEY));
});

test("decryption fails with the wrong key (GCM auth)", () => {
  const blob = encryptSecret("x", KEY);
  expect(() => decryptSecret(blob, "b".repeat(64))).toThrow();
});

test("rejects a key that is not 32 bytes", () => {
  expect(() => encryptSecret("x", "short")).toThrow();
});
