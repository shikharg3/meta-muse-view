import { isOp, type Op } from "../registry";
import * as accountStatus from "./account-status";
import * as activity from "./activity";
import * as alerts from "./alerts";
import * as auth from "./auth";
import * as checkin from "./checkin";
import * as clients from "./clients";
import * as conversations from "./conversations";
import * as dashboard from "./dashboard";
import * as finance from "./finance";
import * as health from "./health";
import * as infrastructure from "./infrastructure";
import * as reportCatalog from "./report-catalog";
import * as reports from "./reports";
import * as settings from "./settings";
import * as status from "./status";

/**
 * The op table, built by walking these module namespaces.
 *
 * It used to be a side-effect registry — each module called `defineOp`, which pushed into a shared
 * `Map`, and this file was a list of bare `import "./x"` lines. That worked under `bun run` and
 * shipped a **completely empty registry in the production bundle**: `package.json` sets
 * `"sideEffects": false`, so the bundler is entitled to drop an import whose only purpose is a
 * side effect, and it did. Every op answered `unknown_op` in `.output/`, while every in-process
 * test passed. Referencing the namespaces as values is what makes them load-bearing.
 *
 * Adding a module means adding it to `MODULES`. `registry.test.ts` fails if a file in this
 * directory is missing from that list, because forgetting it is the one mistake this shape allows.
 */
const MODULES: Record<string, unknown> = {
  accountStatus,
  activity,
  alerts,
  auth,
  checkin,
  clients,
  conversations,
  dashboard,
  finance,
  health,
  infrastructure,
  reportCatalog,
  reports,
  settings,
  status,
};

function build(): Map<string, Op> {
  const table = new Map<string, Op>();
  for (const [moduleName, module] of Object.entries(MODULES)) {
    for (const exported of Object.values(module as Record<string, unknown>)) {
      if (!isOp(exported)) continue;
      const clash = table.get(exported.name);
      if (clash) {
        throw new Error(
          `Duplicate op name "${exported.name}" — found again in ops/${moduleName}. Op names are a flat namespace.`,
        );
      }
      table.set(exported.name, exported);
    }
  }
  return table;
}

const OPS = build();

export function lookupOp(name: string): Op | undefined {
  return OPS.get(name);
}

/** Every op, for the `_ops` manifest and the registry test. */
export function allOps(): Op[] {
  return [...OPS.values()];
}

export { MODULES };
