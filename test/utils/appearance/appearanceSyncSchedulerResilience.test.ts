import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import type { AppearanceMode } from "../../../src/models";
import type { AppearanceConfig } from "../../../src/server/appearanceManager";
import { AppearanceSyncScheduler } from "../../../src/utils/appearance/AppearanceSyncScheduler";
import { FakeTimer } from "../../fakes/FakeTimer";

function makeTarget(incarnation: number): BootedDevice & { incarnation: number } {
  return { deviceId: "emulator-5554", name: "emulator-5554", platform: "android", incarnation };
}

function makeScheduler(
  targets: () => (BootedDevice & { incarnation?: number })[],
  apply: (device: BootedDevice, mode: AppearanceMode) => Promise<void>,
): AppearanceSyncScheduler {
  return new AppearanceSyncScheduler(new FakeTimer(), {
    getConfig: async () => ({ syncWithHost: true }) as AppearanceConfig,
    resolveMode: async () => "dark",
    getTargets: targets,
    apply,
  });
}

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

  test("syncs a same-serial replacement with a new incarnation", async () => {
    let target = makeTarget(1);
    const applied: BootedDevice[] = [];
    const scheduler = makeScheduler(
      () => [target],
      async (device) => {
        applied.push(device);
      },
    );

    await scheduler.trigger();
    target = makeTarget(2);
    await scheduler.trigger();

    expect(applied).toHaveLength(2);
    await scheduler.stop();
  });

  test("stop waits for an in-flight apply and prevents later targets", async () => {
    let finishApply: (() => void) | undefined;
    const applied: BootedDevice[] = [];
    const targets = [makeTarget(1), { ...makeTarget(2), deviceId: "emulator-5556" }];
    const scheduler = makeScheduler(
      () => targets,
      async (device) => {
        applied.push(device);
        await new Promise<void>((resolve) => {
          finishApply = resolve;
        });
      },
    );

    const tick = scheduler.trigger();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = scheduler.stop();
    expect(finishApply).toBeDefined();
    finishApply?.();
    await stopping;
    await tick;
    expect(applied).toHaveLength(1);
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });
});
