import { describe, expect, spyOn, test } from "bun:test";
import { Mutex } from "async-mutex";
import {
  MissingDeviceLiveness,
  MISSING_DEVICE_MISS_THRESHOLD,
  type MissingDeviceLivenessPoolPort,
} from "../../src/daemon/missingDeviceLiveness";
import { evaluateDeviceDisconnects } from "../../src/daemon/disconnectMonitor";
import type { PooledDevice } from "../../src/daemon/devicePool";
import type {
  PlatformDeviceManager,
  BootedDeviceDiscovery,
  BootedDeviceDiscoveryOptions,
} from "../../src/devices/deviceUtils";
import { AdbClient, resetAdbClientCaches } from "../../src/utils/android-cmdline-tools/AdbClient";
import type { ExecResult } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

const deviceId = "emulator-5554";

function pooled(): PooledDevice {
  return {
    id: deviceId,
    name: "Pixel",
    platform: "android",
    status: "idle",
    sessionId: null,
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    incarnation: 1,
  };
}

async function flushUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Condition did not settle within 100 microtasks");
}

function harness() {
  const timer = new FakeTimer();
  const devices = new Map<string, PooledDevice>();
  const misses = new Map<string, number>();
  const calls: string[] = [];
  const mutex = new Mutex();
  let generation = 1;
  let reboot = false;
  let reserved = false;
  let delayIncident = false;
  let discovery: BootedDeviceDiscovery = {
    devices: [],
    succeededPlatforms: new Set(["android"]),
  };
  const manager = {
    getBootedDevicesDetailed: async () => discovery,
  } as PlatformDeviceManager;
  const port: MissingDeviceLivenessPoolPort = {
    getDevices: () => devices,
    getRefreshMissingDeviceMisses: () => misses,
    getAssignmentMutex: () => mutex,
    getDeviceManager: () => manager,
    getRefreshGeneration: () => generation,
    shouldRebootDisconnectedAndroidDevice: () => reboot,
    matchesRuntimeIdentity: () => true,
    reconcilePooledIdentityResolution: async () => {
      calls.push("reconcile");
    },
    comparePooledIdentityEvidence: () => "equal",
    replacePooledDeviceForRuntimeIdentity: async () => {
      calls.push("replace");
      return true;
    },
    finishSessionPreservingRecoveryPreparation: () => {
      calls.push("finish preparation");
    },
    tryPreserveSessionForMissingDevice: async () => false,
    releaseSessionForEvictedDevice: async () => {
      calls.push("release");
      return true;
    },
    finishEmulatorLossIncident: async () => {
      calls.push("finish incident");
    },
    removeDisconnectedDevice: async () => {
      calls.push("disconnect");
      devices.delete(deviceId);
    },
    completeEmulatorLossRecovery: async () => {
      calls.push("complete");
    },
    settleEmulatorLossIncident: () => {
      calls.push("settle");
    },
    removeDevice: async (_id, _cleanup, expected) => {
      calls.push("remove");
      if (devices.get(deviceId) === expected) {
        devices.delete(deviceId);
      }
    },
    isReservedForShutdown: () => reserved,
    recordEmulatorLossIncident: async () => {
      calls.push("record");
      if (delayIncident) {
        await timer.sleep(5);
      }
      return "incident";
    },
  };
  return {
    liveness: new MissingDeviceLiveness(port),
    timer,
    devices,
    misses,
    calls,
    port,
    setGeneration: (value: number) => {
      generation = value;
    },
    setReboot: () => {
      reboot = true;
    },
    setReserved: () => {
      reserved = true;
    },
    delayIncident: () => {
      delayIncident = true;
    },
    setDiscovery: (value: BootedDeviceDiscovery) => {
      discovery = value;
    },
  };
}

function emptyRefresh(h: ReturnType<typeof harness>) {
  return h.liveness.removeMissingDevicesForRefresh(
    false,
    1,
    new Set(),
    new Set(),
    new Set(["android"]),
  );
}

