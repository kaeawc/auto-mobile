import { describe, expect, test } from "bun:test";
import { adbTransportRecoveredSignal } from "../../../src/utils/android-cmdline-tools/adbTransportRecoveredSignal";
import { DefaultEmulatorOfflineRecovery } from "../../../src/utils/android-cmdline-tools/EmulatorOfflineRecovery";
import type { OfflineTracker } from "../../../src/utils/android-cmdline-tools/EmulatorReadinessPoller";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
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
      { now: 1_000, pollingIntervalMs: 30_000, remainingPollingTimeMs: 60_000 },
    );
    expect(delay).toBe(5_000);
  });

  test("polling delay is unchanged outside a fresh offline episode", () => {
    const tracker: OfflineTracker = { deviceId: null, since: null };
    expect(
      recovery().nextPollingDelayMs(tracker, undefined, undefined, {
        now: 0,
        pollingIntervalMs: 2_000,
        remainingPollingTimeMs: 60_000,
      }),
    ).toBe(2_000);
  });

  test("a dispatched reconnect reports the transport recovered; a failed one does not (#17168)", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbClient();
    adb.setCommandError("-s emulator-5556 reconnect", new Error("adb: device not found"));
    const recovered: string[] = [];
    const subject = new DefaultEmulatorOfflineRecovery({
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(adb),
      transportRecovered: (deviceId) => recovered.push(deviceId),
    });
    await subject.recoverOfflineDevices(["emulator-5554", "emulator-5556"]);
    expect(recovered).toEqual(["emulator-5554"]);
  });

  test("without an injected callback, a reconnect reports adb_reconnect on the process signal", async () => {
    const recovered: string[] = [];
    const stop = adbTransportRecoveredSignal.subscribe((deviceId, reason) =>
      recovered.push(`${deviceId} ${reason}`),
    );
    try {
      await recovery().recoverOfflineDevices(["emulator-5554"]);
      expect(recovered).toEqual(["emulator-5554 adb_reconnect"]);
    } finally {
      stop();
    }
  });
});
