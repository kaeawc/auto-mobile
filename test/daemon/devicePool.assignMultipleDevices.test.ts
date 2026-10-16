import { markDeviceError } from "../../src/daemon/deviceBinding";
import { drainUntil, drainMicrotasks } from "../helpers/fakeTimerStepping";

import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { DevicePool, type SessionPreservingRecoveryResult } from "../../src/daemon/devicePool";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import {
  deviceRestartReleaseReason,
  type DeviceSessionPersistence,
} from "../../src/db/deviceSessionRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { DeviceInfo } from "../../src/models";

import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import {
  InMemoryEmulatorLossIncidentStore,
  type EmulatorLossIncidentStore,
} from "../../src/daemon/emulatorLossIncident";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  DeferredDeviceSessionPersistence,
  DeferredReconnectionDiscoveryFakeDeviceManager,
  DeferredRecoveryDeviceManager,
  FakeDeviceManagerWithDistinctStartedProcesses,
  FakeDeviceManagerWithExitedInitialProcess,
  FakeDeviceManagerWithExitedRecoveryProcess,
  FakeDeviceManagerWithFailingRecoveryStart,
  FakeDeviceManagerWithStartedProcess,
  androidDeviceImage,
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
  const {
    initializeLiveDevices,
    configureAfterFirstSession,
    failIosLivenessAfterFirstSession,
    makePool,
  } = devicePoolSuiteActions(() => ({
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

  describe("assignMultipleDevices", () => {
    test("does not evict a session claimed while preflight reconnect discovery is pending", async () => {
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const reconnected = { ...firstConnection };
      const deferredDeviceManager = new DeferredReconnectionDiscoveryFakeDeviceManager(
        [reconnected],
        [firstConnection],
      );
      fakeDeviceManager = deferredDeviceManager;
      devicePool = makePool();
      await initializeLiveDevices([firstConnection]);

      const preflightAllocation = devicePool.assignMultipleDevices(
        ["preflight-session"],
        1000,
        "android",
      );
      await deferredDeviceManager.waitForDiscoveryStart();

      await devicePool.assignDeviceToSession("concurrent-session", "android");
      const spareHandset = createBootedDevice("R5CT654321", "android", "Pixel 9");
      // The handset has to be discoverable too: a pooled Android entry is
      // re-proved present before it is handed out, handsets included.
      deferredDeviceManager.addToConcurrentSnapshot(spareHandset);
      await devicePool.addDevice(spareHandset);
      deferredDeviceManager.releaseDiscovery();
      await preflightAllocation;

      expect(sessionManager.getSession("concurrent-session")?.assignedDevice).toBe(
        firstConnection.deviceId,
      );
      expect(devicePool.getDevice(firstConnection.deviceId)).toMatchObject({
        sessionId: "concurrent-session",
        status: "busy",
      });
    });

    test("rolls back sessions and devices when platform allocation loses iOS liveness after a partial assignment", async () => {
      await initializeLiveDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15"),
        createBootedDevice("sim-2", "ios", "iPhone 16"),
      ]);

      failIosLivenessAfterFirstSession();

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1000, "ios"),
      ).rejects.toThrow(/Unable to verify iOS simulator liveness/);

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(sessionManager.getSession("session-b")).toBeNull();
      expect(devicePool.getDevice("sim-1")).toMatchObject({ sessionId: null, status: "idle" });
      expect(devicePool.getDevice("sim-2")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("releases a partial device claim when the session was already bound elsewhere", async () => {
      await initializeLiveDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15"),
        createBootedDevice("sim-2", "ios", "iPhone 16"),
      ]);
      await sessionManager.createSession("session-a", "existing-device", "ios");
      failIosLivenessAfterFirstSession();

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1000, "ios"),
      ).rejects.toThrow(/Unable to verify iOS simulator liveness/);

      expect(sessionManager.getSession("session-a")).toMatchObject({
        assignedDevice: "existing-device",
      });
      expect(devicePool.getDevice("sim-1")).toMatchObject({ sessionId: null, status: "idle" });
      expect(devicePool.getDevice("sim-2")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("preserves a replacement session that reuses a UUID during rollback", async () => {
      await initializeLiveDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15"),
        createBootedDevice("sim-2", "ios", "iPhone 16"),
      ]);
      const createSession = sessionManager.createSession.bind(sessionManager);
      const releaseSession = sessionManager.releaseSession.bind(sessionManager);
      let sessionCreates = 0;
      sessionManager.createSession = async (sessionId, deviceId, platform, options) => {
        const session = await createSession(sessionId, deviceId, platform, options);
        sessionCreates++;
        if (sessionCreates === 1) {
          await releaseSession(sessionId, "allocation-rollback");
          await createSession(sessionId, deviceId, platform, options);
          fakeDeviceManager.failedPlatforms.add("ios");
        }
        return session;
      };

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1000, "ios"),
      ).rejects.toThrow(/Unable to verify iOS simulator liveness/);

      expect(sessionManager.getSession("session-a")).toMatchObject({ assignedDevice: "sim-1" });
      expect(devicePool.getDevice("sim-1")).toMatchObject({
        sessionId: "session-a",
        status: "busy",
      });
      expect(devicePool.getDevice("sim-2")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("rolls back sessions and devices when criteria allocation loses iOS liveness after a partial assignment", async () => {
      await initializeLiveDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15"),
        createBootedDevice("sim-2", "ios", "iPhone 16"),
      ]);

      failIosLivenessAfterFirstSession();

      await expect(
        devicePool.assignMultipleDevicesByCriteria(
          [
            { sessionId: "session-a", criteria: { platform: "ios" } },
            { sessionId: "session-b", criteria: { platform: "ios" } },
          ],
          1000,
        ),
      ).rejects.toThrow(/Unable to verify iOS simulator liveness/);

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(sessionManager.getSession("session-b")).toBeNull();
      expect(devicePool.getDevice("sim-1")).toMatchObject({ sessionId: null, status: "idle" });
      expect(devicePool.getDevice("sim-2")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("rolls back the completed assignment when platform allocation exhausts retries", async () => {
      fakeTimer.enableAutoAdvance();
      await initializeLiveDevices([createBootedDevice("device-a"), createBootedDevice("device-b")]);
      configureAfterFirstSession(() => {
        const unavailable = devicePool.getDevice("device-b");
        if (!unavailable) {
          throw new Error("expected second pooled device");
        }
        unavailable.status = "busy";
      });

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1000, "android"),
      ).rejects.toThrow(/Timed out allocating devices/);

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(devicePool.getDevice("device-a")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("rolls back the completed assignment when criteria allocation times out", async () => {
      await initializeLiveDevices([createBootedDevice("device-a"), createBootedDevice("device-b")]);
      configureAfterFirstSession(() => {
        const unavailable = devicePool.getDevice("device-b");
        if (!unavailable) {
          throw new Error("expected second pooled device");
        }
        unavailable.status = "busy";
        fakeTimer.advanceTime(1001);
      });

      await expect(
        devicePool.assignMultipleDevicesByCriteria(
          [
            { sessionId: "session-a", criteria: { platform: "android" } },
            { sessionId: "session-b", criteria: { platform: "android" } },
          ],
          1000,
        ),
      ).rejects.toThrow(/Timed out allocating devices/);

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(devicePool.getDevice("device-a")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("rolls back the completed assignment when criteria allocation becomes non-retryable", async () => {
      await initializeLiveDevices([
        createBootedDevice("device-a"),
        createBootedDevice("device-b", "ios", "iPhone 16"),
      ]);
      configureAfterFirstSession(() => {
        const unavailable = devicePool.getDevice("device-b");
        if (!unavailable) {
          throw new Error("expected second pooled device");
        }
        markDeviceError(unavailable);
      });

      await expect(
        devicePool.assignMultipleDevicesByCriteria(
          [
            { sessionId: "session-a", criteria: { platform: "android" } },
            { sessionId: "session-b", criteria: { platform: "ios" } },
          ],
          1000,
        ),
      ).rejects.toThrow(/Failed to allocate device for session session-b/);

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(devicePool.getDevice("device-a")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("releases earlier session ownership when a later persistence write rejects", async () => {
      sessionManager.stopCleanupTimer();
      const sessionPersistence = new FakeDeviceSessionPersistence();
      sessionPersistence.createFailureOnAttempt = 2;
      sessionManager = new SessionManager(fakeTimer, sessionPersistence);
      devicePool = makePool();
      await initializeLiveDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5556"),
      ]);

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1_000, "android"),
      ).rejects.toThrow("persist create failed");

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(sessionManager.getSessionForDevice("emulator-5554")).toBeNull();
      expect(devicePool.getDevice("emulator-5554")?.status).toBe("idle");
    });

    test("releases the old device without rolling back a replacement session with the same UUID", async () => {
      const secondWriteStarted = Promise.withResolvers<void>();
      const secondWriteFinished = Promise.withResolvers<void>();
      let writeCount = 0;
      const sessionPersistence: DeviceSessionPersistence = Object.assign(
        new FakeDeviceSessionPersistence(),
        {
          recordLivenessOwnership: async () => {},
          replaceLivenessOwnership: async () => {},
          claimRecoverableSession: async (_id, expected) => expected.rowGeneration,
          async upsertActiveSession(): Promise<void> {
            writeCount++;
            if (writeCount === 2) {
              secondWriteStarted.resolve();
              await secondWriteFinished.promise;
              throw new Error("persist create failed");
            }
          },
          async recordActivity(): Promise<void> {},
          async markReleased(): Promise<void> {},
        } satisfies Partial<DeviceSessionPersistence> & Record<string, unknown>,
      );
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, sessionPersistence);
      devicePool = makePool();
      await initializeLiveDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5556"),
        createBootedDevice("emulator-5558"),
      ]);

      const allocation = devicePool.assignMultipleDevices(
        ["session-a", "session-b"],
        1_000,
        "android",
      );
      await secondWriteStarted.promise;

      await sessionManager.releaseSession("session-a", "allocation-rollback");
      await sessionManager.createSession("session-a", "emulator-5558", "android");
      secondWriteFinished.resolve();

      await expect(allocation).rejects.toThrow("persist create failed");
      expect(sessionManager.getSession("session-a")?.assignedDevice).toBe("emulator-5558");
      expect(devicePool.getDevice("emulator-5554")?.status).toBe("idle");
    });
  });

  describe("assignMultipleDevices", () => {
    test("evicts a started emulator when its process exits after readiness", async () => {
      const images: DeviceInfo[] = [
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ];
      const manager = new FakeDeviceManagerWithStartedProcess(images);
      const releaseCalls: Array<{ sessionId: string; deviceId: string; reason: string }> = [];
      devicePool = makePool({
        deviceManager: manager,
        releaseSessionForDisconnectedDevice: async (sessionId, deviceId, reason) => {
          releaseCalls.push({ sessionId, deviceId, reason });
          await sessionManager.releaseSession(sessionId, reason);
        },
        recoveryPolicy: { onLoss: false, maxAttempts: 2 },
      });

      const assignments = await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
      expect(assignments.get("session-1")).toBe("emulator-5554");

      manager.childProcess.emit("exit", 0, null);
      await drainUntil(
        () =>
          devicePool.getDevice("emulator-5554") === null &&
          sessionManager.getSession("session-1") === null,
        { description: "process-exit eviction and session release" },
      );

      expect(releaseCalls).toHaveLength(1);
      expect(releaseCalls[0]).toEqual({
        sessionId: "session-1",
        deviceId: "emulator-5554",
        reason: deviceRestartReleaseReason("Pixel 8"),
      });
      expect(devicePool.getDevice("emulator-5554")).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("defers a started emulator's process-exit cleanup while shutdown is reserved", async () => {
      const images: DeviceInfo[] = [
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ];
      const manager = new FakeDeviceManagerWithStartedProcess(images);
      const releaseCalls: Array<{ sessionId: string; deviceId: string; reason: string }> = [];
      devicePool = makePool({
        deviceManager: manager,
        releaseSessionForDisconnectedDevice: async (sessionId, deviceId, reason) => {
          releaseCalls.push({ sessionId, deviceId, reason });
          await sessionManager.releaseSession(sessionId, reason);
        },
      });

      await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      const reservation = await devicePool.reserveDeviceForShutdown("emulator-5554");
      if (!reservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        manager.childProcess.emit("exit", 0, null);
        // The ignored exit has no completion signal. Drain its bounded microtask work.
        await drainMicrotasks(96);

        expect(releaseCalls).toEqual([]);
        expect(devicePool.getDevice("emulator-5554")).toBe(reservation.device);
        expect(sessionManager.getSessionForDevice("emulator-5554")).toBe("session-1");
      } finally {
        await reservation.release();
      }
    });

    test("does not publish a session when its started emulator exits during persistence", async () => {
      const images: DeviceInfo[] = [
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ];
      const manager = new FakeDeviceManagerWithStartedProcess(images);
      const persistence = new DeferredDeviceSessionPersistence();
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = makePool({ deviceManager: manager });

      // A rolled-back create leaves the device free: it cancels no sessionless call (#10905).
      const acquisitionCancellations: string[] = [];
      sessionManager.setDeviceAcquisitionExecutionCanceller((deviceId) => {
        acquisitionCancellations.push(deviceId);
      });

      const assignment = devicePool.assignMultipleDevices(["session-1"], 1000, "android");
      await persistence.waitForUpsert();
      manager.childProcess.emit("exit", 0, null);
      // Exit cleanup can wait for the in-flight session write; there is no
      // completion signal while that gate is held.
      await drainMicrotasks(1_000);
      persistence.finishUpsert();

      await expect(assignment).rejects.toThrow("disconnected while its session was being created");
      expect(devicePool.getDevice("emulator-5554")).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
      expect(sessionManager.getSessionForDevice("emulator-5554")).toBeNull();
      expect(acquisitionCancellations).toEqual([]);
    });

    test("keeps criteria auto-start available after a process exit when recovery is disabled", async () => {
      const originalRecoveryOnLoss = process.env.AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS;
      const originalRecoveryOnLossAlias = process.env.AUTO_MOBILE_DEVICE_RECOVERY_ON_LOSS;
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      const originalRebootOnDeathAlias = process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS = "0";
      delete process.env.AUTO_MOBILE_DEVICE_RECOVERY_ON_LOSS;
      delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      delete process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
      try {
        const images: DeviceInfo[] = [
          androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
        ];
        const manager = new FakeDeviceManagerWithStartedProcess(images);
        devicePool = makePool({ deviceManager: manager });

        await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
        manager.bootedDevices = [];
        manager.childProcess.emit("exit", 1, null);
        await drainUntil(
          () =>
            devicePool.getDevice("emulator-5554") === null &&
            sessionManager.getSession("session-1") === null,
          { description: "disabled-recovery eviction and release" },
        );

        await expect(
          devicePool.assignMultipleDevices(["session-2"], 1000, "android"),
        ).resolves.toEqual(new Map([["session-2", "emulator-5554"]]));
        expect(manager.startedDevices).toHaveLength(2);
      } finally {
        if (originalRecoveryOnLoss === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS;
        } else {
          process.env.AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS = originalRecoveryOnLoss;
        }
        if (originalRecoveryOnLossAlias === undefined) {
          delete process.env.AUTO_MOBILE_DEVICE_RECOVERY_ON_LOSS;
        } else {
          process.env.AUTO_MOBILE_DEVICE_RECOVERY_ON_LOSS = originalRecoveryOnLossAlias;
        }
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
        if (originalRebootOnDeathAlias === undefined) {
          delete process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeathAlias;
        }
      }
    });

    test("reboots a disconnected pool-started Android emulator from its source AVD when enabled", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
        ];
        const manager = new FakeDeviceManagerWithStartedProcess(images);
        const incidents = new InMemoryEmulatorLossIncidentStore(
          fakeTimer,
          new CountingIdGenerator("incident"),
        );
        devicePool = makePool({
          deviceManager: manager,
          recoveryPolicy: { onLoss: true, maxAttempts: 2 },
          emulatorLossIncidentStore: incidents,
        });

        await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
        manager.bootedDevices = [];

        manager.childProcess.emit("exit", 1, null);
        await drainUntil(
          () =>
            sessionManager.getSession("session-1")?.assignedDevice === "Pixel 8" &&
            !devicePool.isSessionRecoveryInFlight("session-1"),
          { description: "recovery rebound and incident settlement" },
        );

        expect(manager.startedDevices.map((device) => device.name)).toEqual(["Pixel 8", "Pixel 8"]);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
        expect(devicePool.getDevice("Pixel 8")).toMatchObject({
          avdName: "Pixel 8",
          sessionId: "session-1",
          status: "busy",
        });
        expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("Pixel 8");
        await expect(incidents.list()).resolves.toMatchObject([
          {
            deviceId: "emulator-5554",
            replacementDeviceId: "Pixel 8",
            session: {
              sessionUuid: "session-1",
              state: "active",
            },
            recovery: {
              outcome: "recovered",
              attempts: [{ attempt: 1, outcome: "succeeded" }],
            },
          },
        ]);
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("quarantines a process-exit session before incident persistence completes", async () => {
      const images: DeviceInfo[] = [
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ];
      const manager = new FakeDeviceManagerWithStartedProcess(images);
      const backingStore = new InMemoryEmulatorLossIncidentStore(
        fakeTimer,
        new CountingIdGenerator("incident"),
      );
      const openStarted = Promise.withResolvers<void>();
      const releaseOpen = Promise.withResolvers<void>();
      let incidentCompleted = false;
      const incidents: EmulatorLossIncidentStore = {
        async open(input) {
          openStarted.resolve();
          await releaseOpen.promise;
          return await backingStore.open(input);
        },
        async recordRecoveryAttempt(incidentId, attempt) {
          await backingStore.recordRecoveryAttempt(incidentId, attempt);
        },
        async completeRecovery(incidentId, outcome, settlement) {
          await backingStore.completeRecovery(incidentId, outcome, settlement);
          incidentCompleted = true;
        },
        async get(incidentId) {
          return await backingStore.get(incidentId);
        },
        async list(limit) {
          return await backingStore.list(limit);
        },
      };
      devicePool = makePool({
        deviceManager: manager,
        recoveryPolicy: { onLoss: true, maxAttempts: 1 },
        emulatorLossIncidentStore: incidents,
      });

      await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      manager.bootedDevices = [];
      manager.childProcess.emit("exit", 1, null);
      await openStarted.promise;

      expect(devicePool.isSessionRecoveryInFlight("session-1")).toBe(true);
      expect(() => devicePool.assertSessionReadyForAutomation("session-1")).toThrow(
        "device-disconnected:emulator-5554",
      );

      await sessionManager.releaseSession("session-1", "explicit-release");
      await devicePool.releaseDevice("emulator-5554", "session-1");
      manager.bootedDevices = [
        {
          name: "Pixel 8",
          platform: "android",
          deviceId: "emulator-5554",
        },
      ];
      await devicePool.bindOrReuseDeviceSession("session-2", "emulator-5554", "android", images[0]);
      releaseOpen.resolve();
      await drainUntil(
        () => incidentCompleted && !devicePool.isSessionRecoveryInFlight("session-1"),
        { description: "superseded process-exit incident settlement" },
      );
      expect(devicePool.isSessionRecoveryInFlight("session-1")).toBe(false);
      expect(sessionManager.getSession("session-2")?.assignedDevice).toBe("emulator-5554");
      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        sessionId: "session-2",
        status: "busy",
      });
      const recordedIncidents = await backingStore.list();
      expect(recordedIncidents).toMatchObject([{ recovery: { outcome: "not-attempted" } }]);
      const settlement = devicePool.waitForEmulatorLossIncident(recordedIncidents[0]!.id);
      let settlementResolved = false;
      void settlement.then(() => {
        settlementResolved = true;
      });
      for (let attempt = 0; attempt < 10 && !settlementResolved; attempt++) {
        await Promise.resolve();
      }
      expect(settlementResolved).toBe(true);
      await settlement;
    });

    test("keeps process-exit quarantine while eviction claims recovery", async () => {
      const images: DeviceInfo[] = [
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ];
      const manager = new FakeDeviceManagerWithStartedProcess(images);
      const incidents = new InMemoryEmulatorLossIncidentStore(
        fakeTimer,
        new CountingIdGenerator("incident"),
      );
      devicePool = makePool({
        deviceManager: manager,
        recoveryPolicy: { onLoss: true, maxAttempts: 1 },
        emulatorLossIncidentStore: incidents,
      });

      await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      manager.bootedDevices = [];
      const incidentResolutionStarted = Promise.withResolvers<void>();
      const releaseIncidentResolution = Promise.withResolvers<void>();
      const internals = devicePool as unknown as {
        evictStartedDeviceAfterProcessExit(
          deviceId: string,
          code: number | null,
          signal: NodeJS.Signals | null,
        ): Promise<void>;
      };
      const livenessInternals = (
        devicePool as unknown as {
          missingDeviceLiveness: {
            resolveMissingDeviceIncident(...args: unknown[]): Promise<string | undefined>;
          };
        }
      ).missingDeviceLiveness;
      livenessInternals.resolveMissingDeviceIncident = async (...args) => {
        incidentResolutionStarted.resolve();
        await releaseIncidentResolution.promise;
        return args[2] as string | undefined;
      };

      const eviction = internals.evictStartedDeviceAfterProcessExit("emulator-5554", 1, null);
      await incidentResolutionStarted.promise;

      expect(devicePool.isSessionRecoveryInFlight("session-1")).toBe(true);
      expect(() => devicePool.assertSessionReadyForAutomation("session-1")).toThrow(
        /device-disconnected:emulator-5554/,
      );

      releaseIncidentResolution.resolve();
      await eviction;
      expect(sessionManager.getSession("session-1")).not.toBeNull();
      expect(devicePool.isSessionRecoveryInFlight("session-1")).toBe(false);
    });

    test("coalesces concurrent loss signals into one session-preserving recovery", async () => {
      const manager = new DeferredRecoveryDeviceManager();
      const incidents = new InMemoryEmulatorLossIncidentStore(
        fakeTimer,
        new CountingIdGenerator("incident"),
      );
      const images: DeviceInfo[] = [
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ];
      manager.deviceImages = images;
      devicePool = makePool({
        deviceManager: manager,
        recoveryPolicy: { onLoss: true, maxAttempts: 1 },
        emulatorLossIncidentStore: incidents,
      });

      await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      const disconnected = devicePool.getDevice("emulator-5554")!;
      manager.bootedDevices = [];
      const firstIncident = await devicePool.recordEmulatorLossIncident(
        disconnected.id,
        "watched-process-exit",
      );
      const duplicateIncident = await devicePool.recordEmulatorLossIncident(
        disconnected.id,
        "device-discovery-miss",
      );
      const first = devicePool.recoverSessionBoundAndroidDeviceAfterLoss(
        disconnected.id,
        firstIncident,
        disconnected,
      );
      await manager.waitForRecoveryStart();

      const duplicate = devicePool.recoverSessionBoundAndroidDeviceAfterLoss(
        disconnected.id,
        duplicateIncident,
        disconnected,
      );
      expect(devicePool.isSessionRecoveryInFlight("session-1")).toBe(true);
      expect(() => devicePool.assertSessionReadyForAutomation("session-1")).toThrow(
        `device-disconnected:emulator-5554;incident=${firstIncident}`,
      );
      manager.releaseRecovery();

      await expect(Promise.all([first, duplicate])).resolves.toEqual(["recovered", "recovered"]);
      expect(manager.childProcesses).toHaveLength(2);
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-5554");
      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        sessionId: "session-1",
        status: "busy",
      });
      await expect(incidents.get(duplicateIncident!)).resolves.toMatchObject({
        recovery: { outcome: "recovered" },
        session: { state: "active" },
      });
    });

    test("settles a joining incident when shared recovery rejects", async () => {
      const images: DeviceInfo[] = [
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ];
      const manager = new FakeDeviceManagerWithStartedProcess(images);
      const incidents = new InMemoryEmulatorLossIncidentStore(
        fakeTimer,
        new CountingIdGenerator("incident"),
      );
      devicePool = makePool({
        deviceManager: manager,
        recoveryPolicy: { onLoss: true, maxAttempts: 1 },
        emulatorLossIncidentStore: incidents,
      });

      await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      const disconnected = devicePool.getDevice("emulator-5554")!;
      const primaryIncident = await devicePool.recordEmulatorLossIncident(
        disconnected.id,
        "watched-process-exit",
      );
      const duplicateIncident = await devicePool.recordEmulatorLossIncident(
        disconnected.id,
        "device-discovery-miss",
      );
      const sharedRecovery = Promise.withResolvers<SessionPreservingRecoveryResult>();
      const internals = devicePool as unknown as {
        sessionPreservingRecoveries: Map<
          string,
          { promise: Promise<SessionPreservingRecoveryResult>; incidentId?: string }
        >;
        emulatorLossRecoveryResolvers: Map<string, () => void>;
        emulatorLossRecoverySettlements: Map<string, Promise<void>>;
      };
      internals.sessionPreservingRecoveries.set("session-1", {
        promise: sharedRecovery.promise,
        incidentId: primaryIncident,
      });

      const duplicate = devicePool.recoverSessionBoundAndroidDeviceAfterLoss(
        disconnected.id,
        duplicateIncident,
        disconnected,
      );
      sharedRecovery.reject(new Error("terminal release persistence failed"));

      await expect(duplicate).rejects.toThrow("terminal release persistence failed");
      await expect(incidents.get(duplicateIncident!)).resolves.toMatchObject({
        recovery: { outcome: "exhausted" },
      });
      expect(internals.emulatorLossRecoveryResolvers.has(duplicateIncident!)).toBe(false);
      expect(internals.emulatorLossRecoverySettlements.has(duplicateIncident!)).toBe(false);
    });

    test("records failed recovery spawn attempts", async () => {
      const images: DeviceInfo[] = [
        androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
      ];
      const manager = new FakeDeviceManagerWithFailingRecoveryStart(images);
      const persistence = new FakeDeviceSessionPersistence();
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      const incidents = new InMemoryEmulatorLossIncidentStore(
        fakeTimer,
        new CountingIdGenerator("incident"),
      );
      const twoFailedAttempts = {
        async run(_target: DeviceInfo, reboot: () => Promise<void>): Promise<boolean> {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await reboot();
            } catch {
              // The retry policy intentionally continues after each failed start.
            }
          }
          return false;
        },
      };
      devicePool = makePool({
        deviceManager: manager,
        androidDeviceReboot: twoFailedAttempts,
        recoveryPolicy: { onLoss: true, maxAttempts: 2 },
        emulatorLossIncidentStore: incidents,
      });

      await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      manager.bootedDevices = [];
      manager.childProcesses[0]!.emit("exit", 1, null);
      await drainUntil(
        () =>
          sessionManager.getSession("session-1") === null &&
          !devicePool.isSessionRecoveryInFlight("session-1"),
        { description: "failed recovery exhaustion and release" },
      );

      const [incident] = await incidents.list();
      expect(incident?.recovery).toEqual({
        policy: { onLoss: true, maxAttempts: 2 },
        attempts: [
          { attempt: 1, outcome: "failed" },
          { attempt: 2, outcome: "failed" },
        ],
        outcome: "exhausted",
      });
      expect(sessionManager.getSession("session-1")).toBeNull();
      expect(await persistence.getSession("session-1")).toMatchObject({
        release_reason: deviceRestartReleaseReason("Pixel 8"),
        stable_device_id: "Pixel 8",
      });
      // Exhaustion reports promptly while a returning runtime can still resume.
      await expect(
        sessionManager.getOrCreateSession("session-1", devicePool, "android"),
      ).rejects.toThrow("watched-process-exit (code=1, signal=null); recovery outcome: exhausted");
      fakeTimer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);
      // A new call after the recovery window lapses terminalizes the released row.
      const resume = sessionManager.getOrCreateSession("session-1", devicePool, "android");
      await expect(resume).rejects.toBeInstanceOf(TerminalSessionError);
      await expect(resume).rejects.toMatchObject({
        release: { releaseReason: "restart-recovery-timeout", terminal: true },
      });
      expect(await persistence.getSession("session-1")).toMatchObject({
        status: "expired",
        release_reason: "restart-recovery-timeout",
      });
    });

    test("does not recover an emulator intentionally shut down by the client", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
        ];
        const manager = new FakeDeviceManagerWithStartedProcess(images);
        devicePool = makePool({ deviceManager: manager });

        await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
        devicePool.markIntentionalShutdown("emulator-5554");
        manager.childProcess.emit("exit", 1, null);
        await drainUntil(
          () =>
            devicePool.getDevice("emulator-5554") === null &&
            !devicePool.isSessionRecoveryInFlight("session-1"),
          { description: "intentional shutdown eviction" },
        );

        expect(manager.startedDevices).toHaveLength(1);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("recovers an emulator after a failed intentional shutdown is cleared", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
        ];
        const manager = new FakeDeviceManagerWithStartedProcess(images);
        devicePool = makePool({ deviceManager: manager });

        await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
        devicePool.markIntentionalShutdown("emulator-5554");
        devicePool.clearIntentionalShutdown("emulator-5554");
        manager.childProcess.emit("exit", 1, null);
        await drainUntil(
          () =>
            manager.startedDevices.length === 2 &&
            !devicePool.isSessionRecoveryInFlight("session-1"),
          { description: "cleared shutdown recovery completion" },
        );

        expect(manager.startedDevices).toHaveLength(2);
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("ignores an old emulator process exit after same-serial recovery", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
        ];
        const manager = new FakeDeviceManagerWithDistinctStartedProcesses(images);
        devicePool = makePool({ deviceManager: manager });

        await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
        await devicePool.releaseDevice("emulator-5554", "session-1");
        manager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice("emulator-5554");
        await devicePool.assignMultipleDevices(["session-2"], 1000, "android");

        manager.childProcesses[0]!.emit("exit", 1, null);
        // The ignored exit has no completion signal. Drain its bounded microtask work.
        await drainMicrotasks(72);

        expect(devicePool.getDevice("emulator-5554")?.sessionId).toBe("session-2");
        expect(sessionManager.getSession("session-2")).not.toBeNull();
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("retries when a recovery process exited before tracking was attached", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
        ];
        const manager = new FakeDeviceManagerWithExitedRecoveryProcess(images);
        devicePool = makePool({ deviceManager: manager });

        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await drainUntil(() => fakeTimer.getPendingSleepCount() > 0, {
          description: "failed recovery retry sleep",
        });
        expect(fakeTimer.getPendingSleeps()).toEqual([1_000]);
        fakeTimer.advanceTime(1_000);
        await drainUntil(
          () =>
            manager.childProcesses.length === 3 &&
            !devicePool.isSessionRecoveryInFlight("session-1"),
          { description: "replacement recovery completion" },
        );

        expect(manager.childProcesses).toHaveLength(3);
        expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("adopts the listed AVD when the initial cold boot launcher exited before tracking", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
        ];
        const manager = new FakeDeviceManagerWithExitedInitialProcess(images);
        devicePool = makePool({ deviceManager: manager });

        await expect(
          devicePool.assignMultipleDevices(["session-1"], 1_000, "android"),
        ).resolves.toEqual(new Map([["session-1", "emulator-5554"]]));
        expect(manager.childProcesses).toHaveLength(1);
        expect(devicePool.getDevice("emulator-5554")?.sessionId).toBe("session-1");
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("retries when a recovery process was killed by a signal before tracking", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" }),
        ];
        const manager = new FakeDeviceManagerWithExitedRecoveryProcess(images, null, "SIGTERM");
        devicePool = makePool({ deviceManager: manager });

        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await drainUntil(() => fakeTimer.getPendingSleepCount() > 0, {
          description: "failed recovery retry sleep",
        });
        expect(fakeTimer.getPendingSleeps()).toEqual([1_000]);
        fakeTimer.advanceTime(1_000);
        await drainUntil(
          () =>
            manager.childProcesses.length === 3 &&
            !devicePool.isSessionRecoveryInFlight("session-1"),
          { description: "replacement recovery completion" },
        );

        expect(manager.childProcesses).toHaveLength(3);
        expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("does not launch an AVD while recovery already owns its boot", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new DeferredRecoveryDeviceManager();
      manager.deviceImages = [
        androidDeviceImage("pixel_8_api_35", "emulator-5554", {
          deviceType: "Pixel 8",
          source: "local",
        }),
      ];
      devicePool = makePool({ deviceManager: manager });
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await manager.waitForRecoveryStart();

        const allocation = devicePool.assignMultipleDevicesByCriteria(
          [
            {
              sessionId: "session-2",
              criteria: { platform: "android", simulatorType: "Pixel 8" },
            },
          ],
          3_000,
        );
        let allocationSettled = false;
        void allocation.then(
          () => {
            allocationSettled = true;
          },
          () => {
            allocationSettled = true;
          },
        );

        // The allocation has completed its launch decision and is waiting while
        // recovery readiness is still gated, so this launch count is meaningful.
        await drainUntil(() => fakeTimer.getPendingTimeouts().includes(1_000), {
          description: "allocation retry while recovery owns boot",
        });
        expect(fakeTimer.getPendingTimeouts()).toContain(1_000);
        expect(devicePool.getRecoveringAndroidTargets().names.has("pixel_8_api_35")).toBe(true);
        expect(manager.childProcesses).toHaveLength(2);
        manager.releaseRecovery();
        await drainUntil(
          () => !devicePool.getRecoveringAndroidTargets().names.has("pixel_8_api_35"),
          { description: "owned AVD recovery settlement" },
        );

        for (let step = 0; step < 4 && !allocationSettled; step++) {
          expect(fakeTimer.getPendingTimeouts()).toContain(1_000);
          fakeTimer.advanceTime(1_000);
          await drainUntil(
            () => allocationSettled || fakeTimer.getPendingTimeouts().includes(1_000),
            {
              description: "allocation settlement or next retry sleep",
            },
          );
        }
        expect(allocationSettled).toBe(true);
        await expect(allocation).rejects.toThrow("Timed out allocating devices");
        expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-5554");
        expect(manager.childProcesses).toHaveLength(2);
      } finally {
        manager.releaseRecovery();
        try {
          await drainUntil(
            () => !devicePool.getRecoveringAndroidTargets().names.has("pixel_8_api_35"),
            { description: "owned AVD recovery settlement" },
          );
        } finally {
          if (originalRebootOnDeath === undefined) {
            delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
          } else {
            process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
          }
        }
      }
    });

    test.each(["criteria", "platform"] as const)(
      "joins an AVD boot completed while %s allocation waited for its lifecycle lease",
      async (allocationPath) => {
        const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(fakeTimer);
        fakeDeviceManager.deviceImages = [
          androidDeviceImage("pixel_8_api_35", "emulator-5554", {
            deviceType: "Pixel 8",
            source: "local",
          }),
        ];
        devicePool = makePool({ lifecycleCoordinator });
        const owner = await lifecycleCoordinator.reserve(
          { kind: "stable", platform: "android", stableId: "pixel_8_api_35" },
          { operation: "recovery", deadlineMs: 300_000 },
        );
        const pendingTimeouts = fakeTimer.getPendingTimeoutCount();
        const allocation =
          allocationPath === "criteria"
            ? devicePool.assignMultipleDevicesByCriteria(
                [
                  {
                    sessionId: "session-2",
                    criteria: { platform: "android", simulatorType: "Pixel 8" },
                  },
                ],
                3_000,
              )
            : devicePool.assignMultipleDevices(["session-2"], 3_000, "android");
        let allocationSettled = false;
        void allocation.then(
          () => {
            allocationSettled = true;
          },
          () => {
            allocationSettled = true;
          },
        );
        try {
          // The pool's start timeout plus the coordinator's waiter timeout prove
          // acquisition passed candidate selection and queued behind the owner.
          for (
            let turn = 0;
            turn < 1_000 && fakeTimer.getPendingTimeoutCount() < pendingTimeouts + 2;
            turn++
          ) {
            await Promise.resolve();
          }
          expect(fakeTimer.getPendingTimeoutCount()).toBe(pendingTimeouts + 2);
          expect(fakeDeviceManager.startedDevices).toHaveLength(0);
          fakeDeviceManager.bootedDevices = [
            {
              name: "pixel_8_api_35",
              platform: "android",
              deviceId: "emulator-5554",
              deviceType: "Pixel 8",
              source: "local",
            },
          ];
          // Recovery publishes the winner before releasing its lifecycle lease.
          await devicePool.refreshDevices();
          owner.release();
          for (let turn = 0; turn < 1_000 && !allocationSettled; turn++) {
            await Promise.resolve();
          }
          expect(allocationSettled).toBe(true);
          const assignments = await allocation;
          expect(assignments.get("session-2")).toBe("emulator-5554");
          expect(fakeDeviceManager.startedDevices).toHaveLength(0);
          expect(fakeTimer.getPendingTimeoutCount()).toBe(pendingTimeouts);
          let leaseReleased = false;
          const nextOwner = lifecycleCoordinator.reserve(
            { kind: "stable", platform: "android", stableId: "pixel_8_api_35" },
            { operation: "start", deadlineMs: 3_000 },
          );
          void nextOwner.then((lease) => {
            leaseReleased = true;
            lease.release();
          });
          for (let turn = 0; turn < 1_000 && !leaseReleased; turn++) {
            await Promise.resolve();
          }
          expect(leaseReleased).toBe(true);
        } finally {
          owner.release();
        }
      },
    );

    test("does not defer incompatible criteria allocation for an unrelated recovering AVD", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new DeferredRecoveryDeviceManager();
      manager.deviceImages = [
        androidDeviceImage("pixel_8_api_35", "emulator-5554", {
          deviceType: "Pixel 8",
          source: "local",
        }),
      ];
      devicePool = makePool({ deviceManager: manager });
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await manager.waitForRecoveryStart();

        await expect(
          devicePool.assignMultipleDevicesByCriteria(
            [
              {
                sessionId: "session-2",
                criteria: { platform: "android", simulatorType: "Pixel 9" },
              },
            ],
            3_000,
          ),
        ).rejects.toThrow(/No devices match criteria.*simulatorType=Pixel 9/);
        expect(manager.childProcesses).toHaveLength(2);
      } finally {
        manager.releaseRecovery();
        await drainUntil(() => devicePool.getRecoveringAndroidTargets().names.size === 0, {
          description: "owned recovery settlement",
        });
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("does not count one pending recovery as capacity for multiple devices", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new DeferredRecoveryDeviceManager();
      manager.deviceImages = [androidDeviceImage("Pixel 8", "emulator-5554", { source: "local" })];
      devicePool = makePool({ deviceManager: manager });
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await manager.waitForRecoveryStart();

        await expect(
          devicePool.assignMultipleDevices(["session-2", "session-3"], 3_000, "android"),
        ).rejects.toThrow("Not enough devices in pool: need 2, have 0");
        expect(manager.childProcesses).toHaveLength(2);
      } finally {
        manager.releaseRecovery();
        await drainUntil(() => devicePool.getRecoveringAndroidTargets().names.size === 0, {
          description: "owned recovery settlement",
        });
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });
  });
});
