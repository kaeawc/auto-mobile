import { settleWithFakeTime } from "../helpers/fakeTimerStepping";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import type { IosLivenessSnapshot } from "../../src/daemon/idleDeviceReaper";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError } from "../../src/models/ActionableError";
import type { BootedDevice, DeviceInfo, Platform, SomePlatform } from "../../src/models";
import type { BootedDeviceDiscovery } from "../../src/devices/deviceUtils";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

// Regression for #7951: multi-device allocation runs its pre-allocation cleanup
// (pruneStaleIdleIosDevices / evictUnavailableIdleDevicesMatching) outside
// assignmentMutex. Exact bind also snapshots outside the lock, and must fence
// that evidence against pool entries changed by the concurrent cleanup.

/**
 * Parks the next detailed discovery for `parkNext` on a deferred the test
 * resolves. The listing is snapshotted when the call is made, so the parked
 * caller later acts on evidence older than whatever happened meanwhile.
 */
class ParkingFakeDeviceManager extends FakeDeviceManager {
  parkNext: Platform | null = null;
  parked: Array<{ resolve: () => void }> = [];
  parkRecoveryStart = false;
  parkedRecoveryStarts: Array<{ resolve: () => void }> = [];

  override async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    if (platform !== "either" && platform === this.parkNext) {
      this.parkNext = null;
      const snapshot = await super.getBootedDevicesDetailed(platform);
      await new Promise<void>((resolve) => this.parked.push({ resolve }));
      return snapshot;
    }
    return super.getBootedDevicesDetailed(platform);
  }

  override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
    if (this.parkRecoveryStart) {
      this.parkRecoveryStart = false;
      await new Promise<void>((resolve) => this.parkedRecoveryStarts.push({ resolve }));
    }
    return super.startDevice(device);
  }
}

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

