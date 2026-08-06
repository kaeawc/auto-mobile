import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Drift-guard for the declared Bun version (issue #5026).
 *
 * `packageManager: "bun@X"` and `engines.bun: ">=X"` must name the SAME version.
 * They drifted once already (packageManager pinned 1.3.6 while the toolchain and
 * engines floor moved on), which is exactly the failure this pins. The test
 * asserts the two stay in lock-step rather than hard-coding a specific version,
 * so a legitimate future bump that moves BOTH lines together keeps it green while
 * a bump that touches only one goes red. The specific value (1.3.9, matching the
 * CI `setup-bun` pin) is locked from the CI side by
 * test/bats/release-workflow-wiring.bats.
 */
describe("Bun version pin consistency", () => {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  test("packageManager declares bun", () => {
    expect(typeof pkg.packageManager).toBe("string");
    expect(pkg.packageManager.startsWith("bun@")).toBe(true);
  });

  test("engines.bun is a >= floor", () => {
    expect(typeof pkg.engines?.bun).toBe("string");
    expect(pkg.engines.bun.startsWith(">=")).toBe(true);
  });

  test("packageManager version matches the engines.bun floor", () => {
    const packageManagerVersion = pkg.packageManager.slice("bun@".length);
    // Strip any leading range operator(s) (>=, >, ^, ~) from the engines floor.
    const enginesFloor = pkg.engines.bun.replace(/^[>=~^\s]+/, "");
    expect(packageManagerVersion).toBe(enginesFloor);
  });
});
