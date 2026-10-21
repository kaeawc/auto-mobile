import { makePool } from "../helpers/makePool";
import { drainMicrotasks, drainUntil, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { expect, test } from "bun:test";
import {
  DEVICE_CLEANUP_IN_PROGRESS_CODE,
  DeviceCleanupInProgressError,
} from "../../src/models/deviceAcquisitionRefusals";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { DaemonState } from "../../src/daemon/daemonState";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

for (const route of ["direct", "autolock", "setActiveDevice"] as const) {
  for (const cleanupKind of ["setup", "keep-awake", "biometric", "network"] as const) {
    for (const phase of ["release-in-flight", "pending-cleanup"] as const) {
      test(`rejects ${route} acquisition during ${phase} ${cleanupKind} and permits it after cleanup`, async () => {
        const previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        const timer = new FakeTimer();
        const finished = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        const restore = async () => {
          started.resolve();
          await finished.promise;
        };
        const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
          barrier: () => new FakeDbWriteBarrier(),
          keepScreenAwakeRestorer: () => ({
            restore: async () => {
              await restore();
              return { status: "restored" as const };
            },
          }),
          biometricEnrollmentRestorer: () => ({ restore }),
          restorers: { networkCondition: () => ({ restore }) },
        });
        const utils = new FakeDeviceUtils();
        const device = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" as const };
        utils.setBootedDevices("android", [device]);
        PlatformDeviceManagerFactory.setInstance(utils);
        const pool = makePool(manager, "daemon-test", {
          timer: timer,
          deviceManager: utils,
        });
        await pool.initializeWithDevices([device]);
        if (route === "setActiveDevice") {
          DaemonState.getInstance().initialize(manager, pool);
          ToolRegistry.clearTools();
          registerUtilityTools();
        }
        let setup: Promise<void> | undefined;
        let release: Promise<string | null> | undefined;
        try {
          await pool.bindOrReuseDeviceSession({
            sessionId: "old-owner",
            deviceId: device.deviceId,
            platform: "android",
          });
          if (cleanupKind === "setup") {
            setup = manager.trackSessionSetup(manager.getSession("old-owner")!, restore);
            await started.promise;
          } else if (cleanupKind === "keep-awake") {
            manager.setKeepScreenAwake("old-owner", { applied: true });
          } else if (cleanupKind === "biometric") {
            manager.setBiometricEnrollment("old-owner", { initialEnrollment: "not_enrolled" });
          } else {
            manager.setNetworkCondition("old-owner", { initialProfile: "none" });
          }
          if (phase === "release-in-flight") {
            timer.setCurrentTime(31 * 60 * 1000);
          }
          release = manager.releaseSession("old-owner", "lazy-expiry", { allowExpired: true });
          await started.promise;
          if (phase === "release-in-flight") {
            expect(manager.getSession("old-owner")).toBeNull();
          }
          if (phase === "pending-cleanup") {
            await drainUntil(() => timer.getPendingTimeouts().includes(1_000), {
              description: "bounded cleanup timeout parked",
            });
            timer.advanceTime(1000);
            await release;
            await pool.releaseDevice(device.deviceId, "old-owner");
            expect(manager.getPendingDeviceCleanup(device.deviceId)).not.toBeNull();
            expect(pool.getDevice(device.deviceId)?.status).toBe("busy");
            expect(pool.getStats().idle).toBe(0);
          }
          const acquire = async () =>
            route === "setActiveDevice"
              ? (await ToolRegistry.getTool("setActiveDevice")!.handler({
                  sessionUuid: "new-owner",
                  deviceId: device.deviceId,
                  platform: "android",
                }),
                "new-owner")
              : route === "direct"
                ? pool.bindOrReuseDeviceSession({
                    sessionId: "new-owner",
                    deviceId: device.deviceId,
                    platform: "android",
                    allowSessionRebind: true,
                  })
                : pool.autolockDevice(device.deviceId, "android", "new-client");
          // Typed and retryable, so clients wait on it like a held device (#10960).
          const refusal = await acquire().then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(refusal).toBeInstanceOf(DeviceCleanupInProgressError);
          expect(refusal).toMatchObject({
            code: DEVICE_CLEANUP_IN_PROGRESS_CODE,
            retryable: true,
            deviceId: device.deviceId,
          });
          expect((refusal as DeviceCleanupInProgressError).retryAfterMs).toBeGreaterThan(0);
          expect(pool.getDevice(device.deviceId)?.sessionId).toBe("old-owner");
          if (phase === "pending-cleanup") {
            expect(manager.getPendingDeviceCleanup(device.deviceId)).not.toBeNull();
          }
          finished.resolve();
          await setup;
          await release;
          await manager.getPendingDeviceCleanup(device.deviceId);
          const newOwner = await acquire();
          expect(pool.getDevice(device.deviceId)?.sessionId).toBe(newOwner);
          await pool.releaseDevice(device.deviceId, "old-owner");
          expect(pool.getDevice(device.deviceId)?.sessionId).toBe(newOwner);
        } finally {
          finished.resolve();
          await setup;
          await release;
          await manager.getPendingDeviceCleanup(device.deviceId);
          manager.stopCleanupTimer();
          PlatformDeviceManagerFactory.reset();
          if (route === "setActiveDevice") {
            DaemonState.getInstance().reset();
            ToolRegistry.clearTools();
          }
          if (previousAutolock === undefined) {
            delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
          } else {
            process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
          }
        }
      });
    }
  }
}

