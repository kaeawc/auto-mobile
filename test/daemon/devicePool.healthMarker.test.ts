import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../../src/utils/logger";
import { DevicePool } from "../../src/daemon/devicePool";
import { CLOCK_RESTORE_TIMEOUT_MS, SessionManager } from "../../src/daemon/sessionManager";
import * as acquisitionRefusals from "../../src/daemon/deviceAcquisitionRefusals";
import { ActionableError } from "../../src/models/ActionableError";
import { DaemonState } from "../../src/daemon/daemonState";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { defaultDeviceClockRestoreRegistry } from "../../src/features/utility/DeviceClock";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const device = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" as const };
const other = { ...device, deviceId: "emulator-5556", name: "Pixel B" };
const flush = async () => {
  for (let index = 0; index < 100; index++) {
    await Promise.resolve();
  }
};
const managers: SessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.retireClockRestoration(device.deviceId);
    manager.stopCleanupTimer();
  }
  defaultDeviceClockRestoreRegistry.retire(device.deviceId);
  DaemonState.getInstance().reset();
  ToolRegistry.clearTools();
  PlatformDeviceManagerFactory.reset();
});

async function harness(count = 1) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  const markers = new InMemoryDeviceHealthMarkers(timer);
  let calls = 0;
  let succeeds = false;
  let paused: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const restore = async () => {
    calls++;
    if (paused) {
      await paused.promise;
    }
    if (!succeeds) {
      throw new Error("restore unavailable");
    }
  };
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    () => ({ restore }),
    () => ({ restore }),
    { networkCondition: () => ({ restore }), clock: () => ({ restore }) },
  );
  managers.push(manager);
  const utils = new FakeDeviceUtils();
  const devices = count === 1 ? [device] : [device, other];
  utils.setBootedDevices("android", devices);
  PlatformDeviceManagerFactory.setInstance(utils);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "health-test", {
      timer,
      deviceManager: utils,
      deviceHealthMarkers: markers,
    }),
  );
  await pool.initializeWithDevices(devices);
  return {
    timer,
    markers,
    manager,
    pool,
    get calls() {
      return calls;
    },
    succeed() {
      succeeds = true;
    },
    pause() {
      paused = Promise.withResolvers<void>();
    },
    resume() {
      paused?.resolve();
      paused = undefined;
    },
  };
}

async function abandon(
  h: Awaited<ReturnType<typeof harness>>,
  reason: "biometric-enrollment" | "network-condition",
) {
  await h.pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  if (reason === "biometric-enrollment") {
    h.manager.setBiometricEnrollment("old", { initialEnrollment: "not_enrolled" });
  } else {
    h.manager.setNetworkCondition("old", { initialProfile: "none" });
  }
  await h.manager.releaseSession("old");
  await h.pool.releaseDevice(device.deviceId, "old");
  await h.timer.advanceTimeAsync(250);
  await flush();
  await h.timer.advanceTimeAsync(250);
  await flush();
}

function setRestoreState(
  manager: SessionManager,
  reason: "biometric-enrollment" | "network-condition" | "clock",
) {
  if (reason === "biometric-enrollment") {
    manager.setBiometricEnrollment("old", { initialEnrollment: "not_enrolled" });
  } else if (reason === "network-condition") {
    manager.setNetworkCondition("old", { initialProfile: "none" });
  } else {
    manager.getSession("old")!.cacheData.clock = { initialAutomaticTime: 1, rootedByUs: false };
  }
}

for (const reason of ["biometric-enrollment", "network-condition", "clock"] as const) {
  test(`${reason} restores an untracked device and warns when no marker can be keyed`, async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = await harness();
    const mark = spyOn(h.markers, "mark");
    const clear = spyOn(h.markers, "clear");
    try {
      await h.pool.removeDevice(device.deviceId);
      clear.mockClear();
      await h.manager.createSession("old", device.deviceId, device.platform);
      setRestoreState(h.manager, reason);
      await expect(h.manager.releaseSession("old")).resolves.toBe(device.deviceId);
      expect(h.calls).toBe(1);
      // Becoming tracked later must not change the undefined capture or key a marker.
      await h.pool.addDevice(device);
      for (const delay of [250, 250]) {
        await h.timer.advanceTimeAsync(delay);
        await flush();
      }
      expect(h.calls).toBe(3);
      if (reason !== "clock") {
        expect(h.manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
      }
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `on ${device.deviceId} (${reason}); no health marker could be keyed because the device has no pool incarnation`,
        ),
      );
      expect(mark).not.toHaveBeenCalled();
      h.succeed();
      await h.timer.advanceTimeAsync(250);
      await flush();
      expect(h.calls).toBe(reason === "clock" ? 4 : 3);
      expect(clear).not.toHaveBeenCalled();
      expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
    } finally {
      warn.mockRestore();
      mark.mockRestore();
      clear.mockRestore();
    }
  });

  for (const current of [2, undefined]) {
    test(`${reason} skips retries after captured incarnation changes to ${current}`, async () => {
      const h = await harness();
      let incarnation: number | undefined = 1;
      h.manager.setDeviceHealthMarkers(
        h.markers,
        () => incarnation,
        () => true,
      );
      const mark = spyOn(h.markers, "mark");
      try {
        await h.manager.createSession("old", device.deviceId, device.platform);
        setRestoreState(h.manager, reason);
        h.pause();
        const release = h.manager.releaseSession("old");
        await flush();
        expect(h.calls).toBe(1);
        incarnation = current;
        h.resume();
        await release;
        for (const delay of [250, 250, 1000]) {
          await h.timer.advanceTimeAsync(delay);
          await flush();
        }
        expect(h.calls).toBe(1);
        expect(mark).not.toHaveBeenCalled();
      } finally {
        h.resume();
        mark.mockRestore();
      }
    });
  }

  test(`${reason} restores successfully with an unchanged incarnation`, async () => {
    const h = await harness();
    h.succeed();
    await h.pool.bindOrReuseDeviceSession("old", device.deviceId, device.platform);
    setRestoreState(h.manager, reason);
    await expect(h.manager.releaseSession("old")).resolves.toBe(device.deviceId);
    expect(h.calls).toBe(1);
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
  });
}

