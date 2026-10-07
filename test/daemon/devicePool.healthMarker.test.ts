import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../../src/utils/logger";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError } from "../../src/models/ActionableError";
import { DaemonState } from "../../src/daemon/daemonState";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { defaultDeviceClockRestoreRegistry } from "../../src/features/utility/DeviceClock";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
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
  const markers = new FakeDeviceHealthMarkers(timer);
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
    () => ({ restore: async () => {} }),
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
    await h.timer.advanceTimeAsync(1000);
    await flush();
    await release;
    await h.pool.releaseDevice(device.deviceId, "old");
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toEqual({ reason: "clock", since: 2000 });
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
