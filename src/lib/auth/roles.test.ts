import { test, expect } from "bun:test";
import { isAdmin, isSuperadmin, roleChangeError } from "./roles";

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

const change = (over: Partial<Parameters<typeof roleChangeError>[0]> = {}) =>
  roleChangeError({
    actorId: "actor",
    actorRole: "superadmin",
    targetId: "target",
    targetRole: "member",
    targetEnvPinned: false,
    nextRole: "superadmin",
    ...over,
  });

test("a superadmin can elevate a member or an admin to superadmin", () => {
  expect(change({ targetRole: "member" })).toBeNull();
  expect(change({ targetRole: "admin" })).toBeNull();
});

test("a superadmin can demote another superadmin", () => {
  expect(change({ targetRole: "superadmin", nextRole: "admin" })).toBeNull();
});

test("an ordinary admin cannot GRANT superadmin", () => {
  // The privilege-escalation case: an admin must not be able to award itself a peer with more power.
  expect(change({ actorRole: "admin", nextRole: "superadmin" })).toMatch(/Only a superadmin/);
});

test("an ordinary admin cannot REMOVE superadmin", () => {
  // The takeover case: without this an admin could demote every superadmin and own the estate.
  expect(change({ actorRole: "admin", targetRole: "superadmin", nextRole: "member" })).toMatch(
    /Only a superadmin/,
  );
});

test("an ordinary admin can still move people between member and admin", () => {
  expect(change({ actorRole: "admin", targetRole: "member", nextRole: "admin" })).toBeNull();
  expect(change({ actorRole: "admin", targetRole: "admin", nextRole: "member" })).toBeNull();
});

test("members and signed-out callers are refused outright", () => {
  expect(change({ actorRole: "member" })).toBe("Forbidden");
  expect(change({ actorRole: null })).toBe("Forbidden");
  expect(change({ actorRole: undefined })).toBe("Forbidden");
});

test("nobody edits their own role, superadmin included", () => {
  // Also the guard that stops the last superadmin demoting itself into an estate with none.
  expect(change({ actorId: "same", targetId: "same", nextRole: "admin" })).toMatch(/your own role/);
});

test("an env-pinned superadmin cannot be demoted, because the pin would win at next login", () => {
  expect(change({ targetRole: "superadmin", targetEnvPinned: true, nextRole: "admin" })).toMatch(
    /AUTH_SUPERADMINS/,
  );
});

test("the env pin blocks only demotion, not other edits to that account", () => {
  // Re-granting the role it already has is a no-op, not a conflict with the pin.
  expect(
    change({ targetRole: "superadmin", targetEnvPinned: true, nextRole: "superadmin" }),
  ).toBeNull();
  // A pinned email that is NOT currently superadmin (e.g. added to the list but not yet logged in)
  // must stay promotable.
  expect(change({ targetRole: "member", targetEnvPinned: true, nextRole: "admin" })).toBeNull();
});