for (const reason of ["biometric-enrollment", "network-condition"] as const) {
  test(`${reason} exhaustion marks idle device and bounded recovery can clear it`, async () => {
    const h = await harness();
    await abandon(h, reason);
    expect(h.calls).toBe(3);
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toEqual({ reason, since: 1500 });
    expect(h.pool.getDevice(device.deviceId)?.status).toBe("idle");
    expect(h.pool.getStats().idle).toBe(0);
    await expect(h.pool.assignDeviceToSession("next", "android")).rejects.toThrow(ActionableError);
    await expect(h.pool.assignDeviceToSession("next", "android")).rejects.toThrow(
      `${device.deviceId}`,
    );
    await expect(h.pool.assignDeviceToSession("next", "android")).rejects.toThrow(reason);
    expect(h.manager.getSession("next")).toBeNull();
    h.succeed();
    await h.timer.advanceTimeAsync(1000);
    await flush();
    expect(h.calls).toBe(4);
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
    expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
  });
}

test("selection skips dirty device; exhausted recovery leaves it marked", async () => {
  const h = await harness(2);
  await abandon(h, "network-condition");
  expect(await h.pool.assignDeviceToSession("next", "android")).toBe(other.deviceId);
  for (const delay of [1000, 2000, 4000]) {
    await h.timer.advanceTimeAsync(delay);
    await flush();
  }
  expect(h.calls).toBe(6);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("network-condition");
});

test.each(["remove", "bump", "recreate"] as const)(
  "%s retires marker and background recovery",
  async (action) => {
    const h = await harness();
    await abandon(h, "biometric-enrollment");
    const incarnation = h.pool.getDeviceIncarnation(device.deviceId)!;
    if (action === "bump") {
      h.pool.bumpDeviceIncarnation(device.deviceId);
    } else {
      await h.pool.removeDevice(device.deviceId);
      if (action === "recreate") {
        await h.pool.addDevice(device);
      }
    }
    expect(h.markers.get(device.deviceId, incarnation)).toBeUndefined();
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
    await h.timer.advanceTimeAsync(10000);
    await flush();
    expect(h.calls).toBe(3);
  },
);

test("incarnation captured before initial restore prevents blaming replacement", async () => {
  const h = await harness();
  await h.pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  h.manager.setBiometricEnrollment("old", { initialEnrollment: "not_enrolled" });
  await h.manager.releaseSession("old");
  h.pool.bumpDeviceIncarnation(device.deviceId);
  await h.timer.advanceTimeAsync(1000);
  await flush();
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
  expect(h.calls).toBe(1);
});

for (const route of ["direct", "autolock", "setActiveDevice"] as const) {
  test(`${route} refuses marked device by id`, async () => {
    const previous = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    try {
      const h = await harness();
      await abandon(h, "network-condition");
      DaemonState.getInstance().initialize(h.manager, h.pool);
      registerUtilityTools();
      const acquire = () =>
        route === "direct"
          ? h.pool.bindOrReuseDeviceSession("next", device.deviceId, "android")
          : route === "autolock"
            ? h.pool.autolockDevice(device.deviceId, "android", "new-client")
            : ToolRegistry.getTool("setActiveDevice")!.handler({
                sessionUuid: "next",
                deviceId: device.deviceId,
                platform: "android",
              });
      await expect(acquire()).rejects.toBeInstanceOf(acquisitionRefusals.DeviceUnhealthyError);
      await expect(acquire()).rejects.toThrow("network-condition");
      await expect(acquire()).rejects.toThrow("killDevice");
      expect(h.pool.getDevice(device.deviceId)?.sessionId).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previous;
      }
    }
  });
}

