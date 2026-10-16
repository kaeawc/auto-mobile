import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { afterEach, describe, expect, test, beforeEach, spyOn } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { DeviceInfo, Platform } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import type { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { logger } from "../../src/utils/logger";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  DeferredDeviceSessionPersistence,
  DeferredDiscoveryFakeDeviceManager,
  DeferredSessionTrackingAppsRepository,
  FakeDeviceManagerWithStartedProcess,
  GatedSnapshotDeviceManager,
  createBootedDevice,
  createDevicePoolSuite,
  devicePoolSuiteActions,
  withProcessPlatform,
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

  describe("device-ready notifications", () => {
    test("notifies when a boot-ready device reuses an existing serial", async () => {
      const connectedDeviceIds: string[] = [];
      devicePool = makePool({ onDeviceReady: (deviceId) => connectedDeviceIds.push(deviceId) });
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);

      await devicePool.addDevice(createBootedDevice("emulator-5554"));

      expect(connectedDeviceIds).toEqual(["emulator-5554"]);
      expect(devicePool.getTotalDeviceCount()).toBe(1);
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBeNull();
    });

    test("notifies when refresh rediscovers an existing serial", async () => {
      const connectedDeviceIds: string[] = [];
      devicePool = makePool({ onDeviceReady: (deviceId) => connectedDeviceIds.push(deviceId) });
      const device = createBootedDevice("emulator-5554");
      await devicePool.initializeWithDevices([device]);
      fakeDeviceManager.bootedDevices = [device];

      await devicePool.refreshDevices();

      expect(connectedDeviceIds).toEqual(["emulator-5554"]);
    });

    test("notifies after binding discovery and before claiming an existing serial", async () => {
      const connectedDeviceIds: string[] = [];
      const deferredDeviceManager = new DeferredDiscoveryFakeDeviceManager();
      devicePool = makePool({
        deviceManager: deferredDeviceManager,
        onDeviceReady: (deviceId) => connectedDeviceIds.push(deviceId),
      });
      const device = createBootedDevice("emulator-5554");
      await devicePool.initializeWithDevices([device]);
      deferredDeviceManager.bootedDevices = [device];

      const binding = devicePool.bindOrReuseDeviceSession("session-1", "emulator-5554", "android");
      await deferredDeviceManager.waitForDiscoveryStart();
      try {
        expect(connectedDeviceIds).toEqual([]);
      } finally {
        deferredDeviceManager.releaseDiscovery();
        await binding;
      }

      expect(connectedDeviceIds).toEqual(["emulator-5554"]);
    });

    test("retires only its new autolock when metadata persistence outlives cancellation", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      const started = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const repository = {
        markAutolockSession: async () => {
          started.resolve();
          await finished.promise;
        },
      };
      devicePool = makePool({ deviceSessionRepository: repository });
      const device = createBootedDevice("emulator-5554");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      const controller = new AbortController();
      try {
        const binding = runWithAbortSignal(controller.signal, () =>
          devicePool.autolockDevice(device.deviceId, "android", "mcp-expired"),
        ).catch((error: unknown) => error);
        await started.promise;
        const cancelledSessionId = devicePool.getDevice(device.deviceId)!.sessionId!;
        controller.abort(new Error("binding deadline exhausted"));
        expect(await binding).toBe(controller.signal.reason);
        await sessionManager.waitForSessionRelease(cancelledSessionId);
        expect(sessionManager.getSessionForDevice(device.deviceId)).toBeNull();
        expect(devicePool.getDevice(device.deviceId)?.sessionId).toBeNull();
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-expired")).toBeUndefined();
        repository.markAutolockSession = async () => {};
        const replacement = await devicePool.autolockDevice(device.deviceId, "android", "mcp-new");
        expect(replacement).not.toBe(cancelledSessionId);
        finished.resolve();
        await Promise.resolve();
        expect(devicePool.getDevice(device.deviceId)?.sessionId).toBe(replacement);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-new")).toBe(replacement);
      } finally {
        finished.resolve();
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }
    });

    test("cancelled metadata and release persistence cannot hold the global assignment mutex", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      const metadataStarted = Promise.withResolvers<void>();
      const metadataFinished = Promise.withResolvers<void>();
      const releaseStarted = Promise.withResolvers<void>();
      const releaseFinished = Promise.withResolvers<void>();
      const persistence = new FakeDeviceSessionPersistence();
      persistence.markReleased = async () => {
        releaseStarted.resolve();
        await releaseFinished.promise;
      };
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      let metadataCalls = 0;
      const repository = {
        markAutolockSession: async () => {
          if (metadataCalls++ === 0) {
            metadataStarted.resolve();
            await metadataFinished.promise;
          }
        },
      };
      devicePool = makePool({ deviceSessionRepository: repository });
      const first = createBootedDevice("emulator-5554");
      const second = createBootedDevice("emulator-5556");
      fakeDeviceManager.bootedDevices = [first, second];
      await devicePool.initializeWithDevices([first, second]);
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      const controller = new AbortController();
      try {
        const binding = runWithAbortSignal(controller.signal, () =>
          devicePool.autolockDevice(first.deviceId, "android", "mcp-cancelled"),
        ).catch((error: unknown) => error);
        await metadataStarted.promise;
        const cancelledSessionId = devicePool.getDevice(first.deviceId)!.sessionId!;
        controller.abort(new Error("binding deadline exhausted"));
        expect(await binding).toBe(controller.signal.reason);
        await releaseStarted.promise;
        expect(devicePool.getDevice(first.deviceId)?.sessionId).toBeNull();
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-cancelled")).toBeUndefined();
        expect(sessionManager.getSession(cancelledSessionId)).toBeNull();
        // The first device stays quarantined for cleanup, but an unrelated
        // reservation and assignment must succeed before either write settles.
        expect(sessionManager.hasDeviceCleanupInProgress(first.deviceId)).toBe(true);
        const reservation = await devicePool.reserveDeviceForReadiness(second.deviceId, second);
        await reservation();
        const secondSession = await devicePool.autolockDevice(
          second.deviceId,
          "android",
          "mcp-second",
        );
        expect(devicePool.getDevice(second.deviceId)?.sessionId).toBe(secondSession);
        metadataFinished.resolve();
        releaseFinished.resolve();
        await sessionManager.waitForSessionRelease(cancelledSessionId);
        expect(devicePool.getDevice(second.deviceId)?.sessionId).toBe(secondSession);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-second")).toBe(secondSession);
      } finally {
        metadataFinished.resolve();
        releaseFinished.resolve();
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }
    });

    test("notifies after autolock discovery and before claiming an existing serial", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      const connectedDeviceIds: string[] = [];
      const deferredDeviceManager = new DeferredDiscoveryFakeDeviceManager();
      devicePool = makePool({
        deviceManager: deferredDeviceManager,
        onDeviceReady: (deviceId) => connectedDeviceIds.push(deviceId),
      });
      const device = createBootedDevice("emulator-5554");
      await devicePool.initializeWithDevices([device]);
      deferredDeviceManager.bootedDevices = [device];
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";

      try {
        const binding = devicePool.autolockDevice("emulator-5554", "android", "mcp-session-1");
        await deferredDeviceManager.waitForDiscoveryStart();
        try {
          expect(connectedDeviceIds).toEqual([]);
        } finally {
          deferredDeviceManager.releaseDiscovery();
          await binding;
          expect(connectedDeviceIds).toEqual(["emulator-5554"]);
        }
      } finally {
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }
    });
  });

  describe("refreshDevices", () => {
    test("prunes removal stamps after completed refreshes", async () => {
      for (let index = 0; index < 6; index++) {
        const device = createBootedDevice(`emulator-${5554 + index * 2}`, "android");
        await devicePool.addDevice(device);
        await devicePool.removeDevice(device.deviceId);
        await devicePool.refreshDevices();
        expect(devicePool.getDeviceRemovalStampCountForTest()).toBeLessThanOrEqual(1);
      }
    });

    for (const [platform, deviceId, name] of [
      ["android", "emulator-5554", "Pixel 8"],
      ["ios", "sim-1", "iPhone 15"],
    ] as const) {
      test(`does not re-add a retired ${platform} serial from a pre-removal discovery snapshot`, async () => {
        const device = createBootedDevice(deviceId, platform, name);
        const manager = new GatedSnapshotDeviceManager([], [device]);
        const readyDeviceIds: string[] = [];
        devicePool = makePool({
          deviceManager: manager,
          onDeviceReady: (readyId) => readyDeviceIds.push(readyId),
        });
        await devicePool.addDevice(device);
        readyDeviceIds.length = 0;
        const captured = devicePool.getDevice(deviceId);
        if (!captured) {
          throw new Error("expected pooled device");
        }
        devicePool.markIntentionalShutdown(deviceId);
        const reservation = await devicePool.reserveDeviceForShutdown(deviceId);
        if (!reservation) {
          throw new Error("expected shutdown reservation");
        }

        manager.gateDiscovery = true;
        const staleRefresh = devicePool.refreshDevices();
        await manager.snapshotTaken.promise;
        manager.bootedDevices = [];
        expect(await devicePool.retireDeviceForShutdown(captured)).toBe(true);
        await reservation.release();
        manager.resumeDiscovery.resolve();
        expect(await staleRefresh).toBe(0);

        expect(devicePool.getDevice(deviceId)).toBeNull();
        expect(readyDeviceIds).toEqual([]);
      });
    }

    test("re-adds a rebooted serial when discovery starts after its removal", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const manager = new GatedSnapshotDeviceManager([], [device]);
      const readyDeviceIds: string[] = [];
      devicePool = makePool({
        deviceManager: manager,
        onDeviceReady: (readyId) => readyDeviceIds.push(readyId),
      });
      await devicePool.addDevice(device);
      readyDeviceIds.length = 0;
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected pooled device");
      }
      expect(await devicePool.retireDeviceForShutdown(captured)).toBe(true);

      expect(await devicePool.refreshDevices()).toBe(1);
      expect(devicePool.getDevice(device.deviceId)?.incarnation).toBeGreaterThan(
        captured.incarnation,
      );
      expect(readyDeviceIds).toEqual([device.deviceId]);
    });

    test("marks a newly discovered Android placeholder identity unresolved", async () => {
      fakeDeviceManager.bootedDevices = [
        createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)"),
      ];

      await devicePool.refreshDevices();

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
    });

    test("does not query simctl during Linux Android-only refresh", async () => {
      await withProcessPlatform("linux", async () => {
        let simctlBootedCalls = 0;
        const androidDevice = createBootedDevice("emulator-5554", "android", "Pixel 8");
        const fakeSimctl = fakeDeviceManagerSimctl({
          isAvailable: async () => false,
          getBootedSimulators: async () => {
            simctlBootedCalls++;
            throw new Error("simctl should not be queried");
          },
          getBootedSimulatorsChecked: async () => {
            simctlBootedCalls++;
            throw new Error("simctl should not be queried");
          },
        });
        const fakeEmulator = {
          getBootedDevices: async () => [androidDevice],
          getBootedDevicesChecked: async () => [androidDevice],
        } as unknown as AndroidEmulatorClient;
        const manager = new MultiPlatformDeviceManager(
          new FakeAdbClient(),
          fakeSimctl,
          fakeEmulator,
        );
        const pool = makePool({ deviceManager: manager });

        const added = await pool.refreshDevices();

        expect(added).toBe(1);
        expect(pool.getDevice("emulator-5554")).not.toBeNull();
        expect(simctlBootedCalls).toBe(0);
      });
    });

    test("keeps Android devices when Linux iOS discovery fails after availability", async () => {
      await withProcessPlatform("linux", async () => {
        const androidDevice = createBootedDevice("emulator-5554", "android", "Pixel 8");
        const fakeSimctl = fakeDeviceManagerSimctl({
          isAvailable: async () => true,
          getBootedSimulators: async () => {
            throw new Error("simctl unavailable");
          },
          getBootedSimulatorsChecked: async () => {
            throw new Error("simctl unavailable");
          },
        });
        const fakeEmulator = {
          getBootedDevices: async () => [androidDevice],
          getBootedDevicesChecked: async () => [androidDevice],
        } as unknown as AndroidEmulatorClient;
        const manager = new MultiPlatformDeviceManager(
          new FakeAdbClient(),
          fakeSimctl,
          fakeEmulator,
        );
        const pool = makePool({ deviceManager: manager });

        const added = await pool.refreshDevices();

        expect(added).toBe(1);
        expect(pool.getDevice("emulator-5554")).not.toBeNull();
      });
    });

    test("removes unassigned devices that are no longer booted", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      await fakeAppsRepo.seedInstalledApp("sim-old", 0, "com.test.app", false, Date.now());
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-new", "ios", "iPhone 16")];

      const added = await devicePool.refreshDevices();

      expect(added).toBe(1);
      expect(devicePool.getDevice("sim-old")).not.toBeNull();
      await devicePool.refreshDevices();
      expect(devicePool.getDevice("sim-old")).not.toBeNull();
      await devicePool.refreshDevices();
      expect(devicePool.getDevice("sim-old")).toBeNull();
      expect(devicePool.getDevice("sim-new")).not.toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(1);
      expect(await fakeAppsRepo.listInstalledApps("sim-old")).toEqual([]);
    });

    test("keeps missing assigned devices until session cleanup releases them", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-old", "ios", "iPhone 15")];
      await devicePool.assignDeviceToSession("session-1", "ios");
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-new", "ios", "iPhone 16")];

      const added = await devicePool.refreshDevices();

      expect(added).toBe(1);
      expect(devicePool.getDevice("sim-old")?.sessionId).toBe("session-1");
      expect(devicePool.getDevice("sim-new")?.status).toBe("idle");
      expect(devicePool.getTotalDeviceCount()).toBe(2);
    });

    test("evicts an assigned stale identity before refreshing the same serial", async () => {
      const oldDevice = createBootedDevice("emulator-5554", "android", "Old Pixel");
      await devicePool.initializeWithDevices([oldDevice]);
      fakeDeviceManager.bootedDevices = [oldDevice];
      await devicePool.bindOrReuseDeviceSession("session-1", oldDevice.deviceId, "android");
      fakeDeviceManager.bootedDevices = [
        createBootedDevice("emulator-5554", "android", "New Pixel"),
      ];

      const added = await devicePool.refreshDevices();

      expect(added).toBe(1);
      expect(sessionManager.getSession("session-1")).toBeNull();
      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        name: "New Pixel",
        platform: "android",
        sessionId: null,
        status: "idle",
      });
    });

    test("retains unassigned devices on first empty discovery", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [];

      const added = await devicePool.refreshDevices();

      expect(added).toBe(0);
      expect(devicePool.getDevice("sim-old")?.status).toBe("idle");
      expect(devicePool.getTotalDeviceCount()).toBe(1);
    });

    test("removes unassigned devices after repeated empty discovery misses", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [];

      await devicePool.refreshDevices();
      await devicePool.refreshDevices();
      expect(devicePool.getDevice("sim-old")).not.toBeNull();
      await devicePool.refreshDevices();

      expect(devicePool.getDevice("sim-old")).toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(0);
    });

    test("defers refresh eviction while a shutdown reservation owns the incarnation", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await devicePool.initializeWithDevices([device]);
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected shutdown device to be pooled");
      }
      const reservation = await devicePool.reserveDeviceForShutdown(captured.id);
      if (!reservation) {
        throw new Error("expected shutdown reservation");
      }
      fakeDeviceManager.bootedDevices = [];

      try {
        await devicePool.refreshDevices();
        await devicePool.refreshDevices();

        expect(devicePool.getDevice(captured.id)).toBe(captured);
      } finally {
        await reservation.release();
      }

      await devicePool.refreshDevices();
      expect(devicePool.getDevice(captured.id)).toBeNull();
    });

    describe("System UI ANR replacement execution cancellation", () => {
      let tracker: ExecutionTracker;
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const branches = ["remove and add", "adopt existing"] as const;

      beforeEach(async () => {
        tracker = new ExecutionTracker(fakeTimer, new FakeIdGenerator(["ambient-execution"]));
        devicePool = makePool({
          ambientExecutionIdReader: { getExecutionId: () => "ambient-execution" },
          cancelDeviceSessionExecutions: Object.assign(
            tracker.cancelDeviceSessionExecutions.bind(tracker),
            { cancelDeviceExecutions: tracker.cancelDeviceExecutions.bind(tracker) },
          ),
          releaseSessionForDisconnectedDevice: async (sessionId, _deviceId, reason) => {
            await tracker.cancelSessionUuidExecutions(sessionId, reason);
            await sessionManager.releaseSession(sessionId, reason);
            return true;
          },
        });
        await initializeLiveDevices([device]);
        await devicePool.bindOrReuseDeviceSession(
          "owner-session",
          device.deviceId,
          "android",
          sourceImage,
        );
      });

      async function replaceDevice(branch: (typeof branches)[number], excludeExecutionId?: string) {
        const reservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
        if (!reservation) {
          throw new Error("expected shutdown reservation");
        }
        try {
          if (branch === "adopt existing") {
            await devicePool.addDevice(replacement, sourceImage);
          }
          return await devicePool.replaceDeviceForSystemUiAnrRecovery(
            reservation.device,
            replacement,
            sourceImage,
            undefined,
            undefined,
            excludeExecutionId,
          );
        } finally {
          await reservation.release();
        }
      }

      test.each(branches)(
        "cancels old-device work and preserves the explicitly excluded recovery during %s",
        async (branch) => {
          const oldDeviceWork = tracker.startExecution("observe");
          const dualBoundWork = tracker.startExecution("tapOn", undefined, "owner-session");
          const recovery = tracker.startExecution("startDevice", undefined, "owner-session");
          tracker.bindDeviceExecution(oldDeviceWork.id, device.deviceId);
          tracker.bindDeviceExecution(dualBoundWork.id, device.deviceId);
          tracker.bindDeviceExecution(recovery.id, device.deviceId);

          const handoff = await replaceDevice(branch, recovery.id);

          expect(oldDeviceWork.abortController.signal.aborted).toBe(true);
          expect(dualBoundWork.abortController.signal.aborted).toBe(true);
          expect(oldDeviceWork.cancelReason).toMatchObject({ deviceId: device.deviceId });
          expect(recovery.abortController.signal.aborted).toBe(false);
          expect(handoff.preservedSessionId).toBe("owner-session");
          expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(
            replacement.deviceId,
          );
        },
      );

      test.each(branches)(
        "retains old-device work and warns when the recovery execution is unknown during %s",
        async (branch) => {
          const oldDeviceWork = tracker.startExecution("observe");
          const recovery = tracker.startExecution("startDevice", undefined, "owner-session");
          tracker.bindDeviceExecution(oldDeviceWork.id, device.deviceId);
          tracker.bindDeviceExecution(recovery.id, device.deviceId);
          const warn = spyOn(logger, "warn").mockImplementation(() => {});
          try {
            await replaceDevice(branch, undefined);

            expect(oldDeviceWork.abortController.signal.aborted).toBe(false);
            expect(recovery.abortController.signal.aborted).toBe(false);
            const replacementWarnings = warn.mock.calls
              .map(([message]) => message)
              .filter((message) => message.startsWith("[DevicePool] Left old-device work running"));
            expect(replacementWarnings).toEqual([
              `[DevicePool] Left old-device work running for ${device.deviceId} because the System UI ANR recovery execution is unknown`,
            ]);
          } finally {
            warn.mockRestore();
          }
        },
      );

      test.each(branches)(
        "preserves session-only and other-device work during %s",
        async (branch) => {
          const sessionOnlyWork = tracker.startExecution("observe", undefined, "owner-session");
          const otherDeviceWork = tracker.startExecution("observe");
          tracker.bindDeviceExecution(otherDeviceWork.id, "emulator-5558");

          await replaceDevice(branch);

          expect(sessionOnlyWork.abortController.signal.aborted).toBe(false);
          expect(otherDeviceWork.abortController.signal.aborted).toBe(false);
        },
      );

      test("failure retirement cancels session work including recovery and retains sessionless device work", async () => {
        const sessionOnlyWork = tracker.startExecution("observe", undefined, "owner-session");
        const recovery = tracker.startExecution("startDevice", undefined, "owner-session");
        const sessionlessWork = tracker.startExecution("observe");
        const otherDeviceWork = tracker.startExecution("observe");
        tracker.bindDeviceExecution(recovery.id, device.deviceId);
        tracker.bindDeviceExecution(sessionlessWork.id, device.deviceId);
        tracker.bindDeviceExecution(otherDeviceWork.id, "emulator-5558");
        const captured = devicePool.getDevice(device.deviceId);
        if (!captured) {
          throw new Error("expected recovery device to be pooled");
        }

        const retired = await devicePool.retireDeviceAfterSystemUiAnrRecoveryFailure(captured);

        expect(retired).toBe(true);
        expect(sessionManager.getSession("owner-session")).toBeNull();
        expect(devicePool.getDevice(device.deviceId)).toBeNull();
        expect(sessionOnlyWork.abortController.signal.aborted).toBe(true);
        expect(recovery.abortController.signal.aborted).toBe(true);
        expect(sessionOnlyWork.cancelReason).toMatchObject({ deviceId: device.deviceId });
        expect(sessionlessWork.abortController.signal.aborted).toBe(false);
        expect(otherDeviceWork.abortController.signal.aborted).toBe(false);
      });
    });

    test("keeps the existing session through a System UI recovery handoff", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected recovery device to be pooled");
      }
      const readinessRelease = await devicePool.reserveDeviceForReadiness(
        device.deviceId,
        device,
        sourceImage.name,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        expect(devicePool.getDevice(device.deviceId)).toBe(captured);
        expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(device.deviceId);

        const replacement = {
          ...device,
          deviceId: "emulator-5556",
        };
        let readinessMarkerPublished = false;
        const handoff = await devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          replacement,
          sourceImage,
          undefined,
          () => {
            // Session work can discover the replacement inside addDevice, so
            // the marker must exist before that publication point.
            expect(devicePool.getDevice(replacement.deviceId)).toBeNull();
            readinessMarkerPublished = true;
          },
        );

        expect(readinessMarkerPublished).toBe(true);
        expect(handoff.preservedSessionId).toBe("owner-session");
        expect(devicePool.getDevice(device.deviceId)).toBeNull();
        expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({
          sessionId: "owner-session",
          status: "busy",
          avdName: sourceImage.name,
        });
        expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(
          replacement.deviceId,
        );
        expect(devicePool.getIdleDevices()).toEqual([]);
      } finally {
        await shutdownReservation.release();
        await readinessRelease();
      }
    });

    test("carries the autolock owner onto the System UI recovery replacement", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected recovery device to be pooled");
      }
      // Simulate an autolocked device so recovery must preserve exclusivity; an
      // unset autolockSessionId on the replacement would let any session drive it.
      captured.autolockSessionId = "owner-session";
      const readinessRelease = await devicePool.reserveDeviceForReadiness(
        device.deviceId,
        device,
        sourceImage.name,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        const replacement = { ...device, deviceId: "emulator-5556" };
        await devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          replacement,
          sourceImage,
        );

        expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({
          sessionId: "owner-session",
          autolockSessionId: "owner-session",
        });
      } finally {
        await shutdownReservation.release();
        await readinessRelease();
      }
    });

    test("resets device-scoped session state when recovery reuses the serial", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const unboundDevices: string[] = [];
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      sessionManager.setLastHierarchy("owner-session", { hierarchy: {} });
      sessionManager.setKeepScreenAwake("owner-session", { applied: true });
      sessionManager.onSessionDeviceUnbound((_sessionId, deviceId) =>
        unboundDevices.push(deviceId),
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        await devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          device,
          sourceImage,
        );

        expect(sessionManager.getSession("owner-session")).toMatchObject({
          assignedDevice: device.deviceId,
          cacheData: {},
        });
        expect(unboundDevices).toEqual([device.deviceId]);
      } finally {
        await shutdownReservation.release();
      }
    });

    test("adopts a matching replacement that refresh already added before handoff", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device, replacement];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected recovery device to be pooled");
      }
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        // Discovery can add the booted replacement before the recovery handoff
        // observes it. The handoff must adopt this instance rather than deleting
        // the original first and then rejecting the already-pooled replacement.
        await devicePool.addDevice(replacement);
        await devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          replacement,
          sourceImage,
        );

        expect(devicePool.getDevice(device.deviceId)).toBeNull();
        expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({
          sessionId: "owner-session",
          status: "busy",
          avdName: sourceImage.name,
        });
        expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(
          replacement.deviceId,
        );
      } finally {
        await shutdownReservation.release();
      }
    });

    test("does not adopt a matching replacement that another session already owns", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device, replacement];
      await devicePool.initializeWithDevices([device, replacement]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      await devicePool.bindOrReuseDeviceSession(
        "competing-session",
        replacement.deviceId,
        "android",
        sourceImage,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        await expect(
          devicePool.replaceDeviceForSystemUiAnrRecovery(
            shutdownReservation.device,
            replacement,
            sourceImage,
          ),
        ).rejects.toThrow("already assigned to a session");
        expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(device.deviceId);
        expect(sessionManager.getSession("competing-session")?.assignedDevice).toBe(
          replacement.deviceId,
        );
      } finally {
        await shutdownReservation.release();
      }
    });

    test("does not retire a same-serial successor while cleaning up a recovery replacement", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        const handoff = await devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          replacement,
          sourceImage,
        );

        await sessionManager.releaseSession("owner-session", "test replacement exit");
        await devicePool.releaseDevice(replacement.deviceId, "owner-session");
        await devicePool.removeDevice(replacement.deviceId, false, handoff.replacementDevice);
        fakeDeviceManager.bootedDevices = [replacement];
        await devicePool.addDevice(replacement, sourceImage);
        await devicePool.bindOrReuseDeviceSession(
          "successor-session",
          replacement.deviceId,
          "android",
          sourceImage,
        );

        await expect(handoff.validatePreservedSession()).rejects.toThrow(
          "was released while System UI recovery was becoming ready",
        );
        expect(
          await devicePool.retireDeviceAfterSystemUiAnrRecoveryFailure(handoff.replacementDevice),
        ).toBe(false);
        expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({
          sessionId: "successor-session",
          status: "busy",
        });
      } finally {
        await shutdownReservation.release();
      }
    });

    test("rolls back the replacement when the recovery session rebind fails", async () => {
      sessionManager.stopCleanupTimer();
      const sessionPersistence = new FakeDeviceSessionPersistence();
      // The first upsert binds the owner session; the rebind onto the
      // replacement is the second, and it rejects here.
      sessionPersistence.createFailureOnAttempt = 2;
      sessionManager = new SessionManager(fakeTimer, sessionPersistence);
      devicePool = makePool();
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        const replacement = { ...device, deviceId: "emulator-5556" };

        await expect(
          devicePool.replaceDeviceForSystemUiAnrRecovery(
            shutdownReservation.device,
            replacement,
            sourceImage,
          ),
        ).rejects.toThrow("persist create failed");

        // The failed rebind must not strand an idle, assignable replacement that
        // still maps to the stopped serial.
        expect(devicePool.getDevice(replacement.deviceId)).toBeNull();
        expect(devicePool.getIdleDevices()).toEqual([]);
        expect(sessionManager.getSession("owner-session")).toBeNull();
      } finally {
        await shutdownReservation.release();
      }
    });

    test("rolls back when the replacement exits during recovery session persistence", async () => {
      const manager = new FakeDeviceManagerWithStartedProcess();
      const persistence = new DeferredDeviceSessionPersistence();
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = makePool({ deviceManager: manager });
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      manager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);

      const binding = devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      await persistence.waitForUpsert();
      persistence.finishUpsert();
      await binding;
      persistence.deferNextUpsert();

      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        manager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        const replacement = { ...device, deviceId: "emulator-5556" };
        const handoff = devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          replacement,
          sourceImage,
          manager.childProcess,
        );
        await persistence.waitForUpsert();
        manager.childProcess.emit("exit", 0, null);
        await drainUntil(() => devicePool.getDevice(replacement.deviceId) === null, {
          description: "replacement eviction during persistence",
        });
        persistence.finishUpsert();

        await expect(handoff).rejects.toThrow(
          "disconnected while its recovery session was being rebound",
        );
        expect(devicePool.getDevice(replacement.deviceId)).toBeNull();
        expect(sessionManager.getSession("owner-session")).toBeNull();
        expect(sessionManager.getSessionForDevice(replacement.deviceId)).toBeNull();
      } finally {
        await shutdownReservation.release();
      }
    });

    test("rolls back when the replacement exited before process tracking", async () => {
      const manager = new FakeDeviceManagerWithStartedProcess();
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      devicePool = makePool({ deviceManager: manager });
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      manager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        manager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        const replacement = { ...device, deviceId: "emulator-5556" };
        manager.childProcess.exitCode = 1;
        manager.childProcess.signalCode = null;

        await expect(
          devicePool.replaceDeviceForSystemUiAnrRecovery(
            shutdownReservation.device,
            replacement,
            sourceImage,
            manager.childProcess,
          ),
        ).rejects.toThrow("exited before process tracking completed");

        expect(devicePool.getDevice(replacement.deviceId)).toBeNull();
        expect(sessionManager.getSession("owner-session")).toBeNull();
        expect(sessionManager.getSessionForDevice(device.deviceId)).toBeNull();
      } finally {
        await shutdownReservation.release();
      }
    });

    test("defers monitor loss recovery while System UI recovery owns the emulator", async () => {
      const originalRecoveryOnLoss = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      const restoreRecoveryOnLoss = () => {
        if (originalRecoveryOnLoss === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRecoveryOnLoss;
        }
      };

      try {
        process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
        const manager = new FakeDeviceManager();
        const pool = new DevicePool(
          createDevicePoolDependencies(sessionManager, "daemon-session", {
            timer: fakeTimer,
            installedAppsRepository: fakeAppsRepo,
            deviceManager: manager,
            retryExecutor: new DefaultRetryExecutor(fakeTimer),
          }),
        );
        const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
        const sourceImage: DeviceInfo = {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        };
        manager.bootedDevices = [device];
        await pool.initializeWithDevices([device]);
        await pool.bindOrReuseDeviceSession(
          "owner-session",
          device.deviceId,
          "android",
          sourceImage,
        );
        const captured = pool.getDevice(device.deviceId);
        if (!captured) {
          throw new Error("expected recovery device to be pooled");
        }
        const reservation = await pool.reserveDeviceForShutdown(captured.id);
        if (!reservation) {
          throw new Error("expected shutdown reservation");
        }

        try {
          manager.bootedDevices = [];
          await pool.removeDisconnectedDevice(device.deviceId, false);

          expect(pool.getDevice(device.deviceId)).toBe(captured);
          expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(device.deviceId);
          expect(manager.startedDevices).toEqual([]);
        } finally {
          await reservation.release();
        }
      } finally {
        restoreRecoveryOnLoss();
      }
    });

    test("does not hold the assignment mutex for replacement session tracking", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const appsRepository = new DeferredSessionTrackingAppsRepository();
      const pool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "daemon-session", {
          timer: fakeTimer,
          installedAppsRepository: appsRepository,
          deviceManager: fakeDeviceManager,
          retryExecutor: new DefaultRetryExecutor(fakeTimer),
        }),
      );
      await pool.initializeWithDevices([device]);
      const captured = pool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected shutdown device to be pooled");
      }
      appsRepository.deferNextTrackingWrite();

      const replacement = await pool.replaceDeviceForShutdown(captured, {
        ...device,
        name: "Pixel 8 replacement",
      });

      expect(replacement?.name).toBe("Pixel 8 replacement");
      appsRepository.finishDeferredTrackingWrite();
    });

    test("captures the live same-UUID replacement while its pool identity update is pending", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession("owner-session", device.deviceId, "android");
      const originalSession = sessionManager.getSession("owner-session");
      if (!originalSession) {
        throw new Error("expected original session");
      }

      await sessionManager.releaseSession("owner-session", "allocation-rollback");
      await devicePool.releaseDevice(device.deviceId, "owner-session");

      const replacementPublished = Promise.withResolvers<void>();
      const finishPoolIdentityUpdate = Promise.withResolvers<void>();
      sessionManager.waitForSessionReleaseWithin = async () => {
        replacementPublished.resolve();
        await finishPoolIdentityUpdate.promise;
        return true;
      };

      const replacementBinding = devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
      );
      await replacementPublished.promise;
      const replacementSession = sessionManager.getSession("owner-session");
      expect(replacementSession).not.toBeNull();
      expect(replacementSession).not.toBe(originalSession);

      const shutdownReservationPromise = devicePool.reserveDeviceForShutdown(device.deviceId);
      finishPoolIdentityUpdate.resolve();
      await replacementBinding;
      const shutdownReservation = await shutdownReservationPromise;
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }
      try {
        expect(shutdownReservation.session).toBe(replacementSession);
      } finally {
        await shutdownReservation.release();
      }
    });

    test("recaptures the latest finalized owner after a replacement assignment fails", async () => {
      const persistence = new DeferredDeviceSessionPersistence();
      persistence.finishUpsert();
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      const pool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "daemon-session", {
          timer: fakeTimer,
          installedAppsRepository: fakeAppsRepo,
          deviceManager: fakeDeviceManager,
          retryExecutor: new DefaultRetryExecutor(fakeTimer),
        }),
      );
      const originalDevice = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const replacementDevice = createBootedDevice("emulator-5556", "android", "Pixel 9");
      fakeDeviceManager.bootedDevices = [originalDevice, replacementDevice];
      await pool.initializeWithDevices([originalDevice, replacementDevice]);
      await pool.bindOrReuseDeviceSession("shared", originalDevice.deviceId, "android");
      const originalSession = sessionManager.getSession("shared");
      if (!originalSession) {
        throw new Error("expected original session");
      }
      await sessionManager.releaseSession("shared", "allocation-rollback");

      persistence.deferNextUpsert();
      const replacementAssignment = sessionManager.getOrCreateSession("shared", pool, "android");
      await persistence.waitForUpsert();
      const shutdownReservationPromise = pool.reserveDeviceForShutdown(originalDevice.deviceId);
      persistence.failUpsert(new Error("replacement persistence failed"));
      await expect(replacementAssignment).rejects.toThrow("replacement persistence failed");

      const shutdownReservation = await shutdownReservationPromise;
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }
      try {
        expect(shutdownReservation.session).toBe(originalSession);
      } finally {
        await shutdownReservation.release();
      }
    });

    test("allows a replacement incarnation to acquire its own shutdown reservation", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await devicePool.initializeWithDevices([device]);
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected shutdown device to be pooled");
      }
      const originalReservation = await devicePool.reserveDeviceForShutdown(captured.id);
      if (!originalReservation) {
        throw new Error("expected original shutdown reservation");
      }

      const replacement = await devicePool.replaceDeviceForShutdown(captured, {
        ...device,
        name: "Pixel 8 replacement",
      });
      const replacementReservation = await devicePool.reserveDeviceForShutdown(captured.id);

      expect(replacementReservation?.device).toBe(replacement);
      await replacementReservation?.release();
      await originalReservation.release();
    });

    test("retains devices on first partial platform discovery miss", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("emulator-5554", "android", "Pixel 8")];

      const added = await devicePool.refreshDevices();

      expect(added).toBe(1);
      expect(devicePool.getDevice("sim-old")?.status).toBe("idle");
      expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(2);
    });

    test("retains iOS devices across repeated refreshes when iOS discovery keeps failing", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      // Android discovery succeeds, but iOS discovery fails this and every refresh.
      fakeDeviceManager.bootedDevices = [createBootedDevice("emulator-5554", "android", "Pixel 8")];
      fakeDeviceManager.failedPlatforms = new Set<Platform>(["ios"]);

      // Even past the miss threshold, a device on a platform whose discovery
      // failed must never be pruned (it may still be running).
      await devicePool.refreshDevices();
      await devicePool.refreshDevices();
      await devicePool.refreshDevices();

      expect(devicePool.getDevice("sim-old")?.status).toBe("idle");
      expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(2);
    });

    test("retains all devices when discovery fails for every platform", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
        createBootedDevice("sim-old", "ios", "iPhone 15"),
      ]);
      fakeDeviceManager.bootedDevices = [];
      fakeDeviceManager.failedPlatforms = new Set<Platform>(["android", "ios"]);

      await devicePool.refreshDevices();
      await devicePool.refreshDevices();

      expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      expect(devicePool.getDevice("sim-old")).not.toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(2);
    });

    test("prunes iOS devices once iOS discovery succeeds and confirms them gone", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      // iOS discovery now succeeds but reports zero booted simulators.
      fakeDeviceManager.bootedDevices = [createBootedDevice("emulator-5554", "android", "Pixel 8")];
      fakeDeviceManager.failedPlatforms = new Set<Platform>();

      // Genuine empties are tolerated for two refreshes, then removed.
      await devicePool.refreshDevices();
      expect(devicePool.getDevice("sim-old")?.status).toBe("idle");
      await devicePool.refreshDevices();
      expect(devicePool.getDevice("sim-old")?.status).toBe("idle");
      await devicePool.refreshDevices();

      expect(devicePool.getDevice("sim-old")).toBeNull();
      expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(1);
    });

    test("recomputes candidates after refresh prunes all unavailable error devices", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      for (let i = 0; i < 5; i++) {
        devicePool.recordDeviceError("sim-old");
      }
      fakeDeviceManager.bootedDevices = [createBootedDevice("emulator-5554", "android", "Pixel 8")];

      await devicePool.refreshDevices();
      await devicePool.refreshDevices();
      await devicePool.refreshDevices();
      await expect(devicePool.assignDeviceToSession("session-1", "ios")).rejects.toThrow(
        /No devices in pool/,
      );
      expect(devicePool.getDevice("sim-old")).toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(1);
    });
  });
});
