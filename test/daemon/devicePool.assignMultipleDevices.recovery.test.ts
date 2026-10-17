import { statusOf } from "../../src/daemon/deviceBinding";
import { drainUntil, settleWithFakeTime } from "../helpers/fakeTimerStepping";

import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { DeviceInfo } from "../../src/models";

import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  DeferredRecoveryDeviceManager,
  DeferredRecoveryDeviceManagerWithStubbornChild,
  DeferredRecoveryDeviceManagerWithStubbornFailingReadiness,
  FakeDeviceManagerWithCancelledLaunch,
  FakeDeviceManagerWithFailingReadiness,
  FakeDeviceManagerWithMinimalReadyDevice,
  FakeDeviceManagerWithPendingReadiness,
  FakeDeviceManagerWithPendingStart,
  FakeDeviceManagerWithStubbornFailingReadiness,
  FakeDeviceManagerWithStubbornProcess,
  RunningProbeCountingFakeDeviceManager,
  androidDeviceImage,
  createBootedDevice,
  createDevicePoolSuite,
  devicePoolSuiteActions,
  enableRebootOnDeath,
  iosSimulatorImage,
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

  const useRecoveryManager = (
    manager: DeferredRecoveryDeviceManager,
    overrides: Parameters<typeof makePool>[0] = {},
  ): void => {
    manager.deviceImages = [androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" })];
    devicePool = makePool({ deviceManager: manager, ...overrides });
  };

  /** Allocate and release emulator-5554, drop it, and wait until the replacement recovery starts. */
  const startRecoveryOf = async (
    manager: DeferredRecoveryDeviceManager,
    options: { observeRejection?: boolean } = {},
  ) => {
    await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
    await devicePool.releaseDevice("emulator-5554", "session-1");
    const recovery = devicePool.removeDisconnectedDevice("emulator-5554", false);
    if (options.observeRejection) {
      // Attach before waiting so an early rejection is never unhandled; the test asserts on it later.
      void recovery.catch(() => {});
    }
    await manager.waitForRecoveryStart();
    return { recovery };
  };

  beforeEach(() => {
    ({ devicePool, sessionManager, fakeTimer, fakeAppsRepo, fakeDeviceManager } =
      createDevicePoolSuite());
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  describe("assignMultipleDevices", () => {
    test("cancels an in-flight recovery after an intentional shutdown", async () => {
      const restoreRebootOnDeath = enableRebootOnDeath();
      const manager = new DeferredRecoveryDeviceManager();
      useRecoveryManager(manager);
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await manager.waitForRecoveryStart();

        devicePool.markIntentionalShutdown("emulator-5554");
        manager.releaseRecovery();
        await drainUntil(() => devicePool.getRecoveringAndroidTargets().names.size === 0, {
          description: "owned recovery settlement",
        });

        expect(manager.childProcesses).toHaveLength(2);
        expect(manager.childProcesses[1]!.killCount).toBe(1);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
      } finally {
        manager.releaseRecovery();
        restoreRebootOnDeath();
      }
    });

    test("holds the recovery lease until a preempted emulator process exits", async () => {
      const restoreRebootOnDeath = enableRebootOnDeath();
      const manager = new DeferredRecoveryDeviceManagerWithStubbornChild();
      const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(fakeTimer);
      useRecoveryManager(manager, { lifecycleCoordinator });
      try {
        const { recovery } = await startRecoveryOf(manager);
        let teardownAcquired = false;
        const teardown = lifecycleCoordinator
          .reserve(
            { kind: "stable", platform: "android", stableId: "Pixel 8" },
            { operation: "teardown", deadlineMs: 300_000 },
          )
          .then((lease) => {
            teardownAcquired = true;
            return lease;
          });
        await manager.recoveryChild.sigtermSent.promise;

        expect(manager.recoveryChild.signals).toEqual(["SIGTERM"]);
        expect(teardownAcquired).toBe(false);

        manager.recoveryChild.exitCode = 0;
        manager.recoveryChild.emit("exit", 0, null);
        await expect(recovery).resolves.toBeUndefined();
        const teardownLease = await teardown;
        teardownLease.release();
        expect(teardownAcquired).toBe(true);
      } finally {
        manager.releaseRecovery();
        restoreRebootOnDeath();
      }
    });

    test("retains a preempted recovery lease after bounded stop failure until late exit", async () => {
      const restoreRebootOnDeath = enableRebootOnDeath();
      const manager = new DeferredRecoveryDeviceManagerWithStubbornChild();
      const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(fakeTimer);
      useRecoveryManager(manager, { lifecycleCoordinator });
      try {
        const { recovery } = await startRecoveryOf(manager, { observeRejection: true });
        let teardownAcquired = false;
        const teardown = lifecycleCoordinator
          .reserve(
            { kind: "stable", platform: "android", stableId: "Pixel 8" },
            { operation: "teardown", deadlineMs: 300_000 },
          )
          .then((lease) => {
            teardownAcquired = true;
            return lease;
          });
        await manager.recoveryChild.sigtermSent.promise;
        expect(fakeTimer.getPendingTimeouts()).toContain(1_000);
        fakeTimer.advanceTime(1_000);
        await drainUntil(
          () =>
            manager.recoveryChild.signals.includes("SIGKILL") &&
            fakeTimer.getPendingTimeouts().includes(1_000),
          { description: "SIGKILL exit timeout parked" },
        );
        fakeTimer.advanceTime(1_000);

        await expect(recovery).rejects.toThrow("did not exit after SIGKILL");
        expect(manager.recoveryChild.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(teardownAcquired).toBe(false);

        manager.recoveryChild.exitCode = 0;
        manager.recoveryChild.emit("exit", 0, null);
        const teardownLease = await teardown;
        teardownLease.release();
        expect(teardownAcquired).toBe(true);
      } finally {
        manager.releaseRecovery();
        restoreRebootOnDeath();
      }
    });

    test("does not re-terminate a recovery child that already exited by signal", async () => {
      const restoreRebootOnDeath = enableRebootOnDeath();
      const manager = new DeferredRecoveryDeviceManager();
      useRecoveryManager(manager);
      try {
        const { recovery } = await startRecoveryOf(manager);
        devicePool.markIntentionalShutdown("emulator-5554");
        const recoveryChild = manager.childProcesses[1]!;
        recoveryChild.exitCode = null;
        recoveryChild.signalCode = "SIGTERM";
        recoveryChild.emit("exit", null, "SIGTERM");
        manager.releaseRecovery();

        await expect(recovery).resolves.toBeUndefined();
        expect(recoveryChild.killCount).toBe(0);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
      } finally {
        manager.releaseRecovery();
        restoreRebootOnDeath();
      }
    });

    test("does not retry recovery when cancelling the owned child fails", async () => {
      const restoreRebootOnDeath = enableRebootOnDeath();
      const manager = new DeferredRecoveryDeviceManagerWithStubbornChild();
      useRecoveryManager(manager);
      try {
        const { recovery } = await startRecoveryOf(manager);
        devicePool.markIntentionalShutdown("emulator-5554");
        manager.releaseRecovery();

        await expect(
          settleWithFakeTime(fakeTimer, recovery, {
            stepMs: 1000,
            maxSteps: 2,
            description: "owned child bounded stop",
          }),
        ).rejects.toThrow("did not exit after SIGKILL");
        expect(manager.childProcesses).toHaveLength(2);
        expect(manager.recoveryChild.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
        manager.recoveryChild.exitCode = 0;
        manager.recoveryChild.emit("exit", 0, null);
        await drainUntil(() => devicePool.getRecoveringAndroidTargets().names.size === 0, {
          description: "late exit releases retained recovery lease",
        });
      } finally {
        manager.releaseRecovery();
        restoreRebootOnDeath();
      }
    });

    test("stops the owned child when cancellation coincides with readiness failure", async () => {
      const restoreRebootOnDeath = enableRebootOnDeath();
      const manager = new DeferredRecoveryDeviceManagerWithStubbornFailingReadiness();
      useRecoveryManager(manager);
      try {
        const { recovery } = await startRecoveryOf(manager);
        devicePool.markIntentionalShutdown("emulator-5554");
        manager.releaseRecovery();

        await expect(
          settleWithFakeTime(fakeTimer, recovery, {
            stepMs: 1000,
            maxSteps: 2,
            description: "owned child bounded stop",
          }),
        ).rejects.toThrow("did not exit after SIGKILL");
        expect(manager.childProcesses).toHaveLength(2);
        expect(manager.recoveryChild.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
        manager.recoveryChild.exitCode = 0;
        manager.recoveryChild.emit("exit", 0, null);
        await drainUntil(() => devicePool.getRecoveringAndroidTargets().names.size === 0, {
          description: "late exit releases retained recovery lease",
        });
      } finally {
        manager.releaseRecovery();
        restoreRebootOnDeath();
      }
    });

    test("does not relaunch an AVD while its old emulator process survives SIGKILL", async () => {
      const restoreRebootOnDeath = enableRebootOnDeath();
      const manager = new FakeDeviceManagerWithStubbornProcess([
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ]);
      const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(fakeTimer);
      let childExited = false;
      devicePool = makePool({ deviceManager: manager, lifecycleCoordinator: lifecycleCoordinator });
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        await devicePool.releaseDevice("emulator-5554", "session-1");
        manager.bootedDevices = [];

        await settleWithFakeTime(
          fakeTimer,
          devicePool.removeDisconnectedDevice("emulator-5554", false),
          { stepMs: 1000, maxSteps: 2, description: "stubborn process bounded stop" },
        );

        expect(manager.startedDevices).toHaveLength(1);
        expect(manager.childProcess.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();

        const teardown = lifecycleCoordinator.reserve(
          { kind: "stable", platform: "android", stableId: "Pixel 8" },
          { operation: "teardown", deadlineMs: fakeTimer.now() + 1_000 },
        );
        let teardownAcquired = false;
        void teardown.then(() => {
          teardownAcquired = true;
        });
        for (let attempt = 0; attempt < 50; attempt++) {
          await Promise.resolve();
        }
        expect(teardownAcquired).toBe(false);

        manager.childProcess.emit("exit", 0, null);
        childExited = true;
        const teardownLease = await teardown;
        teardownLease.release();
      } finally {
        if (!childExited) {
          manager.childProcess.emit("exit", 0, null);
          await Promise.resolve();
        }
        restoreRebootOnDeath();
      }
    });

    test("same-serial rediscovery clears suppression for the authoritative AVD name", async () => {
      const restoreRebootOnDeath = enableRebootOnDeath();
      const image: DeviceInfo = androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" });
      const manager = new FakeDeviceManager([image]);
      devicePool = makePool({
        deviceManager: manager,
        androidDeviceReboot: { run: async () => false },
      });
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        await devicePool.releaseDevice("emulator-5554", "session-1");
        manager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice("emulator-5554", false);

        await expect(
          devicePool.assignMultipleDevices(["session-suppressed"], 1_000, "android"),
        ).rejects.toThrow("Not enough devices in pool");
        expect(manager.startedDevices).toHaveLength(1);

        manager.bootedDevices = [
          {
            name: "Pixel 8",
            platform: "android",
            deviceId: "emulator-5554",
          },
        ];
        await devicePool.refreshDevices();
        await devicePool.removeDevice("emulator-5554");
        manager.bootedDevices = [];

        await expect(
          devicePool.assignMultipleDevices(["session-2"], 1_000, "android"),
        ).resolves.toEqual(new Map([["session-2", "emulator-5554"]]));
        expect(manager.startedDevices).toHaveLength(2);
      } finally {
        restoreRebootOnDeath();
      }
    });

    test("same-serial rediscovery keeps suppression for a different AVD", async () => {
      const restoreRebootOnDeath = enableRebootOnDeath();
      const image: DeviceInfo = androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" });
      const manager = new FakeDeviceManager([image]);
      devicePool = makePool({
        deviceManager: manager,
        androidDeviceReboot: { run: async () => false },
      });
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        await devicePool.releaseDevice("emulator-5554", "session-1");
        manager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice("emulator-5554", false);

        manager.bootedDevices = [
          {
            name: "Pixel 9",
            platform: "android",
            deviceId: "emulator-5554",
          },
        ];
        await devicePool.refreshDevices();
        await devicePool.removeDevice("emulator-5554");
        manager.bootedDevices = [];

        await expect(
          devicePool.assignMultipleDevices(["session-2"], 1_000, "android"),
        ).rejects.toThrow("Not enough devices in pool");
        expect(manager.startedDevices).toHaveLength(1);
      } finally {
        restoreRebootOnDeath();
      }
    });

    test("cancels the boot (kills the spawned handle) when a pool cold-boot fails readiness", async () => {
      const images: DeviceInfo[] = [
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ];
      const manager = new FakeDeviceManagerWithFailingReadiness(images);
      devicePool = makePool({ deviceManager: manager });

      // No pre-booted devices: the pool must cold-boot one, readiness then fails.
      // Allocation cannot be satisfied (throws), but the half-booted device must
      // have been torn back down via handle.kill() (issue #3952).
      await expect(
        devicePool.assignMultipleDevices(["session-1"], 1000, "android"),
      ).rejects.toThrow();
      expect(manager.childProcess.killCount).toBe(1);
    });

    test("retains a failed pool-start lease until the stubborn emulator exits", async () => {
      const image: DeviceInfo = androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" });
      const manager = new FakeDeviceManagerWithStubbornFailingReadiness([image]);
      const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(fakeTimer);
      devicePool = makePool({ deviceManager: manager, lifecycleCoordinator: lifecycleCoordinator });

      const allocation = devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      const allocationOutcome = allocation.then(
        () => undefined,
        (error: unknown) => error,
      );
      await drainUntil(
        () =>
          manager.childProcess.signals.includes("SIGTERM") &&
          fakeTimer.getPendingTimeouts().includes(1_000),
        { description: "pool-start SIGTERM exit timeout parked" },
      );
      expect(manager.childProcess.signals).toEqual(["SIGTERM"]);
      fakeTimer.advanceTime(1_000);
      await drainUntil(
        () =>
          manager.childProcess.signals.includes("SIGKILL") &&
          fakeTimer.getPendingTimeouts().includes(1_000),
        { description: "pool-start SIGKILL exit timeout parked" },
      );
      expect(manager.childProcess.signals).toEqual(["SIGTERM", "SIGKILL"]);
      fakeTimer.advanceTime(1_000);
      expect(await allocationOutcome).toBeInstanceOf(Error);

      const teardown = lifecycleCoordinator.reserve(
        { kind: "stable", platform: "android", stableId: image.name },
        { operation: "teardown", deadlineMs: 3_000 },
      );
      let teardownAcquired = false;
      void teardown.then(() => {
        teardownAcquired = true;
      });
      for (let attempt = 0; attempt < 50; attempt++) {
        await Promise.resolve();
      }
      expect(teardownAcquired).toBe(false);

      manager.childProcess.emit("exit", 0, null);
      const teardownLease = await teardown;
      teardownLease.release();
    });

    test("retains a cancelled pool-start launch's lease until its emulator exits (#10075)", async () => {
      const image: DeviceInfo = androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" });
      const manager = new FakeDeviceManagerWithCancelledLaunch([image]);
      const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(fakeTimer);
      devicePool = makePool({ deviceManager: manager, lifecycleCoordinator: lifecycleCoordinator });

      const allocation = devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      const allocationOutcome = allocation.then(
        () => undefined,
        (error: unknown) => error,
      );
      await drainUntil(
        () =>
          manager.childProcess.signals.includes("SIGTERM") &&
          fakeTimer.getPendingTimeouts().includes(1_000),
        { description: "cancelled-launch SIGTERM exit timeout parked" },
      );
      fakeTimer.advanceTime(1_000);
      await drainUntil(() => manager.childProcess.signals.includes("SIGKILL"), {
        description: "cancelled-launch SIGKILL sent",
      });
      expect(manager.childProcess.signals).toEqual(["SIGTERM", "SIGKILL"]);
      fakeTimer.advanceTime(1_000);
      expect(await allocationOutcome).toBeInstanceOf(Error);

      const teardown = lifecycleCoordinator.reserve(
        { kind: "stable", platform: "android", stableId: image.name },
        { operation: "teardown", deadlineMs: 3_000 },
      );
      let teardownAcquired = false;
      void teardown.then(() => {
        teardownAcquired = true;
      });
      for (let attempt = 0; attempt < 50; attempt++) {
        await Promise.resolve();
      }
      expect(teardownAcquired).toBe(false);

      manager.childProcess.emit("exit", 0, null);
      const teardownLease = await teardown;
      teardownLease.release();
    });

    test("bounds a pending pool cold-boot readiness wait by the allocation deadline", async () => {
      const image: DeviceInfo = androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" });
      const manager = new FakeDeviceManagerWithPendingReadiness([image]);
      devicePool = makePool({ deviceManager: manager });

      const allocation = devicePool.assignMultipleDevices(["session-1"], 1_000, "android");

      await settleWithFakeTime(
        fakeTimer,
        allocation.then(
          () => undefined,
          () => undefined,
        ),
        { stepMs: 100, maxSteps: 10, description: "pool cold-boot allocation deadline" },
      );
      await expect(allocation).rejects.toThrow();
      expect(fakeTimer.now()).toBe(1_000);
      expect(manager.childProcess.killCount).toBe(1);
    });

    test("aborts a pending pool cold-boot start at the allocation deadline", async () => {
      const image: DeviceInfo = {
        name: "Pixel 8",
        platform: "ios",
        isRunning: false,
        deviceId: "sim-1234",
        source: "local",
      };
      const manager = new FakeDeviceManagerWithPendingStart([image]);
      devicePool = makePool({ deviceManager: manager });

      const allocation = devicePool.assignMultipleDevices(["session-1"], 1_000, "ios");

      await settleWithFakeTime(
        fakeTimer,
        allocation.then(
          () => undefined,
          () => undefined,
        ),
        { stepMs: 100, maxSteps: 10, description: "pool cold-boot allocation deadline" },
      );
      await expect(allocation).rejects.toThrow();
      expect(manager.startObservedAbort).toBe(true);
    });

    test("boots replacement emulator after stale pooled emulator is evicted before allocation", async () => {
      const images: DeviceInfo[] = [
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ];
      const manager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = makePool({ deviceManager: manager });
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
      ]);

      const assignments = await devicePool.assignMultipleDevices(["session-1"], 1000, "android");

      expect(assignments.get("session-1")).toBe("emulator-5554");
      expect(manager.startedDevices.map((device) => device.deviceId)).toEqual(["emulator-5554"]);
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBe("session-1");
    });

    test("boots criteria replacement emulator after stale matching pooled emulator is evicted", async () => {
      const images: DeviceInfo[] = [
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ];
      const manager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = makePool({ deviceManager: manager });
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
      ]);

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [{ sessionId: "session-1", criteria: { platform: "android" } }],
        1000,
      );

      expect(assignments.get("session-1")).toBe("emulator-5554");
      expect(manager.startedDevices.map((device) => device.deviceId)).toEqual(["emulator-5554"]);
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBe("session-1");
    });

    test("should auto-start iOS simulators when pool is short", async () => {
      const images: DeviceInfo[] = [
        iosSimulatorImage("iPhone 15 Pro", "sim-1"),
        iosSimulatorImage("iPhone 15", "sim-2"),
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = makePool({ deviceManager: fakeDeviceManager });

      const assignments = await devicePool.assignMultipleDevices(
        ["session-a", "session-b"],
        1000,
        "ios",
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(assignments.get("session-b")).toBe("sim-2");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual([
        "sim-1",
        "sim-2",
      ]);
      expect(fakeDeviceManager.startDeviceTimeouts).toEqual([1000, 1000]);
      expect(devicePool.getTotalDeviceCount()).toBe(2);
    });

    test("selects a known-not-running image without a per-image running probe", async () => {
      const image: DeviceInfo = androidDeviceImage("Pixel 8", "emulator-5554");
      const manager = new RunningProbeCountingFakeDeviceManager([image]);
      devicePool = makePool({ deviceManager: manager });

      const assignments = await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");

      expect(assignments.get("session-1")).toBe("emulator-5554");
      expect(manager.runningProbeCalls).toBe(0);
    });

    test("should boot a platform replacement when a stale pooled iOS simulator masked the shortage", async () => {
      const images: DeviceInfo[] = [iosSimulatorImage("iPhone 16", "sim-replacement")];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = makePool({ deviceManager: fakeDeviceManager });
      await devicePool.initializeWithDevices([createBootedDevice("sim-stale", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [];

      const assignments = await devicePool.assignMultipleDevices(["session-a"], 1000, "ios");

      expect(assignments.get("session-a")).toBe("sim-replacement");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual([
        "sim-replacement",
      ]);
      expect(devicePool.getDevice("sim-stale")).toBeNull();
    });

    test("should boot shutdown iOS simulator matching allocation criteria", async () => {
      const images: DeviceInfo[] = [
        iosSimulatorImage("iPhone 15", "sim-wrong-type", { iosVersion: "17.5" }),
        iosSimulatorImage("iPhone 15 Pro", "sim-wrong-version", { iosVersion: "17.4" }),
        iosSimulatorImage("iPhone 15 Pro", "sim-unavailable", {
          state: "Unavailable",
          isAvailable: false,
          iosVersion: "17.5",
        }),
        iosSimulatorImage("iPhone 15 Pro", "sim-1", { iosVersion: "17.5" }),
      ];
      const fakeDeviceManager = new FakeDeviceManager(images);
      devicePool = makePool({ deviceManager: fakeDeviceManager });

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual(["sim-1"]);
      expect(fakeDeviceManager.startDeviceTimeouts).toEqual([1000]);
      expect(devicePool.getDevice("sim-1")?.iosVersion).toBe("17.5");
    });

    test("should use osVersion as iOS criteria metadata after booting a shutdown simulator", async () => {
      const images: DeviceInfo[] = [
        iosSimulatorImage("iPhone 15 Pro", "sim-1", { osVersion: "17.5" }),
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = makePool({ deviceManager: fakeDeviceManager });

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(devicePool.getDevice("sim-1")?.iosVersion).toBe("17.5");
    });

    test("should use runtime as iOS criteria metadata after booting a shutdown simulator", async () => {
      const images: DeviceInfo[] = [
        iosSimulatorImage("iPhone 15 Pro", "sim-1", {
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-5",
        }),
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = makePool({ deviceManager: fakeDeviceManager });

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(devicePool.getDevice("sim-1")?.iosVersion).toBe("17.5");
    });

    test("should preserve deviceType matching metadata after booting a custom-named simulator", async () => {
      const images: DeviceInfo[] = [
        iosSimulatorImage("QA Phone", "sim-1", {
          iosVersion: "17.5",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
        }),
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = makePool({ deviceManager: fakeDeviceManager });

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(devicePool.getDevice("sim-1")?.name).toBe("QA Phone");
      expect(devicePool.getDevice("sim-1")?.simulatorType).toBe("iPhone 15 Pro");
    });

    test("should boot replacement simulator when matching pooled simulator is in error", async () => {
      const images: DeviceInfo[] = [
        iosSimulatorImage("iPhone 15 Pro", "sim-replacement", { iosVersion: "17.5" }),
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = makePool({ deviceManager: fakeDeviceManager });
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-failed", "ios", "iPhone 15 Pro", "17.5"),
      ]);
      for (let i = 0; i < 5; i++) {
        devicePool.recordDeviceError("sim-failed");
      }

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-replacement");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual([
        "sim-replacement",
      ]);
      expect(statusOf(devicePool.getDevice("sim-failed")!)).toBe("error");
    });

    test("should boot a criteria replacement when a stale pooled iOS simulator matched first", async () => {
      const images: DeviceInfo[] = [
        iosSimulatorImage("iPhone 15 Pro", "sim-replacement", { iosVersion: "17.5" }),
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = makePool({ deviceManager: fakeDeviceManager });
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-stale", "ios", "iPhone 15 Pro", "17.5"),
      ]);
      fakeDeviceManager.bootedDevices = [];

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-replacement");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual([
        "sim-replacement",
      ]);
      expect(devicePool.getDevice("sim-stale")).toBeNull();
    });

    test("should recover errored pooled simulator when its own image is rebooted", async () => {
      const images: DeviceInfo[] = [
        iosSimulatorImage("iPhone 15 Pro", "sim-1", { iosVersion: "17.5" }),
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = makePool({ deviceManager: fakeDeviceManager });
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15 Pro", "17.5"),
      ]);
      for (let i = 0; i < 5; i++) {
        devicePool.recordDeviceError("sim-1");
      }
      expect(statusOf(devicePool.getDevice("sim-1")!)).toBe("error");

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual(["sim-1"]);
      expect(devicePool.getDevice("sim-1")?.status).toBe("busy");
      expect(devicePool.getDevice("sim-1")?.errorCount).toBe(0);
    });

    test("should fail criteria allocation without starting unavailable iOS simulators", async () => {
      const images: DeviceInfo[] = [
        iosSimulatorImage("iPhone 15 Pro", "sim-unavailable", {
          state: "Unavailable",
          isAvailable: false,
          iosVersion: "17.5",
        }),
      ];
      const fakeDeviceManager = new FakeDeviceManager(images);
      devicePool = makePool({ deviceManager: fakeDeviceManager });

      await expect(
        devicePool.assignMultipleDevicesByCriteria(
          [
            {
              sessionId: "session-a",
              criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
            },
          ],
          1000,
        ),
      ).rejects.toThrow(/No devices match criteria/);
      expect(fakeDeviceManager.startedDevices).toHaveLength(0);
      expect(devicePool.getTotalDeviceCount()).toBe(0);
    });

    test("should fail iOS platform allocation without starting unavailable simulators", async () => {
      const images: DeviceInfo[] = [
        iosSimulatorImage("iPhone 15 Pro", "sim-1", { state: "Unavailable", isAvailable: false }),
      ];
      const fakeDeviceManager = new FakeDeviceManager(images);
      devicePool = makePool({ deviceManager: fakeDeviceManager });

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1000, "ios"),
      ).rejects.toThrow(/Not enough devices in pool/);
      expect(fakeDeviceManager.startedDevices).toHaveLength(0);
      expect(devicePool.getTotalDeviceCount()).toBe(0);
    });

    test("should assign iOS simulators by criteria", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15 Pro", "17.5"),
        createBootedDevice("sim-2", "ios", "iPhone 15", "17.4"),
      ]);
      fakeDeviceManager.bootedDevices = [
        createBootedDevice("sim-1", "ios", "iPhone 15 Pro", "17.5"),
        createBootedDevice("sim-2", "ios", "iPhone 15", "17.4"),
      ];

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
    });

    test("should prefer the least-recently-used idle device for criteria allocation", async () => {
      // Regression test for LRU drift between tryAssignDevice and
      // tryAssignDeviceWithCriteria (issue #2656). Criteria-based allocation
      // must distribute load to the least-recently-used idle device, the same
      // way platform-based allocation does.
      await initializeLiveDevices([
        createBootedDevice("dev-a", "android"),
        createBootedDevice("dev-b", "android"),
        createBootedDevice("dev-c", "android"),
      ]);

      // Touch devices in reverse insertion order so lastUsedAt ordering
      // (c < b < a) differs from map insertion order (a, b, c).
      await devicePool.bindOrReuseDeviceSession("seed-c", "dev-c", "android");
      await devicePool.bindOrReuseDeviceSession("seed-b", "dev-b", "android");
      await devicePool.bindOrReuseDeviceSession("seed-a", "dev-a", "android");

      await devicePool.releaseDevice("dev-a", "seed-a");
      await devicePool.releaseDevice("dev-b", "seed-b");
      await devicePool.releaseDevice("dev-c", "seed-c");

      // Re-bind dev-c so it is busy (and remains the lastReleasedDeviceId,
      // which should be ignored because it is no longer idle). Idle pool is
      // now {dev-a, dev-b}; insertion order would yield dev-a, but dev-b is
      // less recently used and must win.
      await devicePool.bindOrReuseDeviceSession("seed-c2", "dev-c", "android");

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-lru",
            criteria: { platform: "android" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-lru")).toBe("dev-b");
    });
  });
});
