import { drainUntil } from "../helpers/fakeTimerStepping";

import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import {
  type DeviceSessionPersistence,
  type DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSession } from "../../src/db/types";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";

import { persistenceServing, sessionRow } from "../helpers/sessionManagerSuite";
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
  const { initializeLiveDevices, makePool } = devicePoolSuiteActions(() => ({
    devicePool,
    sessionManager,
    fakeTimer,
    fakeAppsRepo,
    fakeDeviceManager,
  }));

  /** A restarted-daemon row: the shared expired session, stamped as this suite's recovery fixture. */
  const restartedRow = (overrides: Partial<DeviceSession> = {}): DeviceSession =>
    sessionRow({
      source: "session-manager",
      created_at: "2026-09-14T00:00:00.000Z",
      updated_at: "2026-09-14T00:00:00.000Z",
      ...overrides,
    });

  /** Swap in a manager over `persistence` plus a fresh pool, as a restarted daemon would have. */
  const restartOn = (persistence: DeviceSessionPersistence): void => {
    sessionManager.stopCleanupTimer();
    sessionManager = new SessionManager(fakeTimer, persistence);
    devicePool = makePool();
  };

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
        const persisted = restartedRow({
          stable_device_id: "Original_AVD",
          session_timeout_ms: 60_000,
          heartbeat_timeout_ms: 12_000,
          heartbeat_timeout_source: "custom",
          liveness_policy: "heartbeat",
        });
        const persistedUpdates: DeviceSessionRecord[] = [];
        const persistence = persistenceServing(persisted, {
          async upsertActiveSession(record) {
            persistedUpdates.push(record);
          },
        });
        restartOn(persistence);
        const devices = [
          createBootedDevice("emulator-5554", "android", "Unrelated_AVD"),
          createBootedDevice("emulator-5556", "android", "Original_AVD"),
        ];
        await initializeLiveDevices(reverse ? devices.toReversed() : devices);

        const recovered = await sessionManager.getOrCreateSession(
          "restarted-session",
          devicePool,
          "android",
          { requireIssuedSession: true },
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
      const persisted = restartedRow({
        session_uuid: "restarted-cli-session",
        stable_device_id: "Original_AVD",
        source: "autolock",
        autolock_enabled: 1,
        mcp_session_id: "old-mcp-session",
        expires_at_ms: 60_020,
        session_timeout_ms: 60_000,
        heartbeat_timeout_ms: 60_000,
        heartbeat_timeout_source: "custom",
        has_received_heartbeat: 0,
        liveness_policy: "cli-idle",
        pre_cli_heartbeat_timeout_ms: 12_000,
        pre_cli_heartbeat_timeout_source: "custom",
        pre_cli_session_timeout_ms: 60_000,
      });
      const persistence = persistenceServing(persisted);
      restartOn(persistence);
      await initializeLiveDevices([createBootedDevice("emulator-5556", "android", "Original_AVD")]);

      const recovered = await sessionManager.getOrCreateSession(
        persisted.session_uuid,
        devicePool,
        "android",
        { requireIssuedSession: true },
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
      const persisted = restartedRow({
        stable_device_id: "Original_AVD",
      });
      const releaseReasons: string[] = [];
      const persistence = persistenceServing(persisted, {
        async upsertActiveSession() {
          throw new Error("same-serial replacement must not create a recovered session");
        },
        async markReleased(_sessionUuid, _status, _releasedAtMs, { reason: releaseReason }) {
          releaseReasons.push(releaseReason);
          persisted.release_reason = releaseReason;
        },
      });
      restartOn(persistence);
      await initializeLiveDevices([
        createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)"),
      ]);

      const recovery = sessionManager.getOrCreateSession(
        persisted.session_uuid,
        devicePool,
        "android",
        { requireIssuedSession: true },
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
        const persisted = restartedRow({
          session_uuid: `restarted-${platform}-session`,
          device_id: deviceId,
          stable_device_id: stableDeviceId,
          platform,
        });
        const releaseReasons: string[] = [];
        const persistence = persistenceServing(persisted, {
          async upsertActiveSession() {
            throw new Error("an absent recovery target must not create a recovered session");
          },
          async markReleased(_sessionUuid, _status, _releasedAtMs, { reason: releaseReason }) {
            releaseReasons.push(releaseReason);
            persisted.release_reason = releaseReason;
          },
        });
        restartOn(persistence);
        fakeDeviceManager.bootedDevices = [];
        fakeDeviceManager.failedSources.add(failedSource);

        const recovery = sessionManager.getOrCreateSession(
          persisted.session_uuid,
          devicePool,
          platform,
          { requireIssuedSession: true },
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
      const persisted = restartedRow({
        stable_device_id: "Original_AVD",
      });
      const persistence = persistenceServing(persisted);
      restartOn(persistence);
      await initializeLiveDevices([createBootedDevice("Original_AVD", "android", "Pixel 9")]);

      await expect(
        sessionManager.getOrCreateSession("restarted-session", devicePool, "android", {
          requireIssuedSession: true,
        }),
      ).rejects.toThrow(/cannot safely recover/i);
      expect(devicePool.getDevice("Original_AVD")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    });

    test("does not recover an Android emulator session onto an unresolved placeholder", async () => {
      const persisted = restartedRow({
        stable_device_id: "Unknown (emulator-5554)",
      });
      const persistence = persistenceServing(persisted);
      restartOn(persistence);
      await initializeLiveDevices([
        createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)"),
      ]);

      await expect(
        sessionManager.getOrCreateSession("restarted-session", devicePool, "android", {
          requireIssuedSession: true,
        }),
      ).rejects.toThrow(/cannot safely recover/i);
      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    });

    test("refuses a restarted iOS session when only a different UUID is available", async () => {
      const persisted = restartedRow({
        device_id: "old-simulator-uuid",
        stable_device_id: "original-simulator-uuid",
        platform: "ios",
      });
      const persistence = persistenceServing(persisted);
      restartOn(persistence);
      await initializeLiveDevices([
        createBootedDevice("replacement-simulator-uuid", "ios", "iPhone 16"),
      ]);

      await expect(
        sessionManager.getOrCreateSession("restarted-session", devicePool, "ios", {
          requireIssuedSession: true,
        }),
      ).rejects.toThrow(/cannot safely recover/i);
      expect(devicePool.getDevice("replacement-simulator-uuid")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    });
  });
});