describe("idle eviction with a stale discovery snapshot", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let deviceManager: ParkingFakeDeviceManager;
  let pool: DevicePool;

  beforeEach(() => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    deviceManager = new ParkingFakeDeviceManager();
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "repro-6393-daemon", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: deviceManager,
        retryExecutor: new DefaultRetryExecutor(timer),
      }),
    );
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  test.each(["select", "prune", "bind"] as const)(
    "%s keeps a same-UDID replacement after stale iOS discovery",
    async (path) => {
      const udid = "11111111-2222-3333-4444-555555555555";
      const sim: BootedDevice = { name: "iPhone 16", platform: "ios", deviceId: udid };
      deviceManager.bootedDevices = [sim];
      await pool.initializeWithDevices([sim]);
      const original = pool.getDevice(udid)!;
      const internals = pool as unknown as {
        idleDeviceReaper: { getIosLivenessSnapshot(): Promise<IosLivenessSnapshot> };
        assignmentMutex: { runExclusive<T>(operation: () => Promise<T>): Promise<T> };
        selectAssignableIdleDevice(
          candidates: PooledDevice[],
          snapshots: {
            capturedEntries: ReadonlySet<PooledDevice>;
            iosLiveness: IosLivenessSnapshot;
          },
        ): Promise<unknown>;
        pruneStaleIdleIosDevices(candidates: PooledDevice[]): Promise<number>;
      };

      deviceManager.bootedDevices = [];
      deviceManager.parkNext = "ios";
      const operation =
        path === "select"
          ? internals.idleDeviceReaper.getIosLivenessSnapshot().then((iosLiveness) =>
              internals.assignmentMutex.runExclusive(() =>
                internals.selectAssignableIdleDevice([original], {
                  capturedEntries: new Set([original]),
                  iosLiveness,
                }),
              ),
            )
          : path === "prune"
            ? internals.pruneStaleIdleIosDevices([original])
            : pool
                .bindOrReuseDeviceSession("binding", udid, "ios")
                .catch((error: unknown) => error);
      await flushMicrotasks();
      expect(deviceManager.parked).toHaveLength(1);

      const remove = pool.removeDevice.bind(pool);
      let replacement: PooledDevice | undefined;
      let staleRemovalCalls = 0;
      pool.removeDevice = async (id, awaitCacheCleanup, expectedDevice) => {
        staleRemovalCalls++;
        expect(expectedDevice).toBe(original);
        await remove(id, false, original);
        await pool.addDevice(sim);
        replacement = pool.getDevice(id)!;
        await remove(id, awaitCacheCleanup, expectedDevice);
      };
      try {
        deviceManager.parked[0].resolve();
        const result = await operation;
        if (path === "bind") {
          expect(staleRemovalCalls).toBe(0);
          expect(pool.getDevice(udid)).toBe(original);
          expect(result).toBeInstanceOf(ActionableError);
          return;
        }
        if (path === "select") {
          expect(staleRemovalCalls).toBe(0);
          expect(pool.getDevice(udid)).toBe(original);
          expect(result).toMatchObject({ snapshotStale: true });
          return;
        }
        expect(staleRemovalCalls).toBe(1);
        expect(replacement?.incarnation).not.toBe(original.incarnation);
        expect(pool.getDevice(udid)).toBe(replacement);
        if (path === "prune") {
          expect(result).toBe(0);
        }
      } finally {
        pool.removeDevice = remove;
      }
    },
  );

  test("prune skips a newer incarnation before judging an older iOS snapshot", async () => {
    const sim: BootedDevice = {
      name: "iPhone 16",
      platform: "ios",
      deviceId: "11111111-2222-3333-4444-555555555555",
    };
    deviceManager.bootedDevices = [sim];
    await pool.initializeWithDevices([sim]);
    const original = pool.getDevice(sim.deviceId)!;
    const internals = pool as unknown as {
      pruneStaleIdleIosDevices(candidates: PooledDevice[]): Promise<number>;
    };
    deviceManager.bootedDevices = [];
    deviceManager.parkNext = "ios";
    const prune = internals.pruneStaleIdleIosDevices([original]);
    await flushMicrotasks();
    await pool.removeDevice(sim.deviceId, false, original);
    await pool.addDevice(sim);
    const replacement = pool.getDevice(sim.deviceId)!;
    deviceManager.parked[0].resolve();
    expect(await prune).toBe(0);
    expect(pool.getDevice(sim.deviceId)).toBe(replacement);
  });

  test.each(["retire", "replace"] as const)(
    "%s uses its captured entry for shutdown removal",
    async (path) => {
      const sim: BootedDevice = {
        name: "iPhone 16",
        platform: "ios",
        deviceId: "11111111-2222-3333-4444-555555555555",
      };
      deviceManager.bootedDevices = [sim];
      await pool.initializeWithDevices([sim]);
      const original = pool.getDevice(sim.deviceId)!;
      const remove = pool.removeDevice.bind(pool);
      let replacement: PooledDevice | undefined;
      pool.removeDevice = async (id, awaitCacheCleanup, expectedDevice) => {
        if (!replacement) {
          await remove(id, false, original);
          await pool.addDevice(sim);
          replacement = pool.getDevice(id)!;
        }
        await remove(id, awaitCacheCleanup, expectedDevice);
      };
      try {
        if (path === "retire") {
          expect(await pool.retireDeviceForShutdown(original)).toBe(false);
        } else {
          expect(await pool.replaceDeviceForShutdown(original, sim)).toBeUndefined();
        }
        expect(pool.getDevice(sim.deviceId)).toBe(replacement);
      } finally {
        pool.removeDevice = remove;
      }
    },
  );

  test.each(["ios", "android"] as const)(
    "%s multi-allocation eviction holds assignmentMutex at removal",
    async (platform) => {
      const device: BootedDevice =
        platform === "ios"
          ? {
              name: "iPhone 16",
              platform,
              deviceId: "11111111-2222-3333-4444-555555555555",
            }
          : { name: "SM-S911B", platform, deviceId: "R58M1234ABC" };
      deviceManager.bootedDevices = [device];
      await pool.initializeWithDevices([device]);
      const internals = pool as unknown as {
        assignmentMutex: {
          runExclusive<T>(callback: () => T | Promise<T>): Promise<T>;
        };
      };
      const mutex = internals.assignmentMutex;
      const runExclusive = mutex.runExclusive.bind(mutex);
      const remove = pool.removeDevice.bind(pool);
      let lockDepth = 0;
      let guardedRemovals = 0;
      mutex.runExclusive = <T>(callback: () => T | Promise<T>): Promise<T> =>
        runExclusive(async () => {
          lockDepth++;
          try {
            return await callback();
          } finally {
            lockDepth--;
          }
        });
      pool.removeDevice = async (id, awaitCacheCleanup, expectedDevice) => {
        expect(lockDepth).toBe(1);
        expect(expectedDevice).toBeDefined();
        if (platform === "android") {
          expect(expectedDevice?.status).toBe("error");
        }
        guardedRemovals++;
        await remove(id, awaitCacheCleanup, expectedDevice);
      };
      try {
        deviceManager.bootedDevices = [];
        await pool.assignMultipleDevices([], 1_000, platform);
        expect(guardedRemovals).toBe(1);
        expect(pool.getDevice(device.deviceId)).toBeNull();
      } finally {
        mutex.runExclusive = runExclusive;
        pool.removeDevice = remove;
      }
    },
  );

  test.each(["count", "criteria"] as const)(
    "%s device start publishes under assignmentMutex",
    async (path) => {
      const image: DeviceInfo = {
        name: "iPhone 16",
        platform: "ios",
        deviceId: "11111111-2222-3333-4444-555555555555",
        isRunning: false,
        source: "local",
      };
      deviceManager.deviceImages = [image];
      const internals = pool as unknown as {
        assignmentMutex: {
          runExclusive<T>(callback: () => T | Promise<T>): Promise<T>;
        };
        startAdditionalDevices(
          count: number,
          deadline: number,
          platform: Platform,
        ): Promise<number>;
        startAdditionalDeviceMatchingCriteria(
          criteria: { platform: Platform },
          excluded: Set<string>,
          deadline: number,
          rediscover: () => Promise<PooledDevice | undefined>,
        ): Promise<{ device: PooledDevice; started: boolean } | null>;
        trackStartedDeviceProcess(
          device: BootedDevice,
          childProcess: ChildProcess | null | undefined,
        ): Promise<void>;
      };
      const mutex = internals.assignmentMutex;
      const runExclusive = mutex.runExclusive.bind(mutex);
      const add = pool.addDevice.bind(pool);
      const track = internals.trackStartedDeviceProcess.bind(pool);
      let lockDepth = 0;
      let guardedAdds = 0;
      let guardedTracks = 0;
      mutex.runExclusive = <T>(callback: () => T | Promise<T>): Promise<T> =>
        runExclusive(async () => {
          lockDepth++;
          try {
            return await callback();
          } finally {
            lockDepth--;
          }
        });
      pool.addDevice = async (...args) => {
        expect(lockDepth).toBe(1);
        guardedAdds++;
        await add(...args);
      };
      internals.trackStartedDeviceProcess = async (...args) => {
        expect(lockDepth).toBe(1);
        guardedTracks++;
        await track(...args);
      };
      try {
        if (path === "count") {
          expect(await internals.startAdditionalDevices(1, timer.now() + 1_000, "ios")).toBe(1);
        } else {
          expect(
            await internals.startAdditionalDeviceMatchingCriteria(
              { platform: "ios" },
              new Set(),
              timer.now() + 1_000,
              async () => undefined,
            ),
          ).toMatchObject({ started: true });
        }
        expect(guardedAdds).toBe(1);
        expect(guardedTracks).toBe(1);
        expect(pool.getDevice(image.deviceId!)).not.toBeNull();
      } finally {
        mutex.runExclusive = runExclusive;
        pool.addDevice = add;
        internals.trackStartedDeviceProcess = track;
      }
    },
  );

  test("iOS: prune proceeds while bind discovery is parked and the old positive snapshot cannot claim", async () => {
    const udid = "11111111-2222-3333-4444-555555555555";
    const sim: BootedDevice = { name: "iPhone 16", platform: "ios", deviceId: udid };
    deviceManager.bootedDevices = [sim];
    await pool.initializeWithDevices([sim]);
    // Connection B parks its exact-bind liveness snapshot outside the mutex.
    deviceManager.parkNext = "ios";
    const bind = pool.bindOrReuseDeviceSession("session-b", udid, "ios").then(
      (sessionId) => ({ ok: true as const, sessionId }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await flushMicrotasks();
    expect(deviceManager.parked).toHaveLength(1);

    // Connection A can prune the idle entry while B's discovery is parked.
    deviceManager.bootedDevices = [];
    const allocation = pool.assignMultipleDevices([], 1_000, "ios");
    await allocation;
    expect(pool.getDevice(udid)).toBeNull();

    // B's old positive evidence cannot claim the removed incarnation.
    deviceManager.parked[0].resolve();
    const outcome = await bind;
    await allocation;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(ActionableError);
      expect(String(outcome.error)).toContain("not available");
    }
    expect(sessionManager.getSession("session-b")).toBeNull();
  });

  // The issue's second verification case: an unlocked eviction must not remove
  // an entry a lock holder claimed after the eviction's discovery was taken.
  test("Android: stale unlocked eviction must not release/remove a device bound meanwhile", async () => {
    const serial = "R58M1234ABC"; // physical handset: no emulator recovery path
    const handset: BootedDevice = { name: "SM-S911B", platform: "android", deviceId: serial };
    deviceManager.bootedDevices = [handset];
    await pool.initializeWithDevices([handset]);

    // Connection A: assignMultipleDevices' evictUnavailableIdleDevicesMatching
    // takes an adb snapshot while the handset is briefly absent, then parks
    // (no lock held) before acting on it.
    deviceManager.bootedDevices = [];
    deviceManager.parkNext = "android";
    const allocation = pool
      .assignMultipleDevices(["session-a"], 1_000, "android")
      .catch((error: unknown) => error);
    await flushMicrotasks();
    expect(deviceManager.parked).toHaveLength(1);

    // Handset is back. Connection B binds it under the mutex, with its own
    // fresher discovery confirming presence.
    deviceManager.bootedDevices = [handset];
    const sessionId = await pool.bindOrReuseDeviceSession("session-b", serial, "android");
    expect(sessionId).toBe("session-b");
    const bound = pool.getDevice(serial);
    expect(bound?.sessionId).toBe("session-b");

    // A resumes on its stale "absent" snapshot.
    deviceManager.parked[0].resolve();
    await settleWithFakeTime(timer, allocation, {
      stepMs: 1_000,
      maxSteps: 2,
      description: "stale preflight allocation timeout",
    });
    await flushMicrotasks();

    const diagnostic = {
      poolEntryIsBound: pool.getDevice(serial) === bound,
      boundSessionId: bound?.sessionId ?? null,
      sessionBAssignedDevice: sessionManager.getSession("session-b")?.assignedDevice ?? null,
    };
    expect(diagnostic).toEqual({
      poolEntryIsBound: true,
      boundSessionId: "session-b",
      sessionBAssignedDevice: serial,
    });
  });

  test("Android: a device still absent and unbound is evicted", async () => {
    const serial = "R58M1234ABC";
    const handset: BootedDevice = { name: "SM-S911B", platform: "android", deviceId: serial };
    deviceManager.bootedDevices = [handset];
    await pool.initializeWithDevices([handset]);

    deviceManager.bootedDevices = [];
    await pool.assignMultipleDevices(["session-a"], 1_000, "android").catch(() => undefined);

    expect(pool.getDevice(serial)).toBeNull();
    expect(sessionManager.getSessionForDevice(serial)).toBeNull();
  });

  test("Android: idle emulator recovery does not hold the assignment lock", async () => {
    const emulator: BootedDevice = {
      name: "Pixel_8_API_35",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const image: DeviceInfo = {
      name: emulator.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    const handset: BootedDevice = {
      name: "SM-S911B",
      platform: "android",
      deviceId: "R58M1234ABC",
    };
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "repro-6393-daemon", {
        timer: timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: deviceManager,
        retryExecutor: new DefaultRetryExecutor(timer),
        recoveryPolicy: { onLoss: true, maxAttempts: 1 },
      }),
    );
    deviceManager.bootedDevices = [handset];
    await pool.initializeWithDevices([handset]);
    await pool.addDevice(emulator, image);
    expect(pool.getRecoveryEligibility(emulator.deviceId).eligible).toBe(true);

    deviceManager.parkRecoveryStart = true;
    const eviction = pool.assignMultipleDevices([], 1_000, "android");
    await flushMicrotasks(100);
    expect(deviceManager.parkedRecoveryStarts).toHaveLength(1);

    let bindAndReleaseSettled = false;
    const bindAndRelease = pool
      .bindOrReuseDeviceSession("unrelated", handset.deviceId, "android")
      .then(async (sessionId) => {
        await pool.releaseDevice(handset.deviceId, sessionId);
        bindAndReleaseSettled = true;
        return sessionId;
      });
    try {
      await flushMicrotasks(100);
      expect(bindAndReleaseSettled).toBe(true);
    } finally {
      deviceManager.parkedRecoveryStarts[0].resolve();
      await Promise.allSettled([eviction, bindAndRelease]);
    }
    expect(await bindAndRelease).toBe("unrelated");
  });
});