test("TTL exhaustion marks through the same store, without racing a live owner", async () => {
  const h = await harness();
  await h.pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  h.manager.setNetworkCondition("old", { initialProfile: "none" });
  h.manager.scheduleNetworkConditionExpiry(h.manager.getSession("old")!, 1);
  await h.timer.advanceTimeAsync(1000);
  await flush();
  for (const delay of [250, 250, 1000, 2000, 4000]) {
    await h.timer.advanceTimeAsync(delay);
    await flush();
  }
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("network-condition");
  expect(h.calls).toBe(3);
  expect(await h.pool.bindOrReuseDeviceSession("old", device.deviceId, "android")).toBe("old");
  h.succeed();
  await h.manager.releaseSession("old");
  await h.pool.releaseDevice(device.deviceId, "old");
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
});

test("clock failure marks busy quarantine and successful retry clears it", async () => {
  const h = await harness();
  await h.pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  h.manager.getSession("old")!.cacheData.clock = { initialAutomaticTime: 1, rootedByUs: false };
  await h.manager.releaseSession("old");
  await h.pool.releaseDevice(device.deviceId, "old");
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toEqual({ reason: "clock", since: 1000 });
  expect(h.pool.getDevice(device.deviceId)?.status).toBe("busy");
  h.succeed();
  await h.timer.advanceTimeAsync(250);
  await flush();
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
  expect(h.pool.getDevice(device.deviceId)?.status).toBe("idle");
});

test("availableDevices surfaces unhealthy only for marked devices", async () => {
  const h = await harness(2);
  await abandon(h, "network-condition");
  DaemonState.getInstance().initialize(h.manager, h.pool);
  const response = await handleDaemonRequest(
    { id: "health", method: "daemon/availableDevices" },
    DaemonState.getInstance(),
  );
  expect(response.result?.devices).toEqual([
    expect.objectContaining({
      deviceId: device.deviceId,
      unhealthy: { reason: "network-condition", since: 1500 },
    }),
    expect.not.objectContaining({ unhealthy: expect.anything() }),
  ]);
});

test("timed-out background restore stops overlapping retries and retains the marker", async () => {
  const h = await harness();
  await abandon(h, "network-condition");
  h.pause();
  try {
    await h.timer.advanceTimeAsync(1000);
    await flush();
    expect(h.calls).toBe(4);
    await h.timer.advanceTimeAsync(10000);
    await flush();
    expect(h.calls).toBe(4);
    expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("network-condition");
    await expect(
      h.pool.bindOrReuseDeviceSession("next", device.deviceId, "android"),
    ).rejects.toThrow("network-condition");
  } finally {
    h.resume();
    await flush();
  }
});

test("clock timeout surfaces reason while the original restore remains quarantined", async () => {
  const h = await harness();
  await h.pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  h.manager.getSession("old")!.cacheData.clock = { initialAutomaticTime: 1, rootedByUs: false };
  h.pause();
  const release = h.manager.releaseSession("old");
  try {
    await flush();
    await h.timer.advanceTimeAsync(CLOCK_RESTORE_TIMEOUT_MS);
    await flush();
    await release;
    await h.pool.releaseDevice(device.deviceId, "old");
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toEqual({
      reason: "clock",
      since: 1000 + CLOCK_RESTORE_TIMEOUT_MS,
    });
    expect(h.pool.getStats().idle).toBe(0);
    await expect(h.pool.assignDeviceToSession("next", "android")).rejects.toThrow("clock");
    h.succeed();
    h.resume();
    await h.manager.getPendingDeviceCleanup(device.deviceId);
    await flush();
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
    expect(h.calls).toBe(1);
  } finally {
    h.resume();
    h.manager.retireClockRestoration(device.deviceId);
    await release;
  }
});

test("a TTL restore abandoned after its owner releases still marks the device", async () => {
  const h = await harness();
  await h.pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  h.manager.setNetworkCondition("old", { initialProfile: "none" });
  h.manager.scheduleNetworkConditionExpiry(h.manager.getSession("old")!, 1);
  await h.timer.advanceTimeAsync(1000);
  await flush();
  await h.manager.releaseSession("old");
  await h.pool.releaseDevice(device.deviceId, "old");
  expect(h.manager.getSession("old")).toBeNull();
  for (const delay of [250, 250]) {
    await h.timer.advanceTimeAsync(delay);
    await flush();
  }
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("network-condition");
  expect(h.pool.getDevice(device.deviceId)?.sessionId).toBeNull();
  expect(h.pool.getStats().idle).toBe(0);
  h.succeed();
  await h.timer.advanceTimeAsync(1000);
  await flush();
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
});

const APP_CLEANUP_RETRY_BUDGET_MS = 21_000;

async function allocationError(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
  const error = await h.pool.bindOrReuseDeviceSession("next", device.deviceId, "android").then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ActionableError);
  return error instanceof Error ? error.message : "";
}

test("an app-cleanup retry slower than the settings-restore deadline still clears the marker", async () => {
  const h = await harness();
  let finished = false;
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      await h.timer.sleep(5_000);
      finished = true;
    },
    APP_CLEANUP_RETRY_BUDGET_MS,
  );
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("app-cleanup");
  await h.timer.advanceTimeAsync(1_000);
  await flush();
  // Past the 1 s a settings restore is allowed, still inside the cleanup's own budget.
  await h.timer.advanceTimeAsync(2_000);
  await flush();
  expect(finished).toBe(false);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("app-cleanup");
  await h.timer.advanceTimeAsync(3_000);
  await flush();
  expect(finished).toBe(true);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
  expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
});

