import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

/**
 * Issue #2784: the appearance sync is a best-effort background task started via
 * fire-and-forget `void this.trigger()` in Daemon.start() and on an interval. A
 * failed appearance read (transient DB error, or a missing/malformed
 * appearance_configs row) must NOT float an unhandledRejection that crashes an
 * otherwise-healthy daemon into a restart loop — trigger() must swallow it.
 */
describe("AppearanceSyncScheduler resilience", () => {
  let triggerAppearanceSync: () => Promise<void>;

  beforeAll(async () => {
    mock.module("../../../src/server/appearanceManager", () => ({
      getAppearanceConfig: async () => {
        throw new Error("no such table: appearance_configs");
      },
      resolveAppearanceMode: async () => "dark",
    }));
    ({ triggerAppearanceSync } = await import(
      `../../../src/utils/appearance/AppearanceSyncScheduler.ts?resilience=${Date.now()}-${Math.random()}`
    ));
  });

  afterEach(() => {
    mock.restore();
  });

  test("triggerAppearanceSync resolves (does not reject) when the config read fails", async () => {
    // If trigger() re-threw, this await would reject and fail the test.
    await expect(triggerAppearanceSync()).resolves.toBeUndefined();
  });
});