test("a bind during a capped pending cleanup is refused with the cleanup's remaining time (#10960)", async () => {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  const utils = new FakeDeviceUtils();
  const device = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" as const };
  utils.setBootedDevices("android", [device]);
  PlatformDeviceManagerFactory.setInstance(utils);
  const pool = makePool(manager, "daemon-test", { timer, deviceManager: utils });
  const cleanup = Promise.withResolvers<void>();
  try {
    await pool.initializeWithDevices([device]);
    await pool.bindOrReuseDeviceSession({
      sessionId: "test-1",
      deviceId: device.deviceId,
      platform: "android",
    });
    // A 12 s finalize (e.g. a recording) registered when test-1 is released.
    manager.onSessionRelease((_sessionId, deviceId) => {
      manager.registerPendingDeviceCleanup(deviceId, cleanup.promise, 12_000);
    });
    await manager.releaseSession("test-1", "superseded", { allowExpired: true });
    await pool.releaseDevice(device.deviceId, "test-1");
    timer.advanceTime(2_000);

    const bind = () =>
      pool.bindOrReuseDeviceSession({
        sessionId: "test-2",
        deviceId: device.deviceId,
        platform: "android",
      });
    const refusal = await bind().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(DeviceCleanupInProgressError);
    expect(refusal).toMatchObject({
      code: DEVICE_CLEANUP_IN_PROGRESS_CODE,
      retryable: true,
      retryAfterMs: 10_000,
    });

    cleanup.resolve();
    await manager.getPendingDeviceCleanup(device.deviceId);
    await bind();
    expect(pool.getDevice(device.deviceId)?.sessionId).toBe("test-2");
  } finally {
    cleanup.resolve();
    manager.stopCleanupTimer();
    PlatformDeviceManagerFactory.reset();
  }
});

// The deferred-release continuation relies on its own entry identity and on
// isCapturedReleaseCurrent's pooled-entry check, not on a separate devices.get guard (#11802).
// initializeWithDevices overwriting an entry mid-deferral is the way to reach this.
test("a deferred release never frees a same-id replacement entry after late teardown", async () => {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  const utils = new FakeDeviceUtils();
  const device = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" as const };
  utils.setBootedDevices("android", [device]);
  PlatformDeviceManagerFactory.setInstance(utils);
  const pool = makePool(manager, "daemon-test", { timer, deviceManager: utils });
  const cleanup = Promise.withResolvers<void>();
  try {
    await pool.initializeWithDevices([device]);
    await pool.bindOrReuseDeviceSession({
      sessionId: "test-1",
      deviceId: device.deviceId,
      platform: "android",
    });
    manager.onSessionRelease((_sessionId, deviceId) => {
      manager.registerPendingDeviceCleanup(deviceId, cleanup.promise, 12_000);
    });
    await manager.releaseSession("test-1", "superseded", { allowExpired: true });
    await pool.releaseDevice(device.deviceId, "test-1");

    const original = pool.getDevice(device.deviceId)!;
    expect(original.sessionId).toBe("test-1");
    const replacement = { ...original, incarnation: original.incarnation + 1 };
    pool.testHooks.devices.set(device.deviceId, replacement);

    cleanup.resolve();
    await manager.getPendingDeviceCleanup(device.deviceId);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(pool.getDevice(device.deviceId)).toBe(replacement);
    expect(replacement.sessionId).toBe("test-1");
    expect(original.sessionId).toBe("test-1");
    // The stale deferred entry is cleared, so it cannot keep reporting a hold on the replacement.
    expect(pool.testHooks.deferredDeviceReleases.has(device.deviceId)).toBe(false);
  } finally {
    cleanup.resolve();
    manager.stopCleanupTimer();
    PlatformDeviceManagerFactory.reset();
  }
});