test("an app-cleanup retry that outlives its own budget retains the marker without overlapping retries", async () => {
  const h = await harness();
  let calls = 0;
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      calls++;
      await new Promise<void>(() => {});
    },
    APP_CLEANUP_RETRY_BUDGET_MS,
  );
  await h.timer.advanceTimeAsync(1_000);
  await flush();
  expect(calls).toBe(1);
  await h.timer.advanceTimeAsync(APP_CLEANUP_RETRY_BUDGET_MS + 10_000);
  await flush();
  expect(calls).toBe(1);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("app-cleanup");
});

test("allocating an app-cleanup device names the reason and the exact recovery", async () => {
  const h = await harness();
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      throw new Error("pm clear refused");
    },
    APP_CLEANUP_RETRY_BUDGET_MS,
  );
  for (const delay of [1_000, 2_000, 4_000]) {
    await h.timer.advanceTimeAsync(delay);
    await flush();
  }
  // Pinned: three attempts, then the marker is held for the device's incarnation.
  await h.timer.advanceTimeAsync(60_000);
  await flush();
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("app-cleanup");
  const message = await allocationError(h);
  expect(message).toContain("(app-cleanup, since");
  expect(message).toContain(
    "call killDevice with device { name: 'Pixel A', deviceId: 'emulator-5554', platform: 'android' }, then startDevice",
  );
});

test("the extra app-cleanup recovery text is absent for other health reasons", async () => {
  const h = await harness();
  await abandon(h, "network-condition");
  expect(await allocationError(h)).not.toContain("app-cleanup");
});

test("a timed-out background recovery that later completes clears the marker (#11145)", async () => {
  const h = await harness();
  let calls = 0;
  const slow = Promise.withResolvers<void>();
  // A recovery whose own body does not clear the marker: only the recovery loop can.
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      calls++;
      await slow.promise;
    },
    1_000,
  );
  await h.timer.advanceTimeAsync(1_000);
  await flush();
  expect(calls).toBe(1);
  // Past the 1 s deadline the command is still running: the device stays quarantined.
  await h.timer.advanceTimeAsync(1_000);
  await flush();
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("app-cleanup");
  slow.resolve();
  await flush();
  expect(calls).toBe(1);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
  expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
});

test("a timed-out background restore that later fails continues with a scaled deadline (#11145)", async () => {
  const h = await harness();
  await abandon(h, "network-condition");
  h.pause();
  await h.timer.advanceTimeAsync(1000);
  await flush();
  await h.timer.advanceTimeAsync(1000);
  await flush();
  const callsWhileInFlight = h.calls;
  // The slow command fails late; the next attempt must still run, never overlapping it.
  h.resume();
  await flush();
  expect(h.calls).toBe(callsWhileInFlight);
  h.succeed();
  h.pause();
  await h.timer.advanceTimeAsync(2000);
  await flush();
  expect(h.calls).toBe(callsWhileInFlight + 1);
  // Attempt 2 gets 2x the 1 s deadline: still within it after 1.5 s, then it completes.
  const warn = spyOn(logger, "warn");
  try {
    await h.timer.advanceTimeAsync(1500);
    await flush();
    h.resume();
    await flush();
    expect(
      warn.mock.calls.some(([message]) => String(message).startsWith("Device health recovery 2")),
    ).toBe(false);
  } finally {
    warn.mockRestore();
  }
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
});

test("a failed keep-awake restore quarantines the device until background recovery restores it (#11145)", async () => {
  const h = await harness();
  await h.pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  h.manager.setKeepScreenAwake("old", {
    applied: true,
    method: "svc",
    svcWasEnabled: false,
    originalStayOnWhilePluggedIn: "0",
  });
  await h.manager.releaseSession("old");
  await h.pool.releaseDevice(device.deviceId, "old");
  for (const delay of [250, 250]) {
    await h.timer.advanceTimeAsync(delay);
    await flush();
  }
  // The initial restore and both retries failed: the device must not go back to the pool awake.
  expect(h.calls).toBe(3);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("keep-screen-awake");
  expect(h.pool.getStats().idle).toBe(0);
  h.succeed();
  await h.timer.advanceTimeAsync(1000);
  await flush();
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
  expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
});

async function typedAllocationError(h: Awaited<ReturnType<typeof harness>>) {
  return h.pool.bindOrReuseDeviceSession("next", device.deviceId, "android").then(
    () => {
      throw new Error("expected refusal");
    },
    (error: unknown) => error,
  );
}

