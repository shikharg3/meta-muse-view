import { test, expect } from "bun:test";
import { allOps } from "./ops";

/**
 * The client-reachable surface, pinned.
 *
 * `src/server/api/http.ts` authorises a `PORTAL_API_TOKEN` caller to invoke any op whose name
 * starts with `portal` — the prefix *is* the allowlist. So this list is not documentation, it is
 * the set of operations an agency CUSTOMER can call against production data.
 *
 * It is asserted as exact set equality rather than a subset for the two failures that matter, and
 * only equality catches the second:
 *
 * 1. A new `portal*` op widens what customers can reach. That must be a deliberate, reviewed act,
 *    visible as a line in this diff, not a side effect of adding an export to a module.
 * 2. A staff op accidentally named `portalSomething` — say an internal "portal admin" op that
 *    manages grants or sets commission rates — becomes client-callable the moment it is registered,
 *    with no gate left to fail. A subset check would happily pass while shipping it. Here it breaks
 *    the build.
 *
 * Staff ops that administer the portal therefore must NOT be named `portal*`; the convention is a
 * different verb prefix (`adminPortal*`), and this test is what enforces it.
 */
const CLIENT_REACHABLE_OPS = [
  "portalBootstrap",
  "portalBreakdowns",
  "portalCampaign",
  "portalCampaigns",
  "portalCreatives",
  "portalOverview",
  "portalReport",
] as const;

test("the portal token reaches exactly the reviewed client-facing ops", () => {
  const exposed = allOps()
    .map((o) => o.name)
    .filter((n) => n.startsWith("portal"))
    .sort();

  expect(exposed).toEqual([...CLIENT_REACHABLE_OPS]);
});
