import { describe, expect, test } from "bun:test";
import { DefaultEmulatorOfflineRecovery } from "../../../src/utils/android-cmdline-tools/EmulatorOfflineRecovery";
import type { OfflineTracker } from "../../../src/utils/android-cmdline-tools/EmulatorReadinessPoller";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";

function recovery(): DefaultEmulatorOfflineRecovery {
  const timer = new FakeTimer();
  const adbFactory = new FakeAdbClientFactory();
  return new DefaultEmulatorOfflineRecovery({ timer: () => timer, adbFactory: () => adbFactory });
}

describe("DefaultEmulatorOfflineRecovery", () => {
  test("empty candidate sets never probe adb", async () => {
    expect(await recovery().getListedNonDeviceStatesAmong([])).toEqual(new Map());
    expect(await recovery().getOfflineDeviceIdsAmong([])).toEqual(new Set());
  });

  test("polling delay is capped at the post-recovery cadence once recovery was attempted", () => {
    const tracker: OfflineTracker = {
      deviceId: "emulator-5554",
      since: 0,
      state: "offline",
      recoveryAttempted: true,
    };
    const delay = recovery().nextPollingDelayMs(
      tracker,
      { freshProvision: true },
      "emulator-5554",
      1_000,
      { pollingIntervalMs: 30_000, remainingPollingTimeMs: 60_000 },
    );
    expect(delay).toBe(5_000);
  });

  test("polling delay is unchanged outside a fresh offline episode", () => {
    const tracker: OfflineTracker = { deviceId: null, since: null };
    expect(
      recovery().nextPollingDelayMs(tracker, undefined, undefined, 0, {
        pollingIntervalMs: 2_000,
        remainingPollingTimeMs: 60_000,
      }),
    ).toBe(2_000);
  });
});