test("#12112 named unhealthy recovery has an exact shrinking bound", async () => {
  const h = await harness();
  await abandon(h, "network-condition");
  const error = await typedAllocationError(h);
  expect(error).toMatchObject({
    code: "device_unhealthy",
    deviceId: device.deviceId,
    reason: "network-condition",
    recovering: true,
    retryable: true,
    retryAfterMs: 13000,
    devices: [
      {
        deviceId: device.deviceId,
        reason: "network-condition",
        recovering: true,
        retryAfterMs: 13000,
      },
    ],
  });
  expect(error).toBeInstanceOf(acquisitionRefusals.DeviceUnhealthyError);
  await h.timer.advanceTimeAsync(137, flush);
  expect(await typedAllocationError(h)).toMatchObject({ retryAfterMs: 12863 });
  h.pause();
  try {
    await h.timer.advanceTimeAsync(863, flush);
    expect(await typedAllocationError(h)).toMatchObject({ retryAfterMs: 12000 });
    await h.timer.advanceTimeAsync(173, flush);
    expect(await typedAllocationError(h)).toMatchObject({ retryAfterMs: 11827 });
  } finally {
    h.resume();
    await flush();
  }
  expect(await typedAllocationError(h)).toMatchObject({ retryAfterMs: 11000 });
});

test("#12112 three dispatched failed attempts make the typed refusal permanent", async () => {
  const h = await harness();
  await abandon(h, "network-condition");
  for (const delay of [1000, 2000, 4000]) {
    await h.timer.advanceTimeAsync(delay, flush);
  }
  expect(h.calls).toBe(6);
  const error = await typedAllocationError(h);
  expect(error).toMatchObject({ code: "device_unhealthy", retryable: false, recovering: false });
  expect(error).toBeInstanceOf(acquisitionRefusals.DeviceUnhealthyError);
  if (!(error instanceof acquisitionRefusals.DeviceUnhealthyError)) {
    throw new Error("expected typed refusal");
  }
  expect(typeof error.retryAfterMs).not.toBe("number");
  expect(error.message).toContain("killDevice/startDevice");
  expect(error.message).toContain(
    "Background recovery has ended and the marker is held until the device is replaced (code device_unhealthy).",
  );
});

test("#12112 app-cleanup uses its own retry deadline and keeps the permanent remedy", async () => {
  const h = await harness();
  let calls = 0;
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      calls++;
      throw new Error("pm clear refused");
    },
    21000,
  );
  expect(await typedAllocationError(h)).toMatchObject({
    reason: "app-cleanup",
    retryAfterMs: 133000,
  });
  for (const delay of [1000, 2000, 4000]) {
    await h.timer.advanceTimeAsync(delay, flush);
  }
  expect(calls).toBe(3);
  const error = await typedAllocationError(h);
  expect(error).toMatchObject({ retryable: false, recovering: false, retryAfterMs: undefined });
  expect(error).toBeInstanceOf(acquisitionRefusals.DeviceUnhealthyError);
  if (!(error instanceof Error)) {
    throw new Error("expected error");
  }
  expect(error.message).toContain(
    "call killDevice with device { name: 'Pixel A', deviceId: 'emulator-5554', platform: 'android' }, then startDevice",
  );
});

test("#12112 clock recovery is unbounded and an orphan marker is permanent", async () => {
  const h = await harness();
  await h.pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  setRestoreState(h.manager, "clock");
  await h.manager.releaseSession("old");
  await h.pool.releaseDevice(device.deviceId, "old");
  expect(await typedAllocationError(h)).toMatchObject({
    code: "device_unhealthy",
    reason: "clock",
    retryable: true,
    recovering: true,
    retryAfterMs: undefined,
  });
  h.manager.retireClockRestoration(device.deviceId);
  h.markers.mark(device.deviceId, h.pool.getDeviceIncarnation(device.deviceId)!, "clock");
  expect(await typedAllocationError(h)).toMatchObject({
    retryable: false,
    recovering: false,
    retryAfterMs: undefined,
  });
});

test("#12112 timed-out in-flight recovery remains retryable without a bound", async () => {
  const h = await harness();
  await abandon(h, "network-condition");
  h.pause();
  try {
    await h.timer.advanceTimeAsync(1000, flush);
    expect(await typedAllocationError(h)).toMatchObject({ retryAfterMs: 12000 });
    await h.timer.advanceTimeAsync(1000, flush);
    expect(await typedAllocationError(h)).toMatchObject({
      retryable: true,
      recovering: true,
      retryAfterMs: undefined,
    });
    await h.timer.advanceTimeAsync(10000, flush);
    expect(h.calls).toBe(4);
  } finally {
    h.resume();
    await flush();
  }
});

