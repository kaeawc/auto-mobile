import { afterEach, describe, expect, test } from "bun:test";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { installInMemoryNavManager } from "./navigationTestHarness";
import type { InMemoryNavManagerHarness } from "./navigationTestHarness";

/**
 * The harness installs a process-wide NavigationGraphManager singleton. If
 * dispose() failed to clear it, the in-memory manager (and its destroyed DB)
 * would leak into any sibling test file that resolves `getInstance()` in the
 * shared bun process (#4186).
 */
describe("installInMemoryNavManager", () => {
  let harness: InMemoryNavManagerHarness | undefined;

  afterEach(async () => {
    // Guarantee cleanup even if a test throws before its own dispose().
    if (harness) {
      try {
        await harness.dispose();
      } catch {
        // Already disposed in the test body; ignore.
      }
      harness = undefined;
    }
    NavigationGraphManager.resetInstance();
  });

  test("installs its manager as the getInstance() singleton", async () => {
    harness = await installInMemoryNavManager();

    expect(NavigationGraphManager.getInstance()).toBe(harness.manager);
  });

  test("dispose() clears the singleton so it cannot leak into a sibling file", async () => {
    harness = await installInMemoryNavManager();
    const installed = harness.manager;

    await harness.dispose();
    harness = undefined;

    // A later getInstance() must NOT hand back the disposed manager (whose DB is
    // destroyed); it must build a fresh one.
    expect(NavigationGraphManager.getInstance()).not.toBe(installed);
  });

  test("dispose() destroys the backing database", async () => {
    harness = await installInMemoryNavManager();
    const { db } = harness;

    await harness.dispose();
    harness = undefined;

    // The connection is gone, so any query against it now rejects.
    await expect(db.selectFrom("navigation_nodes").selectAll().execute()).rejects.toThrow();
  });
});
