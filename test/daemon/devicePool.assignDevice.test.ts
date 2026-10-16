import { drainUntil, settleWithFakeTime } from "../helpers/fakeTimerStepping";

import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  ANONYMOUS_ACQUISITION_SESSION_SOURCE,
  SessionManager,
} from "../../src/daemon/sessionManager";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import {
  type DeviceSessionPersistence,
  type DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSession } from "../../src/db/types";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { ActionableError, Platform } from "../../src/models";
import { DeviceLostError } from "../../src/models/DeviceLostError";

import { ExecutionTracker } from "../../src/server/executionTracker";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  CountingFakeDeviceManager,
  DeferredLivenessRecoveryDeviceManager,
  DeferredReconnectionDiscoveryFakeDeviceManager,
  FakeChildProcess,
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
    test.each([false, true])(
      "recovers a restarted Android session only onto its persisted AVD identity, reverse=%s",
      async (reverse) => {
        const persisted: DeviceSession = {
          session_uuid: "restarted-session",
          device_id: "emulator-5554",
          stable_device_id: "Original_AVD",
          platform: "android",
          status: "expired",
          source: "session-manager",
          autolock_enabled: 0,
          mcp_session_id: null,
          daemon_session_id: "old-daemon",
          created_at_ms: 1,
          last_used_at_ms: 20,
          expires_at_ms: 30,
          released_at_ms: 25,
          release_reason: "daemon-restart",
          session_timeout_ms: 60_000,
          heartbeat_timeout_ms: 12_000,
          heartbeat_timeout_source: "custom",
          has_received_heartbeat: 1,
          liveness_policy: "heartbeat",
          created_at: "2026-09-14T00:00:00.000Z",
          updated_at: "2026-09-14T00:00:00.000Z",
        };
        const persistedUpdates: DeviceSessionRecord[] = [];
        const persistence: DeviceSessionPersistence = Object.assign(
          new FakeDeviceSessionPersistence(),
          {
            recordLivenessOwnership: async () => {},
            replaceLivenessOwnership: async () => {},
            claimRecoverableSession: async (_id, expected) => expected.rowGeneration,
            async getSession() {
              return persisted;
            },
            async upsertActiveSession(record) {
              persistedUpdates.push(record);
            },
            async recordActivity() {},
            async markReleased() {},
          } satisfies Partial<DeviceSessionPersistence> & Record<string, unknown>,
        );
        sessionManager.stopCleanupTimer();
        sessionManager = new SessionManager(fakeTimer, persistence);
        devicePool = makePool();
        const devices = [
          createBootedDevice("emulator-5554", "android", "Unrelated_AVD"),
          createBootedDevice("emulator-5556", "android", "Original_AVD"),
        ];
        await initializeLiveDevices(reverse ? devices.toReversed() : devices);

        const recovered = await sessionManager.getOrCreateSession(
          "restarted-session",
          devicePool,
          "android",
          undefined,
          true,
        );

        expect(recovered).toMatchObject({
          assignedDevice: "emulator-5556",
          stableDeviceId: "Original_AVD",
          sessionTimeoutMs: 60_000,
          heartbeatTimeoutMs: 12_000,
          heartbeatTimeoutSource: "custom",
          hasReceivedHeartbeat: true,
          livenessPolicy: "heartbeat",
        });
        const reaped: Array<{ sessionId: string; reason: string }> = [];
        const monitor = new SessionHeartbeatMonitor(
          sessionManager,
          () => false,
          async (sessionId, reason) => {
            reaped.push({ sessionId, reason });
          },
          fakeTimer,
        );
        fakeTimer.advanceTime(5_001);
        await monitor.tick();
        expect(reaped).toEqual([]);
        expect(persistedUpdates).toEqual([
          expect.objectContaining({
            deviceId: "emulator-5556",
            stableDeviceId: "Original_AVD",
          }),
        ]);
        expect(devicePool.getDevice("emulator-5554")).toMatchObject({
          sessionId: null,
          status: "idle",
        });
      },
    );

    test("restores a recovered autolock session's CLI idle policy", async () => {
      const persisted: DeviceSession = {
        session_uuid: "restarted-cli-session",
        device_id: "emulator-5554",
        stable_device_id: "Original_AVD",
        platform: "android",
        status: "expired",
        source: "autolock",
        autolock_enabled: 1,
        mcp_session_id: "old-mcp-session",
        daemon_session_id: "old-daemon",
        created_at_ms: 1,
        last_used_at_ms: 20,
        expires_at_ms: 60_020,
        released_at_ms: 25,
        release_reason: "daemon-restart",
        session_timeout_ms: 60_000,
        heartbeat_timeout_ms: 60_000,
        heartbeat_timeout_source: "custom",
        has_received_heartbeat: false,
        liveness_policy: "cli-idle",
        pre_cli_heartbeat_timeout_ms: 12_000,
        pre_cli_heartbeat_timeout_source: "custom",
        pre_cli_session_timeout_ms: 60_000,
        created_at: "2026-09-14T00:00:00.000Z",
        updated_at: "2026-09-14T00:00:00.000Z",
      };
      const persistence: DeviceSessionPersistence = Object.assign(
        new FakeDeviceSessionPersistence(),
        {
          recordLivenessOwnership: async () => {},
          replaceLivenessOwnership: async () => {},
          claimRecoverableSession: async (_id, expected) => expected.rowGeneration,
          async getSession() {
            return persisted;
          },
          async upsertActiveSession() {},
          async recordActivity() {},
          async markReleased() {},
        } satisfies Partial<DeviceSessionPersistence> & Record<string, unknown>,
      );
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = makePool();
      await initializeLiveDevices([createBootedDevice("emulator-5556", "android", "Original_AVD")]);

      const recovered = await sessionManager.getOrCreateSession(
        persisted.session_uuid,
        devicePool,
        "android",
        undefined,
        true,
      );

      expect(recovered).toMatchObject({
        livenessPolicy: "cli-idle",
        heartbeatTimeoutMs: 60_000,
        heartbeatTimeoutSource: "custom",
        hasReceivedHeartbeat: false,
        preCliLiveness: {
          sessionTimeoutMs: 60_000,
          heartbeatTimeoutMs: 12_000,
          heartbeatTimeoutSource: "custom",
        },
      });
      const reaped: Array<{ sessionId: string; reason: string }> = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sessionId, reason) => {
          reaped.push({ sessionId, reason });
        },
        fakeTimer,
      );
      fakeTimer.advanceTime(60_001);
      await monitor.tick();

      expect(reaped).toEqual([{ sessionId: persisted.session_uuid, reason: "cli-idle-timeout" }]);
    });

    test("keeps unresolved persisted identity retryable before fencing a resolved same-serial replacement", async () => {
      const persisted: DeviceSession = {
        session_uuid: "restarted-session",
        device_id: "emulator-5554",
        stable_device_id: "Original_AVD",
        platform: "android",
        status: "expired",
        source: "session-manager",
        autolock_enabled: 0,
        mcp_session_id: null,
        daemon_session_id: "old-daemon",
        created_at_ms: 1,
        last_used_at_ms: 20,
        expires_at_ms: 30,
        released_at_ms: 25,
        release_reason: "daemon-restart",
        session_timeout_ms: 10,
        heartbeat_timeout_ms: 5,
        has_received_heartbeat: 1,
        created_at: "2026-09-14T00:00:00.000Z",
        updated_at: "2026-09-14T00:00:00.000Z",
      };
      const releaseReasons: string[] = [];
      const persistence: DeviceSessionPersistence = Object.assign(
        new FakeDeviceSessionPersistence(),
        {
          recordLivenessOwnership: async () => {},
          replaceLivenessOwnership: async () => {},
          claimRecoverableSession: async (_id, expected) => expected.rowGeneration,
          async getSession() {
            return persisted;
          },
          async upsertActiveSession() {
            throw new Error("same-serial replacement must not create a recovered session");
          },
          async recordActivity() {},
          async markReleased(_sessionUuid, _status, _releasedAtMs, releaseReason) {
            releaseReasons.push(releaseReason);
            persisted.release_reason = releaseReason;
          },
        } satisfies Partial<DeviceSessionPersistence> & Record<string, unknown>,
      );
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = makePool();
      await initializeLiveDevices([
        createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)"),
      ]);

      const recovery = sessionManager.getOrCreateSession(
        persisted.session_uuid,
        devicePool,
        "android",
        undefined,
        true,
      );
      await drainUntil(() => fakeTimer.getPendingSleepCount() > 0, {
        description: "identity recovery retry sleep",
      });

      expect(fakeTimer.getPendingSleeps()).toEqual([1000]);
      expect(releaseReasons).toEqual([]);
      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);

      fakeDeviceManager.bootedDevices = [
        createBootedDevice("emulator-5554", "android", "Replacement_AVD"),
      ];
      await devicePool.refreshDevices();
      fakeTimer.advanceTime(1000);

      await expect(recovery).rejects.toThrow("recovery reason: identity-continuity-lost");
      expect(releaseReasons).toEqual(["identity-recovery-identity-continuity-lost"]);
      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        name: "Replacement_AVD",
        sessionId: null,
        status: "idle",
      });
    });

    test.each([
      {
        platform: "android" as const,
        deviceId: "emulator-5554",
        stableDeviceId: "Original_AVD",
        failedSource: "android" as const,
      },
      {
        platform: "ios" as const,
        deviceId: "00000000-0000-0000-0000-000000000001",
        stableDeviceId: "00000000-0000-0000-0000-000000000001",
        failedSource: "ios-simulator" as const,
      },
    ])(
      "keeps an absent $platform recovery target retryable until its discovery source succeeds",
      async ({ platform, deviceId, stableDeviceId, failedSource }) => {
        const persisted: DeviceSession = {
          session_uuid: `restarted-${platform}-session`,
          device_id: deviceId,
          stable_device_id: stableDeviceId,
          platform,
          status: "expired",
          source: "session-manager",
          autolock_enabled: 0,
          mcp_session_id: null,
          daemon_session_id: "old-daemon",
          created_at_ms: 1,
          last_used_at_ms: 20,
          expires_at_ms: 30,
          released_at_ms: 25,
          release_reason: "daemon-restart",
          session_timeout_ms: 10,
          heartbeat_timeout_ms: 5,
          has_received_heartbeat: 1,
          created_at: "2026-09-14T00:00:00.000Z",
          updated_at: "2026-09-14T00:00:00.000Z",
        };
        const releaseReasons: string[] = [];
        const persistence: DeviceSessionPersistence = Object.assign(
          new FakeDeviceSessionPersistence(),
          {
            recordLivenessOwnership: async () => {},
            replaceLivenessOwnership: async () => {},
            claimRecoverableSession: async (_id, expected) => expected.rowGeneration,
            async getSession() {
              return persisted;
            },
            async upsertActiveSession() {
              throw new Error("an absent recovery target must not create a recovered session");
            },
            async recordActivity() {},
            async markReleased(_sessionUuid, _status, _releasedAtMs, releaseReason) {
              releaseReasons.push(releaseReason);
              persisted.release_reason = releaseReason;
            },
          } satisfies Partial<DeviceSessionPersistence> & Record<string, unknown>,
        );
        sessionManager.stopCleanupTimer();
        sessionManager = new SessionManager(fakeTimer, persistence);
        devicePool = makePool();
        fakeDeviceManager.bootedDevices = [];
        fakeDeviceManager.failedSources.add(failedSource);

        const recovery = sessionManager.getOrCreateSession(
          persisted.session_uuid,
          devicePool,
          platform,
          undefined,
          true,
        );
        await drainUntil(() => fakeTimer.getPendingSleepCount() > 0, {
          description: "absent target recovery retry sleep",
        });

        expect(fakeTimer.getPendingSleeps()).toEqual([1000]);
        expect(releaseReasons).toEqual([]);

        fakeDeviceManager.failedSources.delete(failedSource);
        fakeTimer.advanceTime(1000);

        await expect(recovery).rejects.toThrow("recovery reason: target-absent");
        expect(releaseReasons).toEqual(["identity-recovery-target-absent"]);
      },
    );

    test("does not recover an Android emulator session onto a physical device with the same identifier", async () => {
      const persisted: DeviceSession = {
        session_uuid: "restarted-session",
        device_id: "emulator-5554",
        stable_device_id: "Original_AVD",
        platform: "android",
        status: "expired",
        source: "session-manager",
        autolock_enabled: 0,
        mcp_session_id: null,
        daemon_session_id: "old-daemon",
        created_at_ms: 1,
        last_used_at_ms: 20,
        expires_at_ms: 30,
        released_at_ms: 25,
        release_reason: "daemon-restart",
        session_timeout_ms: 10,
        heartbeat_timeout_ms: 5,
        has_received_heartbeat: 1,
        created_at: "2026-09-14T00:00:00.000Z",
        updated_at: "2026-09-14T00:00:00.000Z",
      };
      const persistence: DeviceSessionPersistence = Object.assign(
        new FakeDeviceSessionPersistence(),
        {
          recordLivenessOwnership: async () => {},
          replaceLivenessOwnership: async () => {},
          claimRecoverableSession: async (_id, expected) => expected.rowGeneration,
          async getSession() {
            return persisted;
          },
          async upsertActiveSession() {},
          async recordActivity() {},
          async markReleased() {},
        } satisfies Partial<DeviceSessionPersistence> & Record<string, unknown>,
      );
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = makePool();
      await initializeLiveDevices([createBootedDevice("Original_AVD", "android", "Pixel 9")]);

      await expect(
        sessionManager.getOrCreateSession(
          "restarted-session",
          devicePool,
          "android",
          undefined,
          true,
        ),
      ).rejects.toThrow(/cannot safely recover/i);
      expect(devicePool.getDevice("Original_AVD")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    });

    test("does not recover an Android emulator session onto an unresolved placeholder", async () => {
      const persisted: DeviceSession = {
        session_uuid: "restarted-session",
        device_id: "emulator-5554",
        stable_device_id: "Unknown (emulator-5554)",
        platform: "android",
        status: "expired",
        source: "session-manager",
        autolock_enabled: 0,
        mcp_session_id: null,
        daemon_session_id: "old-daemon",
        created_at_ms: 1,
        last_used_at_ms: 20,
        expires_at_ms: 30,
        released_at_ms: 25,
        release_reason: "daemon-restart",
        session_timeout_ms: 10,
        heartbeat_timeout_ms: 5,
        has_received_heartbeat: 1,
        created_at: "2026-09-14T00:00:00.000Z",
        updated_at: "2026-09-14T00:00:00.000Z",
      };
      const persistence: DeviceSessionPersistence = Object.assign(
        new FakeDeviceSessionPersistence(),
        {
          recordLivenessOwnership: async () => {},
          replaceLivenessOwnership: async () => {},
          claimRecoverableSession: async (_id, expected) => expected.rowGeneration,
          async getSession() {
            return persisted;
          },
          async upsertActiveSession() {},
          async recordActivity() {},
          async markReleased() {},
        } satisfies Partial<DeviceSessionPersistence> & Record<string, unknown>,
      );
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = makePool();
      await initializeLiveDevices([
        createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)"),
      ]);

      await expect(
        sessionManager.getOrCreateSession(
          "restarted-session",
          devicePool,
          "android",
          undefined,
          true,
        ),
      ).rejects.toThrow(/cannot safely recover/i);
      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    });

    test("refuses a restarted iOS session when only a different UUID is available", async () => {
      const persisted: DeviceSession = {
        session_uuid: "restarted-session",
        device_id: "old-simulator-uuid",
        stable_device_id: "original-simulator-uuid",
        platform: "ios",
        status: "expired",
        source: "session-manager",
        autolock_enabled: 0,
        mcp_session_id: null,
        daemon_session_id: "old-daemon",
        created_at_ms: 1,
        last_used_at_ms: 20,
        expires_at_ms: 30,
        released_at_ms: 25,
        release_reason: "daemon-restart",
        session_timeout_ms: 10,
        heartbeat_timeout_ms: 5,
        has_received_heartbeat: 1,
        created_at: "2026-09-14T00:00:00.000Z",
        updated_at: "2026-09-14T00:00:00.000Z",
      };
      const persistence: DeviceSessionPersistence = Object.assign(
        new FakeDeviceSessionPersistence(),
        {
          recordLivenessOwnership: async () => {},
          replaceLivenessOwnership: async () => {},
          claimRecoverableSession: async (_id, expected) => expected.rowGeneration,
          async getSession() {
            return persisted;
          },
          async upsertActiveSession() {},
          async recordActivity() {},
          async markReleased() {},
        } satisfies Partial<DeviceSessionPersistence> & Record<string, unknown>,
      );
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = makePool();
      await initializeLiveDevices([
        createBootedDevice("replacement-simulator-uuid", "ios", "iPhone 16"),
      ]);

      await expect(
        sessionManager.getOrCreateSession("restarted-session", devicePool, "ios", undefined, true),
      ).rejects.toThrow(/cannot safely recover/i);
      expect(devicePool.getDevice("replacement-simulator-uuid")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    });

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
        devicePool.bindOrReuseDeviceSession("shared-session", otherDeviceId, "android"),
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

      const explicitBinding = devicePool.bindOrReuseDeviceSession(
        "shared-session",
        "emulator-5556",
        "android",
      );
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
      await devicePool.initializeWithDevices(deviceIds.map(createBootedDevice));
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
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
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
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("should bind a specific device to a session", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];

      const sessionId = await devicePool.bindOrReuseDeviceSession("session-1", "sim-1", "ios");

      expect(sessionId).toBe("session-1");
      const device = devicePool.getDevice("sim-1");
      expect(device?.sessionId).toBe("session-1");
      expect(device?.status).toBe("busy");
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("sim-1");
    });

    test("keeps a shutdown reservation exclusive to direct binding and autolock", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await initializeLiveDevices([device]);
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected shutdown device to be pooled");
      }
      const reservation = await devicePool.reserveDeviceForShutdown(captured.id);
      if (!reservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        expect(devicePool.getAvailableDeviceCount()).toBe(0);
        devicePool.markIntentionalShutdown(captured.id);
        await devicePool.removeDisconnectedDevice(captured.id, false);
        expect(devicePool.getDevice(captured.id)).toBe(captured);
        await expect(
          devicePool.bindOrReuseDeviceSession("session-1", device.deviceId, device.platform),
        ).rejects.toThrow(/shutting down/);

        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        await expect(
          devicePool.autolockDevice(device.deviceId, device.platform, "mcp-session-1"),
        ).rejects.toThrow(/shutting down/);
      } finally {
        await reservation.release();
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }

      expect(devicePool.getAvailableDeviceCount()).toBe(0);
      devicePool.noteLatePlatformShutdownSettled(captured);
      await devicePool.refreshDevices();
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
      await expect(
        devicePool.bindOrReuseDeviceSession("session-1", device.deviceId, device.platform),
      ).resolves.toBe("session-1");
    });

    test("releases the old pooled device after rebinding an existing session", async () => {
      await initializeLiveDevices([
        createBootedDevice("emulator-old"),
        createBootedDevice("emulator-new"),
      ]);
      await devicePool.bindOrReuseDeviceSession("session-1", "emulator-old", "android");

      await devicePool.bindOrReuseDeviceSession(
        "session-1",
        "emulator-new",
        "android",
        undefined,
        undefined,
        undefined,
        true,
      );

      expect(devicePool.getDevice("emulator-old")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
      expect(devicePool.getDevice("emulator-new")).toMatchObject({
        sessionId: "session-1",
        status: "busy",
      });
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-new");
    });

    describe("rebind cancels the old device's running work (#9944)", () => {
      interface DeviceCancellation {
        deviceId: string;
        reason: string | Error;
        excludeExecutionId: string | undefined;
        onlySessionUuid: string | undefined;
        oldDeviceStatus: string | undefined;
      }
      let cancellations: DeviceCancellation[];
      let sessionCancellations: string[];
      let cancelImpl: () => Promise<number>;

      beforeEach(async () => {
        cancellations = [];
        sessionCancellations = [];
        cancelImpl = async () => 1;
        devicePool = makePool({
          ambientExecutionIdReader: { getExecutionId: () => "set-active-device-execution" },
          cancelDeviceSessionExecutions: Object.assign(
            async (sessionId: string) => {
              sessionCancellations.push(sessionId);
              return 0;
            },
            {
              cancelDeviceExecutions: async (
                deviceId: string,
                reason: string | Error,
                options?: { excludeExecutionId?: string; onlySessionUuid?: string },
              ) => {
                cancellations.push({
                  deviceId,
                  reason,
                  excludeExecutionId: options?.excludeExecutionId,
                  onlySessionUuid: options?.onlySessionUuid,
                  oldDeviceStatus: devicePool.getDevice("emulator-old")?.status,
                });
                return await cancelImpl();
              },
            },
          ),
        });
        await initializeLiveDevices([
          createBootedDevice("emulator-old"),
          createBootedDevice("emulator-new"),
        ]);
        await devicePool.bindOrReuseDeviceSession("session-1", "emulator-old", "android");
      });

      const rebind = () =>
        devicePool.bindOrReuseDeviceSession(
          "session-1",
          "emulator-new",
          "android",
          undefined,
          undefined,
          undefined,
          true,
        );

      test("cancels work on the old device, excluding the caller, before it goes idle", async () => {
        expect(cancellations).toEqual([]);

        await rebind();

        expect(cancellations).toHaveLength(1);
        const [cancellation] = cancellations;
        expect(cancellation).toMatchObject({
          deviceId: "emulator-old",
          excludeExecutionId: "set-active-device-execution",
          onlySessionUuid: "session-1",
          oldDeviceStatus: "busy",
        });
        // The caller-visible reason says what happened and is not a device-lost outcome.
        expect(cancellation.reason).toBeInstanceOf(ActionableError);
        expect(cancellation.reason).not.toBeInstanceOf(DeviceLostError);
        expect(cancellation.reason).toHaveProperty(
          "message",
          expect.stringMatching(
            /Session session-1 was rebound from device 'emulator-old' to another device/,
          ),
        );
        // Only device-bound work on the old device is cancelled: a session-wide
        // cancel would also stop calls already running on the new device.
        expect(sessionCancellations).toEqual([]);
        expect(devicePool.getDevice("emulator-old")).toMatchObject({
          sessionId: null,
          status: "idle",
        });
      });

      test("keeps the old device out of the pool until cancelled work has settled", async () => {
        const settled = Promise.withResolvers<number>();
        const cancelStarted = Promise.withResolvers<void>();
        cancelImpl = () => {
          cancelStarted.resolve();
          return settled.promise;
        };

        const rebinding = rebind();
        await cancelStarted.promise;

        expect(cancellations).toHaveLength(1);
        expect(devicePool.getDevice("emulator-old")?.status).toBe("busy");
        expect(devicePool.getDevice("emulator-old")?.sessionId).toBe("session-1");

        settled.resolve(1);
        await rebinding;

        expect(devicePool.getDevice("emulator-old")).toMatchObject({
          sessionId: null,
          status: "idle",
        });
      });

      test("still releases the old device when the canceller fails", async () => {
        cancelImpl = async () => {
          throw new Error("drain failed");
        };

        await rebind();

        expect(devicePool.getDevice("emulator-old")).toMatchObject({
          sessionId: null,
          status: "idle",
        });
        expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-new");
      });

      test("with the real tracker, stops only the rebinding session's work with a clear message", async () => {
        const tracker = new ExecutionTracker(
          fakeTimer,
          new FakeIdGenerator(["own", "peer", "sessionless", "caller", "pending"]),
        );
        devicePool = makePool({
          ambientExecutionIdReader: { getExecutionId: () => "caller" },
          cancelDeviceSessionExecutions: Object.assign(
            tracker.cancelDeviceSessionExecutions.bind(tracker),
            { cancelDeviceExecutions: tracker.cancelDeviceExecutions.bind(tracker) },
          ),
        });
        await initializeLiveDevices([
          createBootedDevice("emulator-old"),
          createBootedDevice("emulator-new"),
        ]);
        await devicePool.bindOrReuseDeviceSession("session-1", "emulator-old", "android");
        const own = tracker.startExecution("observe", undefined, "session-1");
        const peer = tracker.startExecution("observe", undefined, "session-2");
        const sessionless = tracker.startExecution("observe");
        const caller = tracker.startExecution("setActiveDevice", undefined, "session-1");
        // Admitted for session-1 but not yet bound to the old device when the rebind lands (#9958).
        const pending = tracker.startExecution("tapOn", undefined, "session-1");
        for (const execution of [own, peer, sessionless, caller]) {
          tracker.bindDeviceExecution(execution.id, "emulator-old");
        }

        await rebind();

        expect(() => tracker.bindDeviceExecution(pending.id, "emulator-old")).toThrow(
          /was rebound from device 'emulator-old'/,
        );
        expect(() => tracker.bindDeviceExecution(own.id, "emulator-old")).toThrow(ActionableError);
        tracker.bindDeviceExecution(pending.id, "emulator-new");
        tracker.bindDeviceExecution(peer.id, "emulator-old");
        tracker.bindDeviceExecution(sessionless.id, "emulator-old");

        const reason = own.abortController.signal.reason;
        expect(reason).toBeInstanceOf(ActionableError);
        expect(reason).not.toBeInstanceOf(DeviceLostError);
        expect(reason.message).toContain("was rebound from device 'emulator-old'");
        expect(peer.abortController.signal.aborted).toBe(false);
        expect(sessionless.abortController.signal.aborted).toBe(false);
        expect(caller.abortController.signal.aborted).toBe(false);
      });

      test("does not cancel anything when the session stays on the same device", async () => {
        await devicePool.bindOrReuseDeviceSession(
          "session-1",
          "emulator-old",
          "android",
          undefined,
          undefined,
          undefined,
          true,
        );

        expect(cancellations).toEqual([]);
        expect(devicePool.getDevice("emulator-old")?.sessionId).toBe("session-1");
      });

      test("does not cancel when a rebind is refused", async () => {
        await expect(
          devicePool.bindOrReuseDeviceSession("session-1", "emulator-new", "android"),
        ).rejects.toThrow(/already assigned to device/);

        expect(cancellations).toEqual([]);
        expect(devicePool.getDevice("emulator-old")?.sessionId).toBe("session-1");
      });
    });

    describe("autolock rebind release", () => {
      let originalAutolock: string | undefined;

      beforeEach(async () => {
        originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        await initializeLiveDevices([
          createBootedDevice("emulator-old"),
          createBootedDevice("emulator-new"),
        ]);
      });

      afterEach(() => {
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      });

      const rebind = (sessionId: string) =>
        devicePool.bindOrReuseDeviceSession(
          sessionId,
          "emulator-new",
          "android",
          undefined,
          undefined,
          undefined,
          true,
        );

      test("allows another session to drive the old device after rebind", async () => {
        const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
        expect(sessionId).toBeDefined();

        await rebind(sessionId!);
        await devicePool.bindOrReuseDeviceSession("next-owner", "emulator-old", "android");

        expect(() => devicePool.assertAutolockAccess("emulator-old", "next-owner")).not.toThrow();
        expect(devicePool.getDevice("emulator-old")).toMatchObject({
          sessionId: "next-owner",
          autolockSessionId: undefined,
        });
        expect(devicePool.getDevice("emulator-new")?.autolockSessionId).toBe(sessionId);
        expect(() => devicePool.assertAutolockAccess("emulator-new", "next-owner")).toThrow(
          "held by another session",
        );
      });

      test("keeps the old device unlocked after releasing the rebound session", async () => {
        const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
        await rebind(sessionId!);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBe(sessionId);
        await sessionManager.releaseSession(sessionId!);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBeUndefined();
        expect(
          devicePool.resolveAutolockSessionForMcpSession(
            "mcp-1",
            "android",
            undefined,
            "emulator-new",
          ),
        ).toBeUndefined();
        await devicePool.releaseDevice("emulator-new", sessionId!);
        await devicePool.bindOrReuseDeviceSession("next-owner", "emulator-old", "android");

        expect(() => devicePool.assertAutolockAccess("emulator-old", "next-owner")).not.toThrow();
        expect(devicePool.getDevice("emulator-old")?.autolockSessionId).toBeUndefined();
        expect(devicePool.getDevice("emulator-new")).toMatchObject({
          sessionId: null,
          status: "idle",
          autolockSessionId: undefined,
        });
      });

      test("transfers the autolock before rebind publishes the replacement assignment", async () => {
        const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
        const publishedStates: Array<{
          assignedDevice: string | undefined;
          lock: string | undefined;
          route: string | undefined;
        }> = [];
        sessionManager.onSessionDeviceUnbound(() => {
          publishedStates.push({
            assignedDevice: sessionManager.getSession(sessionId!)?.assignedDevice,
            lock: devicePool.getDevice("emulator-new")?.autolockSessionId,
            route: devicePool.resolveAutolockSessionForMcpSession("mcp-1"),
          });
        });

        await rebind(sessionId!);

        expect(publishedStates).toEqual([
          { assignedDevice: "emulator-new", lock: sessionId, route: sessionId },
        ]);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBe(sessionId);
      });

      test("clears only the old lock before pool release and reuses the MCP session after rebind", async () => {
        const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
        const events: string[] = [];
        sessionManager.onSessionDeviceUnbound((_id, deviceId) => {
          if (deviceId === "emulator-old") {
            events.push("unbound");
            expect(devicePool.getDevice(deviceId)?.autolockSessionId).toBe(sessionId);
          }
        });
        const releaseDevice = devicePool.releaseDevice.bind(devicePool);
        devicePool.releaseDevice = async (deviceId, expectedSessionId) => {
          events.push("pool-release");
          expect(devicePool.getDevice(deviceId)).toMatchObject({
            sessionId,
            status: "busy",
            autolockSessionId: undefined,
          });
          expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBe(sessionId);
          await releaseDevice(deviceId, expectedSessionId);
        };

        await rebind(sessionId!);

        expect(events).toEqual(["unbound", "pool-release"]);
        expect(devicePool.getDevice("emulator-new")?.autolockSessionId).toBe(sessionId);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBe(sessionId);
        expect(
          devicePool.resolveAutolockSessionForMcpSession(
            "mcp-1",
            "android",
            undefined,
            "emulator-new",
          ),
        ).toBe(sessionId);
        expect(() => devicePool.assertAutolockAccess("emulator-new", sessionId!)).not.toThrow();
        const assignmentCount = devicePool.getDevice("emulator-new")!.assignmentCount;
        const reused = await devicePool.autolockDevice("emulator-new", "android", "mcp-1");
        expect(reused).toBe(sessionId);
        expect(devicePool.getDevice("emulator-new")!.assignmentCount).toBe(assignmentCount);
      });

      test.each([undefined, "target-lock"])(
        "keeps both locks unchanged when rebind persistence fails (target lock: %s)",
        async (targetLock) => {
          sessionManager.stopCleanupTimer();
          const persistence = new FakeDeviceSessionPersistence();
          sessionManager = new SessionManager(fakeTimer, persistence);
          devicePool = makePool();
          await initializeLiveDevices(fakeDeviceManager.bootedDevices);
          const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
          devicePool.getDevice("emulator-new")!.autolockSessionId = targetLock;
          const oldDevice = { ...devicePool.getDevice("emulator-old")! };
          const newDevice = { ...devicePool.getDevice("emulator-new")! };
          persistence.failure = "create";

          await expect(rebind(sessionId!)).rejects.toThrow("persist create failed");

          expect(devicePool.getDevice("emulator-old")).toEqual(oldDevice);
          expect(devicePool.getDevice("emulator-new")).toEqual(newDevice);
          expect(sessionManager.getSession(sessionId!)?.assignedDevice).toBe("emulator-old");
          expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBe(sessionId);
        },
      );

      test("ordinary release clears autolock state before returning the device to the pool", async () => {
        const sessionId = await devicePool.autolockDevice("emulator-old", "android", "mcp-1");
        const releaseStates: Array<{ lock: string | undefined; owner: string | null | undefined }> =
          [];
        sessionManager.onSessionRelease(() => {
          releaseStates.push({
            lock: devicePool.getDevice("emulator-old")?.autolockSessionId,
            owner: devicePool.getDevice("emulator-old")?.sessionId,
          });
        });

        await sessionManager.releaseSession(sessionId!);

        expect(releaseStates).toEqual([{ lock: undefined, owner: sessionId }]);
        expect(devicePool.captureAutolockSessionForMcpSession("mcp-1")).toBeUndefined();
        await devicePool.releaseDevice("emulator-old", sessionId!);
        expect(devicePool.getDevice("emulator-old")).toMatchObject({
          sessionId: null,
          status: "idle",
          autolockSessionId: undefined,
        });
        await devicePool.bindOrReuseDeviceSession("next-owner", "emulator-old", "android");
        expect(() => devicePool.assertAutolockAccess("emulator-old", "next-owner")).not.toThrow();
      });
    });

    test("binds a rediscovered same-serial emulator without requiring a retry", async () => {
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const reconnected = { ...firstConnection };
      await initializeLiveDevices([firstConnection]);
      const incarnation = devicePool.getDevice(firstConnection.deviceId)?.incarnation;
      fakeDeviceManager.bootedDevices = [reconnected];

      await expect(
        devicePool.bindOrReuseDeviceSession("session-1", reconnected.deviceId, "android"),
      ).resolves.toBe("session-1");

      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        incarnation,
        sessionId: "session-1",
        status: "busy",
      });
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe(reconnected.deviceId);
    });

    test("autolocks a rediscovered same-serial emulator without reacquiring the assignment mutex", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const reconnected = { ...firstConnection };
      try {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        await initializeLiveDevices([firstConnection]);
        fakeDeviceManager.bootedDevices = [reconnected];

        await expect(
          devicePool.autolockDevice(reconnected.deviceId, "android", "mcp-session-1"),
        ).resolves.toBeDefined();

        expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({ status: "busy" });
      } finally {
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }
    });

    test("assigns the current replacement after liveness discovery supersedes a captured device", async () => {
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const reconnected = { ...firstConnection };
      const manager = new DeferredReconnectionDiscoveryFakeDeviceManager(
        [reconnected],
        [reconnected],
      );
      devicePool = makePool({ deviceManager: manager });
      await devicePool.addDevice(firstConnection);

      const assignment = devicePool.assignDeviceToSession("session-1", "android");
      await manager.waitForDiscoveryStart();
      await devicePool.removeDevice(firstConnection.deviceId);
      await devicePool.addDevice(reconnected);

      manager.releaseDiscovery();

      await expect(assignment).resolves.toBe(reconnected.deviceId);
      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        sessionId: "session-1",
        status: "busy",
      });
    });

    test("rejects a changed runtime identity inside the assignment mutex", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Old Pixel"),
      ]);
      fakeDeviceManager.bootedDevices = [
        createBootedDevice("emulator-5554", "android", "New Pixel"),
      ];

      await expect(
        devicePool.bindOrReuseDeviceSession(
          "session-1",
          "emulator-5554",
          "android",
          undefined,
          undefined,
          createBootedDevice("emulator-5554", "android", "New Pixel"),
        ),
      ).rejects.toThrow(/Device pool identity mismatch.*Old Pixel/);

      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("should reuse a live session when the device is already bound", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await devicePool.bindOrReuseDeviceSession("session-1", "sim-1", "ios");

      const sessionId = await devicePool.bindOrReuseDeviceSession("session-2", "sim-1", "ios");

      expect(sessionId).toBe("session-1");
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-2")).toBeNull();
      // The creator kind is recorded on the session and persisted with it (#11071).
      expect(sessionManager.getSession("session-1")?.persistenceMetadata?.source).toBe(
        ANONYMOUS_ACQUISITION_SESSION_SOURCE,
      );
    });

    const bindAs = (
      sessionId: string,
      mcpSessionId?: string,
      allowSessionRebind = false,
      oneShotCli = false,
    ) =>
      devicePool.bindOrReuseDeviceSession(
        sessionId,
        "sim-1",
        "ios",
        undefined,
        undefined,
        undefined,
        allowSessionRebind,
        undefined,
        undefined,
        undefined,
        mcpSessionId,
        oneShotCli,
      );
    const refusalOf = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) => error,
      );

    test("should reuse a live session when its acquiring connection binds the device again", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "connection-1");

      const sessionId = await bindAs("session-2", "connection-1");

      expect(sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-2")).toBeNull();
    });

    // #11071: without an MCP identity the pool handed an anonymous caller the holder's UUID.
    test("refuses an anonymous bind of a device a connection acquired, typed", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "connection-1");

      const refusal = await refusalOf(bindAs("session-2"));

      expect(refusal).toMatchObject({
        code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
        message: "Device 'sim-1' is already assigned to session session-1",
      });
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-2")).toBeNull();
    });

    test("refuses an anonymous bind of a device a caller-chosen session holds, typed", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      // setActiveDevice binds the caller's own session (desktop, explicit UUID): not anonymous.
      await bindAs("desktop-session", undefined, true);

      const refusal = await refusalOf(bindAs("session-2"));

      expect(refusal).toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("desktop-session");
    });

    // #11071: a connection that never acquired the device got an untyped refusal.
    test("refuses another connection's bind of a held device, typed", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "connection-1");

      const refusal = await refusalOf(bindAs("session-2", "connection-2"));

      expect(refusal).toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
      expect((refusal as Error).message).toContain("already assigned to another session");
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
    });

    // #11096: every socket call carries a per-connection MCP id, so one-shot `--cli` connections
    // are anonymous by their explicit marker, not by a missing id.
    test("reuses a one-shot CLI connection's session for the next one-shot CLI connection", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "cli-connection-1", false, true);

      const sessionId = await bindAs("session-2", "cli-connection-2", false, true);

      expect(sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-2")).toBeNull();
      expect(sessionManager.getSession("session-1")?.persistenceMetadata?.source).toBe(
        ANONYMOUS_ACQUISITION_SESSION_SOURCE,
      );
    });

    // #11138: an acquisition that resolved a source image fell into the freshly-started guard.
    test("reuses an anonymous session for a one-shot CLI bind that resolved a source image", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "cli-connection-1", false, true);

      const sessionId = await devicePool.bindOrReuseDeviceSession(
        "session-2",
        "sim-1",
        "ios",
        { name: "iPhone 15", platform: "ios", deviceId: "sim-1", isRunning: true, source: "local" },
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        "cli-connection-2",
        true,
      );

      expect(sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-2")).toBeNull();
    });

    // #11153: one-shot A cold-boots the emulator while one-shot B's anonymous bind of the same
    // serial lands first; A must be refused rather than silently sharing B's session.
    test("refuses a one-shot CLI bind that cold-booted the device when another anonymous session took it", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "cli-connection-1", false, true);

      const refusal = await refusalOf(
        devicePool.bindOrReuseDeviceSession(
          "session-2",
          "sim-1",
          "ios",
          {
            name: "iPhone 15",
            platform: "ios",
            deviceId: "sim-1",
            isRunning: true,
            source: "local",
          },
          new FakeChildProcess() as unknown as ChildProcess,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          "cli-connection-2",
          true,
        ),
      );

      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain("Freshly started device 'sim-1'");
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
    });

    test("refuses a one-shot CLI bind of a device an MCP connection acquired, typed", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "connection-1");

      const refusal = await refusalOf(bindAs("session-2", "cli-connection-2", false, true));

      expect(refusal).toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-1")?.persistenceMetadata?.source).toBeUndefined();
    });

    test("refuses an MCP connection's bind of a device a one-shot CLI connection acquired", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "cli-connection-1", false, true);

      const refusal = await refusalOf(bindAs("session-2", "connection-2"));

      expect(refusal).toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
    });

    test("rejects binding a stale idle iOS simulator that is no longer booted", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-stale", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [];

      await expect(
        devicePool.bindOrReuseDeviceSession("session-stale", "sim-stale", "ios"),
      ).rejects.toThrow(/not available/);
      expect(devicePool.getDevice("sim-stale")?.status).toBe("idle");
      expect(sessionManager.getSession("session-stale")).toBeNull();
    });

    test("retains a stale pooled Android emulator when direct binding rejects", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
      ]);
      fakeDeviceManager.bootedDevices = [];

      await expect(
        devicePool.bindOrReuseDeviceSession("session-1", "emulator-5554", "android"),
      ).rejects.toThrow(/not available|shut down|disconnected/);

      expect(devicePool.getDevice("emulator-5554")?.status).toBe("idle");
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("preserves an active session when a pre-lock absent snapshot rejects reuse", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554", "android", "Pixel 8")]);
      await devicePool.bindOrReuseDeviceSession("session-1", "emulator-5554", "android");
      fakeDeviceManager.bootedDevices = [];

      await expect(
        devicePool.bindOrReuseDeviceSession("session-2", "emulator-5554", "android"),
      ).rejects.toThrow(/not available|shut down|disconnected/);

      expect(devicePool.getDevice("emulator-5554")?.status).toBe("busy");
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-5554");
      expect(sessionManager.getSession("session-2")).toBeNull();
    });

    test("retains a stale pooled Android emulator when autolock rejects", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      try {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        await devicePool.initializeWithDevices([
          createBootedDevice("emulator-5554", "android", "Pixel 8"),
        ]);
        fakeDeviceManager.bootedDevices = [];

        await expect(
          devicePool.autolockDevice("emulator-5554", "android", "mcp-session-1"),
        ).rejects.toThrow(/not available|shut down|disconnected/);

        expect(devicePool.getDevice("emulator-5554")?.status).toBe("idle");
        expect(
          devicePool.resolveAutolockSessionForMcpSession("mcp-session-1", "android"),
        ).toBeUndefined();
      } finally {
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }
    });
  });
});
