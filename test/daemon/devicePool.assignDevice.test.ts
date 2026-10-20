import { drainUntil, settleWithFakeTime } from "../helpers/fakeTimerStepping";

import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { Platform } from "../../src/models";

import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  CountingFakeDeviceManager,
  DeferredLivenessRecoveryDeviceManager,
  createBootedDevice,
  createDevicePoolSuite,
  devicePoolSuiteActions,
  enableRebootOnDeath,
} from "../helpers/devicePoolSuite";

useSessionIdleWindowForSuite();

describe("DevicePool", () => {
  let devicePool: DevicePool;
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;
  let fakeAppsRepo: FakeInstalledAppsRepository;
  let fakeDeviceManager: FakeDeviceManager;
  const { initializeLiveDevices, makePool } = devicePoolSuiteActions(() => ({
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

  describe("assignDeviceToSession", () => {
    test("should assign device to session when devices available", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const deviceId = await devicePool.assignDeviceToSession("session-1");
      expect(deviceId).toBe("emulator-5554");
      const device = devicePool.getDevice("emulator-5554");
      expect(device?.sessionId).toBe("session-1");
      expect(device?.status).toBe("busy");
      expect(device?.assignmentCount).toBe(1);
      expect(device?.errorCount).toBe(0);
    });

    test("concurrent same-session creation converges on one assigned device", async () => {
      await initializeLiveDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5556"),
      ]);

      const [first, second] = await Promise.all([
        sessionManager.getOrCreateSession("shared-session", devicePool),
        sessionManager.getOrCreateSession("shared-session", devicePool),
      ]);

      expect(first.sessionId).toBe("shared-session");
      expect(second).toBe(first);
      expect(first.assignedDevice).toBe(second.assignedDevice);
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
      expect(devicePool.getDevice(first.assignedDevice)?.status).toBe("busy");
    });

    test("does not reserve a second device when binding an automatically created session", async () => {
      await initializeLiveDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5556"),
      ]);

      const session = await sessionManager.getOrCreateSession("shared-session", devicePool);
      const otherDeviceId =
        session.assignedDevice === "emulator-5554" ? "emulator-5556" : "emulator-5554";

      await expect(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "shared-session",
          deviceId: otherDeviceId,
          platform: "android",
        }),
      ).rejects.toThrow(
        `Session 'shared-session' is already assigned to device '${session.assignedDevice}'.`,
      );

      expect(devicePool.getAvailableDeviceCount()).toBe(1);
      expect(devicePool.getDevice(otherDeviceId)).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    });

    test("keeps an explicit binding as the sole owner during automatic creation", async () => {
      await initializeLiveDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5556"),
      ]);

      const explicitBinding = devicePool.bindOrReuseDeviceSession({
        sessionId: "shared-session",
        deviceId: "emulator-5556",
        platform: "android",
      });
      const automaticCreation = sessionManager.getOrCreateSession("shared-session", devicePool);
      const [boundSession, session] = await Promise.all([explicitBinding, automaticCreation]);

      expect(boundSession).toBe("shared-session");
      expect(session.assignedDevice).toBe("emulator-5556");
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    });

    test("restores the pooled device when session persistence rejects", async () => {
      sessionManager.stopCleanupTimer();
      const sessionPersistence = new FakeDeviceSessionPersistence();
      sessionPersistence.failure = "create";
      sessionManager = new SessionManager(fakeTimer, sessionPersistence);
      devicePool = makePool();
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const before = devicePool.getDevice("emulator-5554");
      const previousAssignment = {
        sessionId: before?.sessionId,
        status: before?.status,
        assignmentCount: before?.assignmentCount,
        errorCount: before?.errorCount,
        lastUsedAt: before?.lastUsedAt,
      };

      await expect(devicePool.assignDeviceToSession("session-failure")).rejects.toThrow(
        "persist create failed",
      );

      expect(devicePool.getDevice("emulator-5554")).toMatchObject(previousAssignment);
      expect(sessionManager.getSession("session-failure")).toBeNull();
      expect(sessionManager.getSessionForDevice("emulator-5554")).toBeNull();
    });

    test("should throw error when no devices available after timeout", async () => {
      // Use manual mode so we can control time advancement

      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      await devicePool.assignDeviceToSession("session-1");

      // Start the second assignment (will wait for a device)
      let error: Error | null = null;
      const assignPromise = devicePool.assignDeviceToSession("session-2").catch((e) => {
        error = e as Error;
      });

      await drainUntil(() => fakeTimer.getPendingSleepCount() > 0, {
        description: "busy-device retry sleep",
      });
      await settleWithFakeTime(fakeTimer, assignPromise, {
        stepMs: 1000,
        maxSteps: 70,
        description: "busy-device allocation timeout",
      });

      expect(error).not.toBeNull();
      expect(error!.message).toContain("Timed out waiting for device");
    });

    test("should wait and succeed when device becomes available", async () => {
      // Use manual mode so we can control time advancement

      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const device1 = await devicePool.assignDeviceToSession("session-1");

      // Start the second assignment (will wait for a device)
      const assignPromise = devicePool.assignDeviceToSession("session-2");

      // Advance time a few iterations
      for (let i = 0; i < 5; i++) {
        await drainUntil(() => fakeTimer.getPendingSleepCount() > 0, {
          description: "busy-device retry sleep",
        });
        expect(fakeTimer.getPendingSleeps()).toEqual([1_000]);
        fakeTimer.advanceTime(1000);
        await drainUntil(() => fakeTimer.getPendingSleepCount() > 0, {
          description: "next busy-device retry sleep",
        });
      }

      // Release the device
      await devicePool.releaseDevice(device1, "session-1");

      // Advance time to allow the retry
      expect(fakeTimer.getPendingSleeps()).toEqual([1_000]);
      fakeTimer.advanceTime(1000);

      // Now the assignment should succeed
      const device2 = await assignPromise;
      expect(device2).toBe("emulator-5554");
    });

    test("should assign different devices to different sessions", async () => {
      const deviceIds = ["emulator-5554", "emulator-5556"];
      await initializeLiveDevices(deviceIds.map((deviceId) => createBootedDevice(deviceId)));
      const device1 = await devicePool.assignDeviceToSession("session-1");
      const device2 = await devicePool.assignDeviceToSession("session-2");
      expect(device1).not.toBe(device2);
      expect(devicePool.getAvailableDeviceCount()).toBe(0);
    });

    test("should reuse device after session release", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const device1 = await devicePool.assignDeviceToSession("session-1");
      await devicePool.releaseDevice(device1, "session-1");
      const device2 = await devicePool.assignDeviceToSession("session-2");
      expect(device1).toBe(device2);
    });

    test("skips a released iOS simulator and leaves eviction to confirmed refresh misses", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-old", "ios", "iPhone 15"),
        createBootedDevice("sim-new", "ios", "iPhone 16"),
      ]);
      fakeDeviceManager.bootedDevices = [
        createBootedDevice("sim-old", "ios", "iPhone 15"),
        createBootedDevice("sim-new", "ios", "iPhone 16"),
      ];

      const firstDevice = await devicePool.assignDeviceToSession("session-1", "ios");
      expect(firstDevice).toBe("sim-old");
      await devicePool.releaseDevice(firstDevice, "session-1");
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-new", "ios", "iPhone 16")];

      const secondDevice = await devicePool.assignDeviceToSession("session-2", "ios");

      expect(secondDevice).toBe("sim-new");
      expect(devicePool.getDevice("sim-old")?.sessionId).toBeNull();
      expect(devicePool.getDevice("sim-new")?.sessionId).toBe("session-2");
      for (let miss = 0; miss < 3; miss++) {
        await devicePool.refreshDevices();
      }
      expect(devicePool.getDevice("sim-old")).toBeNull();
    });

    // A handset serial is unique, so it never needs the emulator's identity
    // reconciliation — but it still has to be PRESENT. Unplugging one after the
    // last refresh must not leave it assignable (#6863 review).
    test("does not assign a pooled physical handset that was unplugged after the last refresh", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("R5CT10ABCDE", "android", "SM-S911B"),
      ]);
      fakeDeviceManager.bootedDevices = [];

      fakeTimer.enableAutoAdvance();
      await expect(devicePool.assignDeviceToSession("session-1", "android")).rejects.toThrow();

      expect(devicePool.getDevice("R5CT10ABCDE")).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("does not assign but retains a pooled iOS simulator when liveness discovery fails", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [];
      fakeDeviceManager.failedPlatforms = new Set<Platform>(["ios"]);

      await expect(devicePool.assignDeviceToSession("session-1", "ios")).rejects.toThrow(
        /Unable to verify iOS simulator liveness/,
      );

      expect(devicePool.getDevice("sim-1")?.status).toBe("idle");
      expect(devicePool.getDevice("sim-1")?.sessionId).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("validates multiple idle iOS candidates with one liveness discovery snapshot", async () => {
      const countingDeviceManager = new CountingFakeDeviceManager(
        [],
        [createBootedDevice("sim-live", "ios", "iPhone 16")],
      );
      devicePool = makePool({ deviceManager: countingDeviceManager });
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-stale", "ios", "iPhone 15"),
        createBootedDevice("sim-live", "ios", "iPhone 16"),
      ]);

      const deviceId = await devicePool.assignDeviceToSession("session-1", "ios");

      expect(deviceId).toBe("sim-live");
      expect(devicePool.getDevice("sim-stale")?.sessionId).toBeNull();
      expect(countingDeviceManager.detailedBootedCalls).toBe(1);
    });

    test("evicts a stale idle Android emulator before assigning it", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
      ]);
      fakeDeviceManager.bootedDevices = [];

      fakeTimer.enableAutoAdvance();
      await expect(devicePool.assignDeviceToSession("session-1", "android")).rejects.toThrow(
        /No healthy android devices|No devices in pool/,
      );

      expect(devicePool.getDevice("emulator-5554")).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("skips stale idle Android emulator and assigns the next live candidate", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
        createBootedDevice("emulator-5556", "android", "Pixel 9"),
      ]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("emulator-5556", "android", "Pixel 9")];

      const deviceId = await devicePool.assignDeviceToSession("session-1", "android");

      expect(deviceId).toBe("emulator-5556");
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBeNull();
      expect(devicePool.getDevice("emulator-5556")?.sessionId).toBe("session-1");
      for (let miss = 0; miss < 3; miss++) {
        await devicePool.refreshDevices();
      }
      expect(devicePool.getDevice("emulator-5554")).toBeNull();
    });

    test("assigns an unrelated healthy emulator while stale-device recovery is pending", async () => {
      const restoreRebootOnDeath = enableRebootOnDeath();
      const stale = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const healthy = createBootedDevice("emulator-5556", "android", "Pixel 9");
      const manager = new DeferredLivenessRecoveryDeviceManager(
        [{ name: "Pixel 8", platform: "android", isRunning: false, source: "local" }],
        [healthy],
      );
      devicePool = makePool({ deviceManager: manager });
      try {
        await devicePool.addDevice(stale, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        await devicePool.addDevice(healthy);
        // Missing recovery is owned by the refresh threshold, not allocation's
        // pre-lock snapshot. The detached reboot must still leave allocation free.
        for (let miss = 0; miss < 3; miss++) {
          await devicePool.refreshDevices();
        }

        await expect(devicePool.assignDeviceToSession("session-1", "android")).resolves.toBe(
          "emulator-5556",
        );
        await manager.waitForRecoveryStart();
        expect(manager.startedDevices).toHaveLength(1);
      } finally {
        manager.releaseRecovery();
        restoreRebootOnDeath();
      }
    });
  });
});
