import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { logger } from "../../src/utils/logger";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

/** Parks the next recovery cold boot on a deferred the test resolves. */
class ParkingBootDeviceManager extends FakeDeviceManager {
  parkRecoveryStart = false;
  parkedRecoveryStarts: Array<{ resolve: () => void }> = [];

  override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
    if (this.parkRecoveryStart) {
      this.parkRecoveryStart = false;
      await new Promise<void>((resolve) => this.parkedRecoveryStarts.push({ resolve }));
    }
    return super.startDevice(device);
  }
}

async function flushMicrotasks(rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

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
const handset: BootedDevice = { name: "SM-S911B", platform: "android", deviceId: "R58M1234ABC" };

// #6391: a refresh prune runs inside assignmentMutex. When the recovery policy
// reboots a missing AutoMobile-owned emulator, that boot must not hold the lock.
describe("DevicePool recovery reboot outside assignmentMutex", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let deviceManager: ParkingBootDeviceManager;
  let pool: DevicePool;

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    deviceManager = new ParkingBootDeviceManager();
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "recovery-outside-mutex", {
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
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  test("refresh prune does not block allocation while the emulator reboots", async () => {
    // Discovery succeeds for Android but no longer lists the emulator.
    deviceManager.parkRecoveryStart = true;
    await pool.refreshDevices();
    await pool.refreshDevices();
    let refreshSettled = false;
    const refresh = pool.refreshDevices().finally(() => {
      refreshSettled = true;
    });
    await flushMicrotasks();
    expect(deviceManager.parkedRecoveryStarts).toHaveLength(1);

    let bindSettled = false;
    const bind = pool
      .bindOrReuseDeviceSession("unrelated", handset.deviceId, "android")
      .then(async (sessionId) => {
        bindSettled = true;
        await pool.releaseDevice(handset.deviceId, sessionId);
        return sessionId;
      });
    try {
      await flushMicrotasks();
      // The reboot was handed off, not awaited inside the refresh's lock.
      expect(refreshSettled).toBe(true);
      expect(bindSettled).toBe(true);
      // The missing entry is not assignable while its recovery runs.
      expect(pool.getDevice(emulator.deviceId)?.status).not.toBe("idle");
    } finally {
      deviceManager.parkedRecoveryStarts[0]?.resolve();
      await Promise.allSettled([refresh, bind]);
    }
    expect(await bind).toBe("unrelated");
  });

  test("the detached recovery still reboots the missing emulator", async () => {
    deviceManager.parkRecoveryStart = true;
    await pool.refreshDevices();
    await pool.refreshDevices();
    await pool.refreshDevices();
    await flushMicrotasks();
    expect(deviceManager.parkedRecoveryStarts).toHaveLength(1);
    expect(deviceManager.startedDevices).toHaveLength(0);

    deviceManager.parkedRecoveryStarts[0].resolve();
    await flushMicrotasks();
    expect(deviceManager.startedDevices.map((device) => device.name)).toEqual([emulator.name]);
  });
});

// #6392: removeDevice refuses assigned entries, so the assigned-device branch of
// removeDisconnectedDevice must retain explicitly and remove once released.
describe("DevicePool disconnect of an assigned device", () => {
  test("retains the entry until late teardown releases it, then removes it once", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [handset];
    const removed: string[] = [];
    const pool = DevicePool.create({
      sessionManager,
      daemonSessionId: "assigned-disconnect",
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager,
      onDeviceRemoved: (deviceId) => removed.push(deviceId),
    });
    try {
      await pool.initializeWithDevices([handset]);
      const sessionId = await pool.bindOrReuseDeviceSession("s1", handset.deviceId, "android");

      let finishCleanup!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      const cleanupSpy = spyOn(sessionManager, "getPendingDeviceCleanup").mockImplementation(
        (deviceId) => (deviceId === handset.deviceId ? cleanup : undefined),
      );
      const warnSpy = spyOn(logger, "warn");
      try {
        // Release defers behind the pending teardown, leaving sessionId set.
        await pool.releaseDevice(handset.deviceId, sessionId);
        expect(pool.getDevice(handset.deviceId)?.sessionId).toBe(sessionId);

        deviceManager.bootedDevices = [];
        await pool.removeDisconnectedDevice(handset.deviceId);
        expect(pool.getDevice(handset.deviceId)?.sessionId).toBe(sessionId);
        expect(removed).toEqual([]);
        const messages = warnSpy.mock.calls.map((call) => String(call[0]));
        expect(messages.some((m) => m.includes("Retaining disconnected device"))).toBe(true);
        expect(messages.some((m) => m.includes("Cannot remove device"))).toBe(false);

        cleanupSpy.mockImplementation(() => undefined);
        finishCleanup();
        await flushMicrotasks();
        expect(pool.getDevice(handset.deviceId)?.sessionId).toBeNull();

        await pool.removeDisconnectedDevice(handset.deviceId);
        expect(pool.getDevice(handset.deviceId)).toBeNull();
        expect(removed).toEqual([handset.deviceId]);
      } finally {
        cleanupSpy.mockRestore();
        warnSpy.mockRestore();
      }
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });
});

describe("DevicePool exhausted session release ownership", () => {
  test.each(["removed", "present", "new-owner", "new-assignment", "pool-failure"])(
    "exhaustion frees only the removed session's original assignment: %s",
    async (scenario) => {
      const timer = new FakeTimer();
      const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const manager = new FakeDeviceManager();
      manager.bootedDevices = [handset];
      const pool = new DevicePool(
        createDevicePoolDependencies(sessions, "release-retry-ownership", {
          timer,
          deviceSessionRepository: new FakeDeviceSessionRepository(),
          deviceManager: manager,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          retryExecutor: new DefaultRetryExecutor(timer),
        }),
      );
      const failure = new Error("release failed");
      const poolFailure = new Error("pool release failed");
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const free = spyOn(pool, "releaseDevice");
      if (scenario === "pool-failure") {
        free.mockRejectedValue(poolFailure);
      }
      let attempts = 0;
      try {
        await pool.initializeWithDevices([handset]);
        await pool.assignDeviceToSession("session", "android");
        const device = pool.getDevice(handset.deviceId)!;
        const retry = (
          pool as unknown as {
            retrySessionRelease(
              id: string,
              deviceId: string,
              attempt: () => Promise<void>,
            ): Promise<void>;
          }
        ).retrySessionRelease("session", handset.deviceId, async () => {
          attempts++;
          if (attempts === 1 && scenario !== "present") {
            await sessions.releaseSession("session", "daemon-shutdown");
            if (scenario === "new-owner") {
              device.sessionId = "other-session";
            }
            if (scenario === "new-assignment") {
              device.assignmentCount++;
            }
          }
          throw failure;
        });
        // Attach the rejection check before fake time advances through retries.
        const outcome = retry.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(await timer.resolvePromise(outcome, 1000)).toBe(failure);
        expect(attempts).toBe(3);
        expect(free).toHaveBeenCalledTimes(
          scenario === "removed" || scenario === "pool-failure" ? 1 : 0,
        );
        expect(device).toMatchObject({
          sessionId:
            scenario === "removed" ? null : scenario === "new-owner" ? "other-session" : "session",
          status: scenario === "removed" ? "idle" : "busy",
        });
        if (scenario === "pool-failure") {
          expect(warn).toHaveBeenCalledWith(
            `Failed to free device ${handset.deviceId} after session session release retries`,
            poolFailure,
          );
        }
      } finally {
        free.mockRestore();
        warn.mockRestore();
        sessions.stopCleanupTimer();
      }
    },
  );
});