test("#12112 every unhealthy candidate carries evidence and the smallest recovery bound", async () => {
  const h = await harness(2);
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      throw new Error("failed");
    },
    21000,
  );
  h.manager.markDeviceNeedsAppCleanup(
    other.deviceId,
    async () => {
      throw new Error("failed");
    },
    1234,
  );
  const error = await h.pool
    .assignDeviceToSession("next", "android")
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    code: "device_unhealthy",
    retryable: true,
    recovering: true,
    retryAfterMs: 14404,
    devices: [
      { deviceId: device.deviceId, reason: "app-cleanup", recovering: true, retryAfterMs: 133000 },
      { deviceId: other.deviceId, reason: "app-cleanup", recovering: true, retryAfterMs: 14404 },
    ],
  });
  expect(error).toBeInstanceOf(acquisitionRefusals.DeviceUnhealthyError);
  expect(error).not.toHaveProperty("deviceId", expect.any(String));
  expect(error).not.toHaveProperty("reason", expect.any(String));
  h.markers.clear(other.deviceId);
  h.markers.mark(other.deviceId, h.pool.getDeviceIncarnation(other.deviceId)!, "clock");
  const mixed = await h.pool
    .assignDeviceToSession("next", "android")
    .catch((caught: unknown) => caught);
  expect(mixed).toMatchObject({
    retryable: true,
    retryAfterMs: 133000,
    devices: [
      { deviceId: device.deviceId, reason: "app-cleanup", recovering: true, retryAfterMs: 133000 },
      { deviceId: other.deviceId, reason: "clock", recovering: false },
    ],
  });
  h.markers.clear(device.deviceId);
  h.markers.mark(device.deviceId, h.pool.getDeviceIncarnation(device.deviceId)!, "clock");
  const permanent = await h.pool
    .assignDeviceToSession("next", "android")
    .catch((caught: unknown) => caught);
  expect(permanent).toMatchObject({ retryable: false, recovering: false, retryAfterMs: undefined });
});

test("#12112 an unhealthy idle candidate does not preempt waiting for a healthy busy device", async () => {
  const h = await harness(2);
  await h.pool.bindOrReuseDeviceSession("owner", other.deviceId, "android");
  h.markers.mark(device.deviceId, h.pool.getDeviceIncarnation(device.deviceId)!, "app-cleanup");
  let settled = false;
  const waiting = h.pool.assignDeviceToSession("next", "android").finally(() => {
    settled = true;
  });
  await flush();
  expect(settled).toBe(false);
  await h.timer.advanceTimeAsync(500, flush);
  expect(settled).toBe(false);
  await h.manager.releaseSession("owner");
  await h.pool.releaseDevice(other.deviceId, "owner");
  await h.timer.advanceTimeAsync(500, flush);
  expect(await waiting).toBe(other.deviceId);
});

test("#12112 skipped ticks under a live owner preserve all three dispatched attempts", async () => {
  const h = await harness();
  await h.pool.bindOrReuseDeviceSession("owner", device.deviceId, "android");
  let calls = 0;
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      calls++;
      if (calls < 3) {
        throw new Error("retry");
      }
    },
    1234,
  );
  await h.timer.advanceTimeAsync(60000, flush);
  expect(calls).toBe(0);
  await h.manager.releaseSession("owner");
  await h.pool.releaseDevice(device.deviceId, "owner");
  await h.timer.advanceTimeAsync(1000, flush);
  expect(calls).toBe(1);
  for (const delay of [2000, 4000]) {
    await h.timer.advanceTimeAsync(delay, flush);
  }
  expect(calls).toBe(3);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
});

test("#12112 a cleanup gate skips ticks without consuming an attempt", async () => {
  const h = await harness();
  let recoverable = false;
  let calls = 0;
  h.manager.setDeviceHealthMarkers(
    h.markers,
    (id) => h.pool.getDeviceIncarnation(id),
    () => recoverable,
  );
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      calls++;
    },
    1234,
  );
  await h.timer.advanceTimeAsync(60000, flush);
  expect(calls).toBe(0);
  expect(await typedAllocationError(h)).toMatchObject({
    retryable: true,
    recovering: true,
    retryAfterMs: undefined,
  });
  recoverable = true;
  await h.timer.advanceTimeAsync(1000, flush);
  expect(calls).toBe(1);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
});

test("#12112 shutdown still dispatches recovery on an idle device's first tick", async () => {
  const h = await harness();
  h.manager.stopAcceptingSessionCreations();
  let calls = 0;
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      calls++;
    },
    21000,
  );
  expect(await typedAllocationError(h)).toMatchObject({ recovering: true, retryAfterMs: 133000 });
  await h.timer.advanceTimeAsync(1000, flush);
  expect(calls).toBe(1);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
});

test("#12112 a newer held marker makes a recovering device non-retryable", async () => {
  const h = await harness();
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      throw new Error("cleanup unavailable");
    },
    21000,
  );
  await h.timer.advanceTimeAsync(137, flush);
  const incarnation = h.pool.getDeviceIncarnation(device.deviceId)!;
  h.markers.mark(device.deviceId, incarnation, "network-condition");
  expect(h.manager.getDeviceHealthRecovery(device.deviceId, incarnation, "app-cleanup")).toEqual({
    recovering: true,
    retryAfterMs: 132863,
  });
  expect(
    h.manager.getDeviceHealthRecovery(device.deviceId, incarnation, "network-condition"),
  ).toEqual({ recovering: false });
  const error = await typedAllocationError(h);
  expect(error).toMatchObject({
    reason: "app-cleanup",
    retryable: false,
    recovering: false,
    devices: [{ deviceId: device.deviceId, reason: "app-cleanup", recovering: false }],
  });
  expect(error).not.toHaveProperty("retryAfterMs", expect.any(Number));
  expect(error).not.toHaveProperty("devices.0.retryAfterMs", expect.any(Number));
});

