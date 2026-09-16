import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePoolStats, handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { SessionManager, type SessionDeviceAssigner } from "../../src/daemon/sessionManager";
import { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import type { DeviceSession } from "../../src/db/types";
import type {
  DeviceRecoveryEligibility,
  DeviceRecoveryPolicy,
  PooledDevice,
} from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { CLI_SESSION_LIVENESS_POLICY } from "../../src/daemon/constants";

class FakeDevicePool {
  stats: DevicePoolStats;
  refreshedCount = 0;
  releasedDevices: Array<{ deviceId: string; expectedSessionId: string }> = [];
  addedDevices: number;
  recoveryPolicy: DeviceRecoveryPolicy = { onLoss: false, maxAttempts: 2 };
  devices: PooledDevice[] = [];

  constructor(stats: DevicePoolStats, addedDevices: number = 0) {
    this.stats = stats;
    this.addedDevices = addedDevices;
  }

  async refreshDevices(): Promise<number> {
    this.refreshedCount += 1;
    return this.addedDevices;
  }

  getStats(): DevicePoolStats {
    return this.stats;
  }

  async releaseDevice(deviceId: string, expectedSessionId: string): Promise<void> {
    this.releasedDevices.push({ deviceId, expectedSessionId });
  }

  getRecoveryPolicy(): DeviceRecoveryPolicy {
    return this.recoveryPolicy;
  }

  getAllDevices(): PooledDevice[] {
    return this.devices;
  }

  getRecoveryEligibility(_deviceId: string): DeviceRecoveryEligibility {
    return { eligible: false, reason: "disabled" };
  }
}

class FakeDaemonState {
  private sessionManager: SessionManager | null;
  private devicePool: FakeDevicePool | null;
  private deviceSessionRegistry: DeviceSessionRegistry;

  constructor(
    sessionManager: SessionManager | null,
    devicePool: FakeDevicePool | null,
    deviceSessionRegistry: DeviceSessionRegistry = new DeviceSessionRegistry(),
  ) {
    this.sessionManager = sessionManager;
    this.devicePool = devicePool;
    this.deviceSessionRegistry = deviceSessionRegistry;
  }

  isInitialized(): boolean {
    return this.sessionManager !== null && this.devicePool !== null;
  }

  getSessionManager(): SessionManager {
    if (!this.sessionManager) {
      throw new Error("DaemonState not initialized");
    }
    return this.sessionManager;
  }

  getDevicePool(): FakeDevicePool {
    if (!this.devicePool) {
      throw new Error("DaemonState not initialized");
    }
    return this.devicePool;
  }

  getDeviceSessionRegistry(): DeviceSessionRegistry {
    return this.deviceSessionRegistry;
  }
}

const buildRequest = (method: string, params: Record<string, unknown> = {}): DaemonRequest => ({
  id: "request-1",
  type: "daemon_request",
  method,
  params,
});

describe("handleDaemonRequest", () => {
  let fakeTimer: FakeTimer;
  let sessionManager: SessionManager;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  test("returns error when daemon is not initialized", async () => {
    const state = new FakeDaemonState(null, null);
    const response = await handleDaemonRequest(buildRequest("daemon/availableDevices"), state);

    expect(response.success).toBe(false);
    expect(response.error).toBe("Daemon not initialized");
  });

  test("reports additive socket capabilities before daemon initialization", async () => {
    const state = new FakeDaemonState(null, null);

    const response = await handleDaemonRequest(buildRequest("daemon/capabilities"), state);

    expect(response).toEqual({
      success: true,
      result: {
        capabilities: ["input/typeText.mode:append", "input/gestureStream"],
      },
    });
  });

  test("returns session info for active session", async () => {
    const devicePool = new FakeDevicePool({
      total: 1,
      idle: 1,
      assigned: 0,
      error: 0,
      avgAssignments: 0,
    });
    const state = new FakeDaemonState(sessionManager, devicePool);
    const sessionId = "session-1";
    const deviceId = "emulator-5554";
    const session = await sessionManager.createSession(sessionId, deviceId, "android");

    const response = await handleDaemonRequest(
      buildRequest("daemon/sessionInfo", { sessionId }),
      state,
    );

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      sessionId,
      assignedDevice: deviceId,
      platform: "android",
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      cacheSize: JSON.stringify(session.cacheData).length,
    });
  });

  test("records a heartbeat for an active session", async () => {
    const devicePool = new FakeDevicePool({
      total: 1,
      idle: 0,
      assigned: 1,
      error: 0,
    });
    const state = new FakeDaemonState(sessionManager, devicePool);
    const sessionId = "heartbeat-session";
    const session = await sessionManager.createSession(sessionId, "emulator-5554", "android");
    const initialHeartbeat = session.lastHeartbeat;
    fakeTimer.advanceTime(1_000);

    const response = await handleDaemonRequest(
      buildRequest("daemon/heartbeat", { sessionId }),
      state,
    );

    expect(response).toEqual({
      success: true,
      result: { sessionId },
    });
    expect(sessionManager.getSession(sessionId)?.lastHeartbeat).toBeGreaterThan(initialHeartbeat);
  });

  test("makes stale and tokenless heartbeats no-ops after owner B claims liveness", async () => {
    const devicePool = new FakeDevicePool({ total: 1, idle: 0, assigned: 1, error: 0 });
    const state = new FakeDaemonState(sessionManager, devicePool);
    const sessionId = "liveness-owner-session";
    await sessionManager.createSession(sessionId, "emulator-5554", "android", 10_000);

    await handleDaemonRequest(
      buildRequest("daemon/heartbeat", {
        sessionId,
        livenessPolicy: "heartbeat",
        livenessOwnerToken: "mcp-owner",
        claimLivenessOwnership: true,
      }),
      state,
    );
    fakeTimer.advanceTime(1_000);
    await handleDaemonRequest(
      buildRequest("daemon/heartbeat", {
        sessionId,
        livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
        livenessOwnerToken: "cli-owner",
        claimLivenessOwnership: true,
      }),
      state,
    );
    const cliOwned = sessionManager.getSession(sessionId)!;
    expect(cliOwned).toMatchObject({
      livenessPolicy: "cli-idle",
      livenessOwnerToken: "cli-owner",
      lastHeartbeat: fakeTimer.now(),
      lastUsedAt: fakeTimer.now(),
    });
    const beforeStaleKeeper = {
      livenessPolicy: cliOwned.livenessPolicy,
      livenessOwnerToken: cliOwned.livenessOwnerToken,
      lastUsedAt: cliOwned.lastUsedAt,
      lastHeartbeat: cliOwned.lastHeartbeat,
      expiresAt: cliOwned.expiresAt,
    };

    fakeTimer.advanceTime(1_000);
    await expect(
      handleDaemonRequest(
        buildRequest("daemon/heartbeat", {
          sessionId,
          livenessPolicy: "heartbeat",
          livenessOwnerToken: "mcp-owner",
        }),
        state,
      ),
    ).resolves.toEqual({ success: true, result: { sessionId } });
    expect(sessionManager.getSession(sessionId)).toMatchObject(beforeStaleKeeper);

    await handleDaemonRequest(
      buildRequest("daemon/heartbeat", { sessionId, livenessPolicy: "heartbeat" }),
      state,
    );
    expect(sessionManager.getSession(sessionId)).toMatchObject(beforeStaleKeeper);
  });

  test("lets a surviving token keeper refresh a recovered session with no daemon-local owner", async () => {
    const sessionId = "recovered-liveness-owner-session";
    const persisted: DeviceSession = {
      session_uuid: sessionId,
      device_id: "emulator-5560",
      stable_device_id: "Pixel_8_API_35",
      platform: "android",
      status: "active",
      source: null,
      autolock_enabled: 0,
      mcp_session_id: null,
      daemon_session_id: "old-daemon",
      created_at_ms: 1,
      last_used_at_ms: 20,
      expires_at_ms: 30,
      released_at_ms: 25,
      release_reason: "daemon-restart",
      session_timeout_ms: 10_000,
      heartbeat_timeout_ms: 5_000,
      has_received_heartbeat: 1,
      created_at: "2026-09-14T00:00:00.000Z",
      updated_at: "2026-09-14T00:00:00.000Z",
    };
    const persistence: DeviceSessionPersistence = {
      async getSession() {
        return persisted;
      },
      async upsertActiveSession() {},
      async recordActivity() {},
      async markReleased() {},
    };
    const restartedManager = new SessionManager(fakeTimer, persistence);
    const recoverer: SessionDeviceAssigner = {
      async assignDeviceToSession(recoveredSessionId, _platform, target): Promise<string> {
        await restartedManager.createSession(
          recoveredSessionId,
          "emulator-5560",
          "android",
          undefined,
          undefined,
          target?.stableDeviceId,
        );
        return "emulator-5560";
      },
    };

    try {
      await restartedManager.getOrCreateSession(sessionId, recoverer, "android", undefined, true);
      const state = new FakeDaemonState(
        restartedManager,
        new FakeDevicePool({ total: 1, idle: 0, assigned: 1, error: 0 }),
      );
      const beforeHeartbeat = restartedManager.getSession(sessionId)!;
      expect(beforeHeartbeat.livenessOwnerToken).toBeUndefined();
      expect(beforeHeartbeat.hasReceivedHeartbeat).toBe(false);

      fakeTimer.advanceTime(1_000);
      await expect(
        handleDaemonRequest(
          buildRequest("daemon/heartbeat", {
            sessionId,
            livenessPolicy: "heartbeat",
            livenessOwnerToken: "surviving-proxy-token",
          }),
          state,
        ),
      ).resolves.toEqual({ success: true, result: { sessionId } });

      expect(restartedManager.getSession(sessionId)).toMatchObject({
        livenessOwnerToken: "surviving-proxy-token",
        hasReceivedHeartbeat: true,
        lastHeartbeat: fakeTimer.now(),
        lastUsedAt: fakeTimer.now(),
      });
    } finally {
      restartedManager.stopCleanupTimer();
    }
  });

  test("returns error when sessionId is missing", async () => {
    const devicePool = new FakeDevicePool({
      total: 0,
      idle: 0,
      assigned: 0,
      error: 0,
      avgAssignments: 0,
    });
    const state = new FakeDaemonState(sessionManager, devicePool);

    const response = await handleDaemonRequest(buildRequest("daemon/sessionInfo"), state);

    expect(response.success).toBe(false);
    expect(response.error).toBe("sessionId parameter required");
  });

  test("releases session and device", async () => {
    const devicePool = new FakeDevicePool({
      total: 1,
      idle: 0,
      assigned: 1,
      error: 0,
      avgAssignments: 0,
    });
    const state = new FakeDaemonState(sessionManager, devicePool);
    const sessionId = "session-2";
    const deviceId = "emulator-5556";
    await sessionManager.createSession(sessionId, deviceId, "android");

    const response = await handleDaemonRequest(
      buildRequest("daemon/releaseSession", { sessionId }),
      state,
    );

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      message: `Session ${sessionId} released`,
      device: deviceId,
      alreadyReleased: false,
    });
    expect(devicePool.releasedDevices).toEqual([{ deviceId, expectedSessionId: sessionId }]);
    expect(sessionManager.getSession(sessionId)).toBeNull();
  });

  test("refreshes device pool and returns stats", async () => {
    const devicePool = new FakeDevicePool(
      {
        total: 2,
        idle: 1,
        assigned: 1,
        error: 0,
        avgAssignments: 0,
      },
      1,
    );
    const state = new FakeDaemonState(sessionManager, devicePool);

    const response = await handleDaemonRequest(buildRequest("daemon/refreshDevices"), state);

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      addedDevices: 1,
      totalDevices: 2,
      availableDevices: 1,
      stats: devicePool.stats,
    });
    expect(devicePool.refreshedCount).toBe(1);
  });

  test("returns available device stats", async () => {
    const devicePool = new FakeDevicePool({
      total: 3,
      idle: 2,
      assigned: 1,
      error: 0,
      avgAssignments: 2,
    });
    const state = new FakeDaemonState(sessionManager, devicePool);

    const response = await handleDaemonRequest(buildRequest("daemon/availableDevices"), state);

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      availableDevices: 2,
      totalDevices: 3,
      assignedDevices: 1,
      errorDevices: 0,
      stats: devicePool.stats,
      recoveryPolicy: { onLoss: false, maxAttempts: 2 },
      devices: [],
    });
  });

  test("lists live device sessions with their epoch identity", async () => {
    const devicePool = new FakeDevicePool({ total: 2, idle: 0, assigned: 2, error: 0 });
    const registry = new DeviceSessionRegistry(
      fakeTimer,
      new FakeIdGenerator(["uuid-a", "uuid-b"]),
    );
    fakeTimer.setCurrentTime(5000);
    registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 1 });
    registry.onDeviceConnected({ deviceId: "00008030-001", platform: "ios", incarnation: 1 });
    const state = new FakeDaemonState(sessionManager, devicePool, registry);

    const response = await handleDaemonRequest(buildRequest("daemon/listDeviceSessions"), state);

    expect(response.success).toBe(true);
    expect(response.result?.totalDeviceSessions).toBe(2);
    expect(response.result?.deviceSessions).toEqual([
      {
        deviceSessionUuid: "uuid-a",
        deviceId: "emulator-5554",
        platform: "android",
        epochStartedAt: 5000,
      },
      {
        deviceSessionUuid: "uuid-b",
        deviceId: "00008030-001",
        platform: "ios",
        epochStartedAt: 5000,
      },
    ]);
  });

  test("returns an empty device-session list when no devices are connected", async () => {
    const devicePool = new FakeDevicePool({ total: 0, idle: 0, assigned: 0, error: 0 });
    const state = new FakeDaemonState(sessionManager, devicePool);

    const response = await handleDaemonRequest(buildRequest("daemon/listDeviceSessions"), state);

    expect(response.success).toBe(true);
    expect(response.result).toEqual({ deviceSessions: [], totalDeviceSessions: 0 });
  });
});
