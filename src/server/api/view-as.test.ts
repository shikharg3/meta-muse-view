import { test, expect } from "bun:test";
import { allOps } from "./ops";
import { VIEW_AS_OPS } from "./ops/portal-admin";

/**
 * "View as client" reaches exactly what a client reaches.
 *
 * `viewPortalAs` collects its ops from the portal op modules by hand — reading the op table from
 * inside an ops module would close an import cycle — so two drifts are possible, and set equality
 * catches both:
 *
 * 1. A `portal*` op added in a module `VIEW_AS_OPS` does not import. The preview would then answer
 *    `unknown_op` on whichever page uses it, and an admin checking a client's view would see an
 *    error the client never does.
 * 2. Anything that is not client-reachable. The op runs as the client and must never widen into a
 *    staff op; the prefix filter prevents it, and this pins the result.
 */
test("view-as dispatches exactly the ops the portal token reaches", () => {
  const clientReachable = allOps()
    .map((o) => o.name)
    .filter((n) => n.startsWith("portal"))
    .sort();

  expect([...VIEW_AS_OPS.keys()].sort()).toEqual(clientReachable);
});