test("#12112 multiple recovering markers use the largest remaining device bound", async () => {
  const h = await harness();
  await abandon(h, "network-condition");
  const startedAt = h.timer.now();
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      throw new Error("cleanup unavailable");
    },
    21000,
  );
  await h.timer.advanceTimeAsync(137, flush);
  const incarnation = h.pool.getDeviceIncarnation(device.deviceId)!;
  expect(
    h.manager.getDeviceHealthRecovery(device.deviceId, incarnation, "network-condition"),
  ).toEqual({ recovering: true, retryAfterMs: 12863 });
  const remainingBound = startedAt + 133000 - h.timer.now();
  expect(h.manager.getDeviceHealthRecovery(device.deviceId, incarnation, "app-cleanup")).toEqual({
    recovering: true,
    retryAfterMs: remainingBound,
  });
  expect(await typedAllocationError(h)).toMatchObject({
    reason: "network-condition",
    retryable: true,
    recovering: true,
    retryAfterMs: remainingBound,
    devices: [
      {
        deviceId: device.deviceId,
        reason: "network-condition",
        recovering: true,
        retryAfterMs: remainingBound,
      },
    ],
  });
});

test("#12112 a bounded marker plus pending clock recovery has no device bound", async () => {
  const h = await harness();
  await h.pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      throw new Error("cleanup unavailable");
    },
    21000,
  );
  setRestoreState(h.manager, "clock");
  await h.manager.releaseSession("old");
  await h.pool.releaseDevice(device.deviceId, "old");
  // Isolate per-marker evidence from the pool's cleanup gate while the clock stays pending.
  h.manager.setDeviceHealthMarkers(
    h.markers,
    (id) => h.pool.getDeviceIncarnation(id),
    () => true,
  );
  const incarnation = h.pool.getDeviceIncarnation(device.deviceId)!;
  expect(h.manager.getDeviceHealthRecovery(device.deviceId, incarnation, "app-cleanup")).toEqual({
    recovering: true,
    retryAfterMs: 133000,
  });
  expect(h.manager.getDeviceHealthRecovery(device.deviceId, incarnation, "clock")).toEqual({
    recovering: true,
  });
  const error = await typedAllocationError(h);
  expect(error).toMatchObject({
    reason: "app-cleanup",
    retryable: true,
    recovering: true,
    devices: [{ deviceId: device.deviceId, reason: "app-cleanup", recovering: true }],
  });
  expect(error).not.toHaveProperty("retryAfterMs", expect.any(Number));
  expect(error).not.toHaveProperty("devices.0.retryAfterMs", expect.any(Number));
});

for (const retirement of ["bump", "remove", "shutdown", "clear"] as const) {
  test(`#12112 ${retirement} ends recovery while ticks are skipped`, async () => {
    const h = await harness();
    let calls = 0;
    h.manager.setDeviceHealthMarkers(
      h.markers,
      (id) => h.pool.getDeviceIncarnation(id),
      () => false,
    );
    h.manager.markDeviceNeedsAppCleanup(
      device.deviceId,
      async () => {
        calls++;
      },
      1234,
    );
    await h.timer.advanceTimeAsync(60000, flush);
    expect(h.timer.getPendingSleepCount()).toBe(1);
    if (retirement === "bump") {
      h.pool.bumpDeviceIncarnation(device.deviceId);
    } else if (retirement === "remove") {
      await h.pool.removeDevice(device.deviceId);
    } else if (retirement === "shutdown") {
      h.manager.stopAcceptingSessionCreations();
    } else {
      h.markers.clear(device.deviceId);
    }
    await h.timer.advanceTimeAsync(1000, flush);
    expect(calls).toBe(0);
    expect(h.timer.getPendingSleepCount()).toBe(0);
  });
}

test("recording-teardown refuses idle and exact binds until recovery confirms stop", async () => {
  const h = await harness();
  let stopped = false;
  h.manager.markDeviceNeedsRecorderTeardown(
    device.deviceId,
    async () => {
      stopped = true;
    },
    5_000,
  );
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("recording-teardown");
  const message = await allocationError(h);
  expect(message).toContain("recording-teardown");
  expect(message).toContain("previous session's recorder could not be confirmed stopped");
  expect(message).toContain("three");
  expect(message).toContain(
    "call killDevice with device { name: 'Pixel A', deviceId: 'emulator-5554', platform: 'android' }, then startDevice",
  );
  await expect(h.pool.assignDeviceToSession("idle-next", "android")).rejects.toThrow(
    "recording-teardown",
  );
  DaemonState.getInstance().initialize(h.manager, h.pool);
  const inventory = await handleDaemonRequest(
    { id: "rec-health", type: "daemon_request", method: "daemon/availableDevices", params: {} },
    DaemonState.getInstance(),
  );
  expect(inventory.result?.devices).toEqual([
    expect.objectContaining({ unhealthy: { reason: "recording-teardown", since: 1000 } }),
  ]);
  expect(stopped).toBe(false);
  await h.timer.advanceTimeAsync(1_000);
  await flush();
  expect(stopped).toBe(true);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
  expect(await h.pool.bindOrReuseDeviceSession("next", device.deviceId, "android")).toBe("next");
});