describe("MissingDeviceLiveness", () => {
  test("fresh presence bypasses only its own adb read while a concurrent caller keeps the cached list", async () => {
    resetAdbClientCaches();
    const h = harness();
    const freshRead = Promise.withResolvers<ExecResult>();
    const optionsSeen: (BootedDeviceDiscoveryOptions | undefined)[] = [];
    let adbReads = 0;
    const exec = async (): Promise<ExecResult> => {
      adbReads++;
      if (adbReads === 2) {
        return freshRead.promise;
      }
      const stdout = `List of devices attached\nemulator-${adbReads === 1 ? 5554 : 5556}\tdevice\n`;
      return {
        stdout,
        stderr: "",
        toString: () => stdout,
        trim: () => stdout.trim(),
        includes: (searchString: string) => stdout.includes(searchString),
      };
    };
    const livenessAdb = new AdbClient(null, exec, null, undefined, h.timer);
    const normalAdb = new AdbClient(null, exec, null, undefined, h.timer);
    h.port.getDeviceManager = () =>
      ({
        getBootedDevicesDetailed: async (_platform, options) => {
          optionsSeen.push(options);
          const devices = await livenessAdb.getBootedAndroidDevices({
            bypassCache: options?.bypassAndroidDeviceListCache,
          });
          return { devices, succeededPlatforms: new Set(["android"]) };
        },
      }) as PlatformDeviceManager;

    try {
      expect((await normalAdb.getBootedAndroidDevices()).map((device) => device.deviceId)).toEqual([
        "emulator-5554",
      ]);
      const presence = h.liveness.takeFreshPresenceDiscovery("android");
      await flushUntil(() => adbReads === 2);
      expect(optionsSeen).toEqual([{ bypassAndroidDeviceListCache: true }]);
      expect((await normalAdb.getBootedAndroidDevices()).map((device) => device.deviceId)).toEqual([
        "emulator-5554",
      ]);
      expect(adbReads).toBe(2);

      const stdout = "List of devices attached\nemulator-5556\tdevice\n";
      freshRead.resolve({
        stdout,
        stderr: "",
        toString: () => stdout,
        trim: () => stdout.trim(),
        includes: (searchString: string) => stdout.includes(searchString),
      });
      expect((await presence).devices.map((device) => device.deviceId)).toEqual(["emulator-5556"]);
      expect((await normalAdb.getBootedAndroidDevices()).map((device) => device.deviceId)).toEqual([
        "emulator-5556",
      ]);
      expect(adbReads).toBe(2);
    } finally {
      freshRead.resolve({
        stdout: "List of devices attached\n",
        stderr: "",
        toString: () => "",
        trim: () => "",
        includes: () => false,
      });
      resetAdbClientCaches();
    }
  });

  test("refresh and monitor share one consecutive-miss streak", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    expect(await emptyRefresh(h)).toBe(0);
    expect(h.misses.get(deviceId)).toBe(1);

    h.timer.advanceTime(5_000);
    const monitor = evaluateDeviceDisconnects({
      deviceDisconnectMisses: h.misses,
      confirmedDisconnectedDeviceIds: new Set(),
      bootedDeviceIds: new Set(),
      candidateDeviceIds: new Set([deviceId]),
      succeededPlatforms: new Set(["android"]),
      candidatePlatforms: new Map([[deviceId, "android"]]),
      candidateIncarnations: new Map([[deviceId, 1]]),
      deviceDisconnectMissIncarnations: new Map(),
    });
    expect(monitor.missed).toEqual([{ deviceId, misses: 2 }]);
    expect(monitor.disconnected).toEqual([]);
    expect(h.devices.has(deviceId)).toBe(true);

    expect(await emptyRefresh(h)).toBe(1);
    expect(h.devices.has(deviceId)).toBe(false);
  });

  test.each([false, true])(
    "monitor and refresh confirm the same miss with another platform device present=%s",
    async (platformHasAnotherDevice) => {
      const h = harness();
      h.devices.set(deviceId, pooled());
      const monitorMisses = new Map<string, number>();
      const bootedPlatforms = new Set<"android">(platformHasAnotherDevice ? ["android"] : []);
      const evaluate = (sourceSucceeded: boolean) =>
        evaluateDeviceDisconnects({
          deviceDisconnectMisses: monitorMisses,
          confirmedDisconnectedDeviceIds: new Set(),
          bootedDeviceIds: new Set(),
          candidateDeviceIds: new Set([deviceId]),
          succeededPlatforms: new Set(sourceSucceeded ? ["android" as const] : []),
          candidatePlatforms: new Map([[deviceId, "android" as const]]),
        });
      const refresh = (sourceSucceeded: boolean) =>
        h.liveness.removeMissingDevicesForRefresh(
          false,
          1,
          new Set(),
          bootedPlatforms,
          new Set(sourceSucceeded ? ["android" as const] : []),
        );

      for (let miss = 1; miss < MISSING_DEVICE_MISS_THRESHOLD; miss++) {
        h.timer.advanceTime(5_000);
        expect(evaluate(true).disconnected).toEqual([]);
        expect(await refresh(true)).toBe(0);
        expect(h.devices.has(deviceId)).toBe(true);
      }
      expect(evaluate(false).disconnected).toEqual([]);
      expect(await refresh(false)).toBe(0);
      expect(monitorMisses.has(deviceId)).toBe(false);
      expect(h.misses.has(deviceId)).toBe(false);
      for (let miss = 1; miss < MISSING_DEVICE_MISS_THRESHOLD; miss++) {
        h.timer.advanceTime(5_000);
        expect(evaluate(true).disconnected).toEqual([]);
        expect(await refresh(true)).toBe(0);
      }
      h.timer.advanceTime(5_000);
      expect(evaluate(true).disconnected).toEqual([deviceId]);
      expect(await refresh(true)).toBe(1);
      expect(h.devices.has(deviceId)).toBe(false);
    },
  );

  test("retains two empty refreshes then evicts on the third", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    expect(await emptyRefresh(h)).toBe(0);
    expect(h.misses.get(deviceId)).toBe(1);
    expect(await emptyRefresh(h)).toBe(0);
    expect(h.misses.get(deviceId)).toBe(2);
    expect(await emptyRefresh(h)).toBe(1);
    expect(h.devices.has(deviceId)).toBe(false);
    expect(h.calls).toEqual(["record", "finish preparation", "complete", "remove", "settle"]);
  });

  test("retains a device when its discovery source failed or it has a session", async () => {
    const h = harness();
    const device = pooled();
    h.devices.set(deviceId, device);
    expect(
      await h.liveness.removeMissingDevicesForRefresh(false, 1, new Set(), new Set(), new Set()),
    ).toBe(0);
    expect(h.misses.has(deviceId)).toBe(false);
    device.sessionId = "session";
    expect(await emptyRefresh(h)).toBe(0);
    expect(h.calls).toEqual([]);
  });

  test("discards an obsolete refresh before pruning", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    h.setGeneration(2);
    expect(await emptyRefresh(h)).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  test("claims an absent idle entry before awaiting a timed incident", async () => {
    const h = harness();
    const device = pooled();
    h.devices.set(deviceId, device);
    h.delayIncident();
    const checking = h.liveness.ensurePooledDevicePresent(device, false, false, true);
    await flushUntil(() => h.timer.getPendingSleepCount() === 1);
    expect(device.status).toBe("error");
    expect(h.devices.get(deviceId)).toBe(device);
    h.timer.advanceTime(5);
    expect(await checking).toBe(false);
    expect(h.devices.has(deviceId)).toBe(false);
    expect(h.calls).toEqual(["record", "finish preparation", "complete", "remove", "settle"]);
  });

  test("defers a recoverable eviction and marks the entry unavailable", async () => {
    const h = harness();
    const device = pooled();
    h.devices.set(deviceId, device);
    h.setReboot();
    expect(await h.liveness.ensurePooledDevicePresent(device, true, false, false)).toBe(false);
    await flushUntil(() => h.calls.includes("disconnect"));
    expect(device.status).toBe("idle");
    expect(h.calls).toEqual(["record", "finish preparation", "disconnect"]);
  });

  test("shutdown reservation prevents eviction before incident capture", async () => {
    const h = harness();
    const device = pooled();
    h.devices.set(deviceId, device);
    h.setReserved();
    await h.liveness.evictMissingPooledDevice(device, "absent", {
      attemptDeviceLossRecovery: true,
    });
    expect(h.calls).toEqual([]);
    expect(h.devices.get(deviceId)).toBe(device);
  });

  test("releases an assigned session before removing its device", async () => {
    const h = harness();
    const device = pooled();
    device.sessionId = "session";
    h.devices.set(deviceId, device);
    await h.liveness.evictMissingPooledDevice(device, "absent");
    expect(h.calls).toEqual(["finish preparation", "release", "complete", "remove", "settle"]);
    expect(h.devices.has(deviceId)).toBe(false);
  });

  test("stops eviction when session preservation owns recovery", async () => {
    const h = harness();
    const device = pooled();
    device.sessionId = "session";
    h.devices.set(deviceId, device);
    h.port.tryPreserveSessionForMissingDevice = async () => {
      h.calls.push("preserve");
      return true;
    };
    await h.liveness.evictMissingPooledDevice(device, "absent", {
      attemptDeviceLossRecovery: true,
    });
    expect(h.calls).toEqual(["record", "finish preparation", "preserve"]);
    expect(h.devices.get(deviceId)).toBe(device);
  });

  test("does not remove a replacement incarnation after incident capture", async () => {
    const h = harness();
    const original = pooled();
    h.devices.set(deviceId, original);
    h.port.recordEmulatorLossIncident = async () => {
      h.calls.push("record");
      h.devices.set(deviceId, pooled());
      return "incident";
    };
    await h.liveness.evictMissingPooledDevice(original, "absent", {
      attemptDeviceLossRecovery: true,
    });
    expect(h.calls).toEqual(["record", "finish preparation", "finish incident"]);
    expect(h.devices.get(deviceId)).not.toBe(original);
  });

  test("aborts removal when a newer identity observation arrives during recovery completion", async () => {
    const h = harness();
    const device = pooled();
    h.devices.set(deviceId, device);
    let stale = false;
    h.port.comparePooledIdentityEvidence = () => (stale ? "stale" : "equal");
    h.port.completeEmulatorLossRecovery = async () => {
      h.calls.push("complete");
      stale = true;
    };
    await h.liveness.evictMissingPooledDevice(device, "identity changed", {
      identityObservation: {
        deviceId,
        name: "Other Pixel",
        platform: "android",
        observedAt: 1,
      },
    });
    expect(h.calls).toEqual(["finish preparation", "complete"]);
    expect(h.devices.get(deviceId)).toBe(device);
  });

  test("logs a rejected detached recovering eviction", async () => {
    const h = harness();
    const device = pooled();
    h.devices.set(deviceId, device);
    h.setReboot();
    const failure = new Error("incident failed");
    h.port.recordEmulatorLossIncident = async () => {
      h.calls.push("record");
      await h.timer.sleep(5);
      throw failure;
    };
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await h.liveness.ensurePooledDevicePresent(device, true, false, false)).toBe(false);
      await flushUntil(() => h.timer.getPendingSleepCount() === 1);
      expect(device.status).toBe("error");
      h.timer.advanceTime(5);
      await flushUntil(() =>
        warnSpy.mock.calls.some(([message]) =>
          String(message).includes(`Deferred eviction failed for ${deviceId}: ${failure}`),
        ),
      );
      expect(h.calls).toEqual(["record"]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
