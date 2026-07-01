import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * Issue #2784: the appearance sync is a best-effort background task started via
 * fire-and-forget `void this.trigger()` in Daemon.start() and on an interval. A
 * failed appearance read (transient DB error, or a missing/malformed
 * appearance_configs row) must NOT float an unhandledRejection that crashes an
 * otherwise-healthy daemon into a restart loop — trigger() must swallow it.
 */
describe("AppearanceSyncScheduler resilience", () => {
  afterEach(() => {
    mock.restore();
  });

  test("triggerAppearanceSync resolves (does not reject) when the config read fails", async () => {
    mock.module("../../../src/server/appearanceManager", () => ({
      getAppearanceConfig: async () => {
        throw new Error("no such table: appearance_configs");
      },
      resolveAppearanceMode: async () => "dark",
    }));

    const { triggerAppearanceSync } = await import(
      `../../../src/utils/appearance/AppearanceSyncScheduler.ts?resilience=${Date.now()}-${Math.random()}`
    );

    // If trigger() re-threw, this await would reject and fail the test.
    await expect(triggerAppearanceSync()).resolves.toBeUndefined();
  });
});