test("#12112 recording-teardown refusal carries its real recovery bound", async () => {
  const h = await harness();
  const markedAt = h.timer.now();
  let calls = 0;
  h.manager.markDeviceNeedsRecorderTeardown(
    device.deviceId,
    async () => {
      calls++;
      throw new Error("recorder still alive");
    },
    5_000,
  );
  const error = await typedAllocationError(h);
  expect(error).toBeInstanceOf(acquisitionRefusals.DeviceUnhealthyError);
  expect(error).toMatchObject({
    code: "device_unhealthy",
    deviceId: device.deviceId,
    reason: "recording-teardown",
    recovering: true,
    retryable: true,
    retryAfterMs: 37_000,
  });
  expect(error).toHaveProperty("message", expect.stringContaining("recording-teardown"));
  expect(error).toHaveProperty("message", expect.stringContaining("code device_unhealthy"));
  expect(error).toHaveProperty(
    "message",
    expect.stringContaining(
      "call killDevice with device { name: 'Pixel A', deviceId: 'emulator-5554', platform: 'android' }, then startDevice to bring up a fresh device.",
    ),
  );
  await h.timer.advanceTimeAsync(400, flush);
  expect(calls).toBe(0);
  expect(await typedAllocationError(h)).toMatchObject({ retryAfterMs: 36_600 });
  await h.timer.advanceTimeAsync(600, flush);
  expect(calls).toBe(1);
  // Fake time 2_000: the first immediate failure starts attempt 2's sleep here.
  expect(h.timer.now()).toBe(markedAt + 1_000);
  expect(h.timer.getPendingSleeps()).toEqual([2_000]);
  const remainingBound = markedAt + 1_000 + (2_000 + 4_000 + 10_000 + 15_000) - h.timer.now();
  expect(remainingBound).toBe(31_000);
  expect(await typedAllocationError(h)).toMatchObject({ retryAfterMs: remainingBound });
});

test("#12112 recording-teardown refusal is permanent after three dispatched failures", async () => {
  const h = await harness();
  let calls = 0;
  h.manager.markDeviceNeedsRecorderTeardown(
    device.deviceId,
    async () => {
      calls++;
      throw new Error("recorder still alive");
    },
    5_000,
  );
  for (const delay of [1_000, 2_000, 4_000]) {
    await h.timer.advanceTimeAsync(delay, flush);
  }
  expect(calls).toBe(3);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("recording-teardown");
  const error = await typedAllocationError(h);
  expect(error).toBeInstanceOf(acquisitionRefusals.DeviceUnhealthyError);
  expect(error).toMatchObject({
    code: "device_unhealthy",
    deviceId: device.deviceId,
    reason: "recording-teardown",
    retryable: false,
    recovering: false,
  });
  expect(error).not.toHaveProperty("retryAfterMs", expect.any(Number));
  expect(error).toHaveProperty(
    "message",
    expect.stringContaining(
      "call killDevice with device { name: 'Pixel A', deviceId: 'emulator-5554', platform: 'android' }, then startDevice to bring up a fresh device.",
    ),
  );
  await h.timer.advanceTimeAsync(60_000, flush);
  expect(calls).toBe(3);
});

test("#12112 recording-teardown recovery waits for a live owner without consuming attempts", async () => {
  const h = await harness();
  await h.pool.bindOrReuseDeviceSession("owner", device.deviceId, "android");
  let calls = 0;
  h.manager.markDeviceNeedsRecorderTeardown(
    device.deviceId,
    async () => {
      calls++;
    },
    5_000,
  );
  await h.timer.advanceTimeAsync(60_000, flush);
  expect(calls).toBe(0);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("recording-teardown");
  await h.manager.releaseSession("owner");
  await h.pool.releaseDevice(device.deviceId, "owner");
  await h.timer.advanceTimeAsync(1_000, flush);
  expect(calls).toBe(1);
  expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
  expect(await h.pool.bindOrReuseDeviceSession("next", device.deviceId, "android")).toBe("next");
});

test("three recorder recovery failures hold the incarnation independently of app-cleanup", async () => {
  const h = await harness();
  let recorderCalls = 0;
  let appCalls = 0;
  h.manager.markDeviceNeedsRecorderTeardown(
    device.deviceId,
    async () => {
      recorderCalls++;
      throw new Error("recorder still alive");
    },
    5_000,
  );
  h.manager.markDeviceNeedsAppCleanup(
    device.deviceId,
    async () => {
      appCalls++;
    },
    APP_CLEANUP_RETRY_BUDGET_MS,
  );
  for (const delay of [1_000, 2_000, 4_000, 60_000]) {
    await h.timer.advanceTimeAsync(delay);
    await flush();
  }
  expect(recorderCalls).toBe(3);
  expect(appCalls).toBe(1);
  const incarnation = h.pool.getDeviceIncarnation(device.deviceId)!;
  expect(h.markers.get(device.deviceId, incarnation, "app-cleanup")).toBeUndefined();
  expect(h.markers.get(device.deviceId, incarnation, "recording-teardown")?.reason).toBe(
    "recording-teardown",
  );
});
