import { statusOf } from "../../src/daemon/deviceBinding";

import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { displayTransitions } from "../../src/features/observe/DisplayTransition";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { DeviceInfo } from "../../src/models";

import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  createBootedDevice,
  createDevicePoolSuite,
  devicePoolSuiteActions,
} from "../helpers/devicePoolSuite";

useSessionIdleWindowForSuite();

describe("DevicePool", () => {
  let devicePool: DevicePool;
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;
  let fakeAppsRepo: FakeInstalledAppsRepository;
  let fakeDeviceManager: FakeDeviceManager;
  const { initializeLiveDevices } = devicePoolSuiteActions(() => ({
    devicePool,
    sessionManager,
    fakeTimer,
    fakeAppsRepo,
    fakeDeviceManager,
  }));

  beforeEach(() => {
    ({ devicePool, sessionManager, fakeTimer, fakeAppsRepo, fakeDeviceManager } =
      createDevicePoolSuite());
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  describe("releaseDevice", () => {
    test("clears display identity before the same serial is assigned to a new session", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const deviceId = await devicePool.assignDeviceToSession("session-a");
      displayTransitions.record(deviceId, {
        display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
        screenSize: { width: 200, height: 200 },
      });
      await devicePool.releaseDevice(deviceId, "session-a");
      await devicePool.assignDeviceToSession("session-b");
      expect(displayTransitions.revision(deviceId)).toBe(0);
      expect(
        displayTransitions.checkIdentity(deviceId, {
          key: "cover",
          role: "cover",
          posture: "closed",
          generation: 1,
        }),
      ).toBe(false);
    });

    test("does not release a replacement allocation when an expected session no longer owns the device", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const deviceId = await devicePool.assignDeviceToSession("session-a");

      await sessionManager.releaseSession("session-a");
      await devicePool.releaseDevice(deviceId, "session-a");
      await devicePool.assignDeviceToSession("session-b");

      await devicePool.releaseDevice(deviceId, "session-a");

      expect(sessionManager.getSession("session-b")?.assignedDevice).toBe(deviceId);
      expect(devicePool.getDevice(deviceId)).toMatchObject({
        sessionId: "session-b",
        status: "busy",
      });
    });

    test("should release device assigned to session", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const deviceId = await devicePool.assignDeviceToSession("session-1");
      await devicePool.releaseDevice(deviceId, "session-1");
      const device = devicePool.getDevice(deviceId);
      expect(device?.sessionId).toBeNull();
      expect(device?.status).toBe("idle");
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
    });

    test("keeps repeated release idempotent", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      await devicePool.assignDeviceToSession("session-1");
      await devicePool.releaseDevice("emulator-5554", "session-1");
      await devicePool.releaseDevice("emulator-5554", "session-1");
      const device = devicePool.getDevice("emulator-5554");
      expect(device?.status).toBe("idle");
    });

    test("should handle release of non-existent device", async () => {
      await devicePool.releaseDevice("non-existent", "session-1");
      expect(devicePool.getTotalDeviceCount()).toBe(0);
    });

    test("does not release a replacement session after a duplicate stale release", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const deviceId = await devicePool.assignDeviceToSession("session-s");

      await devicePool.releaseDevice(deviceId, "session-s");
      await devicePool.assignDeviceToSession("session-t");
      await devicePool.releaseDevice(deviceId, "session-s");

      const device = devicePool.getDevice(deviceId);
      expect(device?.sessionId).toBe("session-t");
      expect(device?.status).toBe("busy");
      expect(devicePool.getAvailableDeviceCount()).toBe(0);
    });
  });

  describe("error tracking", () => {
    test("should record device error and increment error count", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
      const device = devicePool.getDevice("emulator-5554");
      expect(device?.errorCount).toBe(0);
      devicePool.recordDeviceError("emulator-5554");
      expect(device?.errorCount).toBe(1);
      expect(device?.status).toBe("idle");
    });

    test("should mark device as error after max consecutive errors", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
      const device = devicePool.getDevice("emulator-5554");
      // Record 5 errors to reach MAX_DEVICE_ERRORS (5)
      for (let i = 0; i < 5; i++) {
        devicePool.recordDeviceError("emulator-5554");
      }
      expect(device?.errorCount).toBe(5);
      expect(statusOf(device!)).toBe("error");
    });

    test("should clear error count when device assignment succeeds", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      devicePool.recordDeviceError("emulator-5554");
      expect(devicePool.getDevice("emulator-5554")?.errorCount).toBe(1);
      await devicePool.releaseDevice("emulator-5554", "session-1");
      await devicePool.assignDeviceToSession("session-1");
      expect(devicePool.getDevice("emulator-5554")?.errorCount).toBe(0);
    });

    test("should handle error recording for non-existent device", async () => {
      devicePool.recordDeviceError("non-existent");
      expect(devicePool.getTotalDeviceCount()).toBe(0);
    });
  });

  describe("statistics", () => {
    test("should return correct pool statistics", async () => {
      const deviceIds = ["emulator-5554", "emulator-5556", "emulator-5558"];
      await initializeLiveDevices(deviceIds.map((deviceId) => createBootedDevice(deviceId)));

      // Assign all 3 devices
      await devicePool.assignDeviceToSession("session-1");
      await devicePool.assignDeviceToSession("session-2");
      await devicePool.assignDeviceToSession("session-3");

      const stats = devicePool.getStats();
      expect(stats.total).toBe(3);
      expect(stats.idle).toBe(0);
      expect(stats.assigned).toBe(3);
      expect(stats.error).toBe(0);
    });
  });

  describe("session tracking", () => {
    test("should clear cache when device is removed", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);

      // Add some fake cache data
      await fakeAppsRepo.seedInstalledApp("emulator-5554", 0, "com.test.app", false, Date.now());
      const appsBefore = await fakeAppsRepo.listInstalledApps("emulator-5554");
      expect(appsBefore.length).toBe(1);

      // Remove device should clear cache
      await devicePool.removeDevice("emulator-5554");
      const appsAfter = await fakeAppsRepo.listInstalledApps("emulator-5554");
      expect(appsAfter.length).toBe(0);
    });
  });

  // #6227 round 7: `bindOrReuseDeviceSession` can hand back a live session
  // already bound to the exact requested device (`reuseExistingDeviceSession`)
  // instead of the caller's own session id. A later, less-demanding
  // acquisition of that same reused session (e.g. a `booted`-only or
  // `provisionDevice({ readiness: "none" })` caller) must not downgrade its
  // already-recorded `automationReady` readiness — `setDeviceReadiness` is
  // monotonic by achieved level, so recording the lower level afterward is a
  // no-op.
  describe("bindOrReuseDeviceSession reuse keeps readiness monotonic (#6227 round 7)", () => {
    test("readiness recorded for a reused live session is not downgraded", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);

      const firstBinding = await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-first",
        deviceId: "emulator-5554",
        platform: "android",
        sourceImage,
      });
      expect(firstBinding).toBe("session-first");
      sessionManager.setDeviceReadiness("session-first", "automationReady");
      expect(sessionManager.getDeviceReadiness("session-first")).toBe("automationReady");

      // A second, unrelated session id requests the same already-live device
      // without a fresh source image (mirrors a warm/already-booted
      // acquisition) — the pool hands back the existing session rather than
      // binding the new id.
      const secondBinding = await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-second",
        deviceId: "emulator-5554",
        platform: "android",
      });
      expect(secondBinding).toBe("session-first");

      // The caller that requested this acquisition only needed `booted` (or
      // ran `provisionDevice({ readiness: "none" })`), so it records that
      // lower achieved level on the session it got back — which is the
      // reused `session-first`, not its own requested id.
      sessionManager.setDeviceReadiness(secondBinding, "booted");

      expect(sessionManager.getDeviceReadiness("session-first")).toBe("automationReady");
    });
  });
});
