import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { allOps, lookupOp, MODULES } from "./ops";

/**
 * The op table is the only thing standing between the Base44 frontend and a `404` on every call,
 * and it has already failed once in a way no in-process assertion caught: built with side-effect
 * `import "./x"` lines, the bundler dropped every registration because `package.json` declares
 * `"sideEffects": false`, so `.output/` served an empty registry while `bun run` served all 99.
 *
 * The table is explicit now, which makes that class of failure impossible. What remains possible is
 * adding a module under `ops/` and forgetting to list it in `MODULES` — silently unreachable ops.
 * That is what the first test catches.
 */
describe("op table", () => {
  test("every ops module is wired into MODULES", () => {
    const onDisk = readdirSync(join(import.meta.dir, "ops"))
      .filter((f) => f.endsWith(".ts") && f !== "index.ts")
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();

    // MODULES keys are camelCase, the files kebab-case.
    const wired = Object.keys(MODULES)
      .map((k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))
      .sort();

    expect(wired).toEqual(onDisk);
  });

  test("resolves ops by the name the frontend calls", () => {
    for (const name of [
      "getOverview",
      "listInfraProfiles",
      "saveInfraProfile",
      "getFinance",
      "adminListConversations",
      "generateClientReport",
      "getSyncStatus",
    ]) {
      expect(lookupOp(name)?.name).toBe(name);
    }
  });

  test("op names are unique and non-empty", () => {
    const names = allOps().map((o) => o.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => n === "")).toEqual([]);
  });

  test("mutating ops are not advertised as cacheable reads", () => {
    for (const name of ["saveInfraProfile", "resetAndResync", "deleteUser", "startReportRun"]) {
      expect(lookupOp(name)?.mode).toBe("write");
    }
  });

  test("input is validated, not trusted", async () => {
    // The wrappers this replaced used `(d: T) => d` as their "validator", which checked nothing at
    // runtime — fine when the only caller was bundled from the same tree, not fine over HTTP.
    await expect(lookupOp("getOverview")?.run({ days: "thirty" })).rejects.toThrow();
    await expect(lookupOp("getOverview")?.run({ days: 30, from: "2026-9-1" })).rejects.toThrow();
  });
});
