import { test, expect } from "bun:test";
import { isAdmin, isSuperadmin } from "./roles";

test("isAdmin accepts admin AND superadmin; isSuperadmin only superadmin", () => {
  expect(isAdmin("superadmin")).toBe(true);
  expect(isAdmin("admin")).toBe(true);
  expect(isAdmin("member")).toBe(false);
  expect(isAdmin(null)).toBe(false);
  expect(isAdmin(undefined)).toBe(false);

  expect(isSuperadmin("superadmin")).toBe(true);
  expect(isSuperadmin("admin")).toBe(false);
  expect(isSuperadmin("member")).toBe(false);
  expect(isSuperadmin(null)).toBe(false);
});
