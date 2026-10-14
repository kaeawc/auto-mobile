import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const device = { platform: "android" as const, deviceId: "fake-device", name: "Fake device" };
const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  PlatformDeviceManagerFactory.reset();
});

async function harness(failures: number, baseline = false, mixedFailure = false) {
  const timer = new FakeTimer();
  const markers = new FakeDeviceHealthMarkers(timer);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  let calls = 0;
  let remainingFailures = failures;
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    () => ({
      restore: async () => {
        calls++;
        if (remainingFailures-- > 0) {
          return {
            status: "failed" as const,
            ...(mixedFailure
              ? { baselineSettings: [{ setting: "stay_on_while_plugged_in" as const, value: "0" }] }
              : {}),
            failures: [
              { setting: "screen_off_timeout" as const, error: "restore unavailable" },
              ...(!mixedFailure
                ? [{ setting: "stay_on_while_plugged_in" as const, error: "write rejected" }]
                : []),
            ],
          };
        }
        if (baseline) {
          return {
            status: "restored_to_baseline" as const,
            settings: [{ setting: "screen_off_timeout" as const, value: "60000" }],
          };
        }
        return { status: "restored" as const };
      },
    }),
  );
  manager.stopCleanupTimer();
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [device]);
  PlatformDeviceManagerFactory.setInstance(utils);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "outcome-test", {
      timer,
      deviceManager: utils,
      deviceHealthMarkers: markers,
    }),
  );
  cleanups.push(() => {
    manager.stopCleanupTimer();
    timer.reset();
    pool.releaseDeviceClaimsForShutdown();
    warn.mockRestore();
  });
  await pool.initializeWithDevices([device]);
  await pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  manager.setKeepScreenAwake("old", { applied: true, method: "svc", svcWasEnabled: false });
  const step = async (ms: number) => {
    await timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer));
    await drainUntilQuiescent(timer);
  };
  const release = async () => {
    await manager.releaseSession("old");
    await pool.releaseDevice(device.deviceId, "old");
    await step(0);
  };
  return {
    timer,
    markers,
    manager,
    pool,
    warn,
    step,
    release,
    get calls() {
      return calls;
    },
    succeed() {
      remainingFailures = 0;
    },
  };
}

// Keep fixture construction outside the 15 ms behavior budget; each scenario owns a fresh pool.
const fixtures = new Map<string, Awaited<ReturnType<typeof harness>>>();
beforeAll(async () => {
  for (const failures of [1, 2, Infinity]) {
    fixtures.set(String(failures), await harness(failures));
  }
  fixtures.set("mixed", await harness(1, false, true));
  fixtures.set("mixed-final", await harness(Infinity, false, true));
  fixtures.set("retry-baseline", await harness(1, true));
  for (const baseline of [false, true]) {
    fixtures.set(String(baseline), await harness(0, baseline));
  }
});

test.each([1, 2])(
  "failed outcome retries %i times and completes without a marker",
  async (failures) => {
    const h = fixtures.get(String(failures))!;
    h.warn.mockClear();
    await h.release();
    expect(h.calls).toBe(1);
    expect(h.manager.getKeepAwakeRestoreReport("old")).toBeUndefined();
    for (let attempt = 0; attempt < failures; attempt++) {
      await h.step(250);
    }
    expect(h.calls).toBe(failures + 1);
    expect(h.manager.getKeepAwakeRestoreReport("old")).toBeUndefined();
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
    expect(h.manager.hasDeviceCleanupInProgress(device.deviceId)).toBe(false);
    expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
    expect(
      h.warn.mock.calls.some(([message]) =>
        String(message).includes(
          "screen_off_timeout: restore unavailable; stay_on_while_plugged_in: write rejected",
        ),
      ),
    ).toBe(true);
  },
);

test("bounded failed outcomes mark the slot unhealthy until recovery restores it", async () => {
  const h = fixtures.get(String(Infinity))!;
  h.warn.mockClear();
  await h.release();
  await h.step(250);
  await h.step(250);
  expect(h.calls).toBe(3);
  expect(h.manager.getKeepAwakeRestoreReport("old")).toEqual({
    status: "failed",
    settings: [
      { setting: "screen_off_timeout", error: "restore unavailable" },
      { setting: "stay_on_while_plugged_in", error: "write rejected" },
    ],
  });
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("keep-screen-awake");
  expect(h.pool.getStats().idle).toBe(0);
  await expect(
    h.pool.bindOrReuseDeviceSession("next", device.deviceId, "android"),
  ).rejects.toThrow();
  h.succeed();
  await h.step(1000);
  expect(h.calls).toBe(4);
  expect(h.manager.getKeepAwakeRestoreReport("old")).toBeUndefined();
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
  expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
});

test.each([false, true])(
  "restored or baseline outcome never retries (baseline=%s)",
  async (baseline) => {
    const h = fixtures.get(String(baseline))!;
    h.warn.mockClear();
    await h.release();
    await h.step(500);
    expect(h.calls).toBe(1);
    expect(h.manager.getKeepAwakeRestoreReport("old")).toEqual(
      baseline
        ? {
            status: "restored_to_baseline",
            settings: [{ setting: "screen_off_timeout", value: "60000" }],
          }
        : undefined,
    );
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
    expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
    if (baseline) {
      expect(
        h.warn.mock.calls.some(
          ([message]) =>
            String(message).includes("Keep-awake baseline applied for session old") &&
            String(message).includes(device.deviceId) &&
            String(message).includes("screen_off_timeout=60000"),
        ),
      ).toBe(true);
    }
  },
);

test("mixed failure reports the baseline writes in the retry error", async () => {
  const h = fixtures.get("mixed")!;
  h.warn.mockClear();
  await h.release();
  expect(
    h.warn.mock.calls.some(([message]) =>
      String(message).includes("baseline applied: stay_on_while_plugged_in=0"),
    ),
  ).toBe(true);
  await h.step(250);
  expect(h.calls).toBe(2);
});

test("final mixed failure includes both errors and successful baseline writes", async () => {
  const h = fixtures.get("mixed-final")!;
  await h.release();
  expect(h.manager.getKeepAwakeRestoreReport("old")).toBeUndefined();
  await h.step(250);
  expect(h.manager.getKeepAwakeRestoreReport("old")).toBeUndefined();
  await h.step(250);
  expect(h.manager.getKeepAwakeRestoreReport("old")).toEqual({
    status: "failed",
    settings: [
      { setting: "screen_off_timeout", error: "restore unavailable" },
      { setting: "stay_on_while_plugged_in", value: "0" },
    ],
  });
});

test("a retry restoring to baseline reports the final baseline", async () => {
  const h = fixtures.get("retry-baseline")!;
  await h.release();
  expect(h.manager.getKeepAwakeRestoreReport("old")).toBeUndefined();
  await h.step(250);
  expect(h.manager.getKeepAwakeRestoreReport("old")).toEqual({
    status: "restored_to_baseline",
    settings: [{ setting: "screen_off_timeout", value: "60000" }],
  });
});
