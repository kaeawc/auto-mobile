import { expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { DaemonState } from "../../src/daemon/daemonState";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

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
        const manager = new SessionManager(
          timer,
          new FakeDeviceSessionPersistence(),
          () => new FakeDbWriteBarrier(),
          () => ({ restore }),
          () => ({ restore }),
          () => ({ restore }),
        );
        const utils = new FakeDeviceUtils();
        const device = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" as const };
        utils.setBootedDevices("android", [device]);
        const pool = new DevicePool(manager, "daemon-test", timer, undefined, utils);
        await pool.initializeWithDevices([device]);
        if (route === "setActiveDevice") {
          DaemonState.getInstance().initialize(manager, pool);
          ToolRegistry.clearTools();
          registerUtilityTools();
        }
        let setup: Promise<void> | undefined;
        let release: Promise<string | null> | undefined;
        try {
          await pool.bindOrReuseDeviceSession("old-owner", device.deviceId, "android");
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
          release = manager.releaseSession("old-owner", "lazy-expiry", true);
          await started.promise;
          if (phase === "release-in-flight") {
            expect(manager.getSession("old-owner")).toBeNull();
          }
          if (phase === "pending-cleanup") {
            await timer.advanceTimeAsync(1000);
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
                ? pool.bindOrReuseDeviceSession(
                    "new-owner",
                    device.deviceId,
                    "android",
                    undefined,
                    undefined,
                    undefined,
                    true,
                  )
                : pool.autolockDevice(device.deviceId, "android", "new-client");
          await expect(acquire()).rejects.toThrow("cleanup");
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
