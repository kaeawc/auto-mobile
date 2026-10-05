import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../src/utils/logger";
import {
  DevicePoolStats,
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager, type SessionDeviceAssigner } from "../../src/daemon/sessionManager";
import { DAEMON_SESSION_NOT_FOUND_CODE, DaemonRequest } from "../../src/daemon/types";
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
import { createRegistryDeviceSessionResolver } from "../../src/daemon/deviceSessionResolver";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { ExecutionTracker } from "../../src/server/executionTracker";

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

  isPooledIdentityUnresolved(deviceId: string): boolean {
    return this.devices.find((device) => device.id === deviceId)?.identityUnresolved === true;
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

  test.each(["tools/list", "daemon/unknown"])("rejects unsupported method %s", async (method) => {
    const state = new FakeDaemonState(
      sessionManager,
      new FakeDevicePool({ total: 0, idle: 0, assigned: 0, error: 0 }),
    );
    expect(await handleDaemonRequest(buildRequest(method), state)).toEqual({
      success: false,
      error: `Unsupported daemon method: ${method}`,
    });
  });

  test.each(["daemon/heartbeat", "daemon/releaseSession"])(
    "%s rejects absent parameters",
    async (method) => {
      const state = new FakeDaemonState(
        sessionManager,
        new FakeDevicePool({ total: 0, idle: 0, assigned: 0, error: 0 }),
      );
      expect(await handleDaemonRequest(buildRequest(method), state)).toEqual({
        success: false,
        error: "sessionId parameter required",
      });
    },
  );

  test("retains inventory response shapes when optional state methods are absent", async () => {
    const stats = { total: 0, idle: 0, assigned: 0, error: 0 };
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => ({
        hasSession: () => false,
        getSession: () => null,
        getDeviceLabels: () => undefined,
        releaseSession: async () => null,
      }),
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => stats,
        releaseDevice: async () => {},
      }),
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    };
    expect(await handleDaemonRequest(buildRequest("daemon/availableDevices"), state)).toEqual({
      success: true,
      result: {
        availableDevices: 0,
        totalDevices: 0,
        assignedDevices: 0,
        errorDevices: 0,
        stats,
      },
    });
    expect(await handleDaemonRequest(buildRequest("daemon/activeSessions"), state)).toEqual({
      success: true,
      result: { activeSessions: 0, activeExecutions: 0 },
    });
  });

  test("rejects a heartbeat when release completes while its ownership claim awaits", async () => {
    const sessionId = "claim-release-race";
    await sessionManager.createSession(sessionId, "device", "android");
    const state = new FakeDaemonState(
      sessionManager,
      new FakeDevicePool({ total: 1, idle: 0, assigned: 1, error: 0 }),
    );
    const claim = Promise.withResolvers<boolean>();
    const ownership = spyOn(sessionManager, "claimLivenessOwnership").mockImplementation(
      () => claim.promise,
    );
    const heartbeat = spyOn(sessionManager, "recordHeartbeat");
    try {
      const response = handleDaemonRequest(
        buildRequest("daemon/heartbeat", {
          sessionId,
          livenessOwnerToken: "owner",
          claimLivenessOwnership: true,
        }),
        state,
      );
      expect(ownership).toHaveBeenCalledTimes(1);
      await sessionManager.releaseSession(sessionId);
      claim.resolve(true);
      expect(await response).toEqual({
        success: false,
        error: `Session not found: ${sessionId}`,
        code: DAEMON_SESSION_NOT_FOUND_CODE,
      });
      expect(heartbeat).not.toHaveBeenCalled();
    } finally {
      ownership.mockRestore();
      heartbeat.mockRestore();
    }
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
        capabilities: [
          "input/typeText.mode:append",
          "input/gestureStream",
          "daemon/registerSession",
        ],
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

  test.each([
    { first: "keeper", second: "proxy", firstPolicy: "cli", secondPolicy: "heartbeat" },
    { first: "proxy", second: "keeper", firstPolicy: "heartbeat", secondPolicy: "cli" },
  ])(
    "reports $first superseded after $second claims without refreshing liveness",
    async ({ first, second, firstPolicy, secondPolicy }) => {
      const devicePool = new FakeDevicePool({ total: 1, idle: 0, assigned: 1, error: 0 });
      const state = new FakeDaemonState(sessionManager, devicePool);
      const sessionId = "liveness-owner-session";
      await sessionManager.createSession(sessionId, "emulator-5554", "android", 10_000);

      await handleDaemonRequest(
        buildRequest("daemon/heartbeat", {
          sessionId,
          livenessPolicy: firstPolicy,
          livenessOwnerToken: first,
          claimLivenessOwnership: true,
        }),
        state,
      );
      fakeTimer.advanceTime(1_000);
      const claim = await handleDaemonRequest(
        buildRequest("daemon/heartbeat", {
          sessionId,
          livenessPolicy: secondPolicy,
          livenessOwnerToken: second,
          claimLivenessOwnership: true,
        }),
        state,
      );
      expect(claim.success).toBe(true);
      const cliOwned = sessionManager.getSession(sessionId)!;
      expect(cliOwned).toMatchObject({
        livenessPolicy: secondPolicy === "cli" ? "cli-idle" : "heartbeat",
        livenessOwnerToken: second,
        lastHeartbeat: fakeTimer.now(),
        lastUsedAt: fakeTimer.now(),
      });
      const beforeStaleKeeper = {
        livenessPolicy: cliOwned.livenessPolicy,
        livenessOwnerToken: cliOwned.livenessOwnerToken,
        lastUsedAt: cliOwned.lastUsedAt,
        lastHeartbeat: cliOwned.lastHeartbeat,
        expiresAt: cliOwned.expiresAt,
        heartbeatTimeoutMs: cliOwned.heartbeatTimeoutMs,
        sessionTimeoutMs: cliOwned.sessionTimeoutMs,
      };

      fakeTimer.advanceTime(1_000);
      await expect(
        handleDaemonRequest(
          buildRequest("daemon/heartbeat", {
            sessionId,
            livenessPolicy: firstPolicy,
            livenessOwnerToken: first,
          }),
          state,
        ),
      ).resolves.toEqual({
        success: false,
        code: "liveness_owner_superseded",
        error: expect.stringContaining("no longer owns"),
      });
      expect(sessionManager.getSession(sessionId)).toMatchObject(beforeStaleKeeper);

      expect(
        await handleDaemonRequest(
          buildRequest("daemon/heartbeat", { sessionId, livenessPolicy: "heartbeat" }),
          state,
        ),
      ).toEqual({ success: true, result: { sessionId } });
      expect(sessionManager.getSession(sessionId)).toMatchObject(beforeStaleKeeper);

      // Replaying a displaced claim remains the existing successful no-op.
      expect(
        (
          await handleDaemonRequest(
            buildRequest("daemon/heartbeat", {
              sessionId,
              livenessOwnerToken: first,
              claimLivenessOwnership: true,
              livenessPolicy: firstPolicy,
            }),
            state,
          )
        ).success,
      ).toBe(true);
      expect(sessionManager.getSession(sessionId)).toMatchObject(beforeStaleKeeper);

      expect(
        await handleDaemonRequest(
          buildRequest("daemon/heartbeat", {
            sessionId,
            livenessOwnerToken: second,
            livenessPolicy: firstPolicy,
          }),
          state,
        ),
      ).toEqual({ success: true, result: { sessionId } });
      expect(sessionManager.getSession(sessionId)).toMatchObject({
        ...beforeStaleKeeper,
        lastUsedAt: fakeTimer.now(),
        lastHeartbeat: fakeTimer.now(),
        expiresAt: fakeTimer.now() + cliOwned.sessionTimeoutMs,
      });
    },
  );

  test("reports every displaced keeper tick while a stalled proxy times out", async () => {
    const sessionId = "stalled-proxy";
    const state = new FakeDaemonState(
      sessionManager,
      new FakeDevicePool({ total: 1, idle: 0, assigned: 1, error: 0 }),
    );
    const session = await sessionManager.createSession(
      sessionId,
      "emulator-5554",
      "android",
      60_000,
    );
    for (const [token, policy] of [
      ["keeper", "cli"],
      ["proxy", "heartbeat"],
    ]) {
      expect(
        (
          await handleDaemonRequest(
            buildRequest("daemon/heartbeat", {
              sessionId,
              livenessOwnerToken: token,
              livenessPolicy: policy,
              claimLivenessOwnership: true,
            }),
            state,
          )
        ).success,
      ).toBe(true);
    }
    const lastHeartbeat = session.lastHeartbeat;
    const timeoutMs = session.heartbeatTimeoutMs;
    const reaped: Array<{ sessionId: string; reason: string }> = [];
    const monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (id, reason) => {
        reaped.push({ sessionId: id, reason });
        await sessionManager.releaseSession(id, reason);
      },
      fakeTimer,
      { heartbeatTimeoutMs: timeoutMs },
    );
    try {
      for (let tick = 0; tick < 6; tick++) {
        fakeTimer.advanceTime(Math.floor(timeoutMs / 5));
        expect(
          await handleDaemonRequest(
            buildRequest("daemon/heartbeat", {
              sessionId,
              livenessOwnerToken: "keeper",
              livenessPolicy: "cli",
            }),
            state,
          ),
        ).toMatchObject({ success: false, code: "liveness_owner_superseded" });
        expect(session.lastHeartbeat).toBe(lastHeartbeat);
        await monitor.tick();
      }
      expect(reaped).toEqual([{ sessionId, reason: "heartbeat-timeout" }]);
      expect(sessionManager.getSession(sessionId)).toBeNull();
    } finally {
      await monitor.stop();
    }
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

  test.each(["daemon/sessionInfo", "daemon/heartbeat"])(
    "%s codes a missing session without changing its message",
    async (method) => {
      const state = new FakeDaemonState(
        sessionManager,
        new FakeDevicePool({
          total: 0,
          idle: 0,
          assigned: 0,
          error: 0,
          avgAssignments: 0,
        }),
      );
      await expect(
        handleDaemonRequest(buildRequest(method, { sessionId: "missing" }), state),
      ).resolves.toEqual({
        success: false,
        error: "Session not found: missing",
        code: DAEMON_SESSION_NOT_FOUND_CODE,
      });
    },
  );

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

  test.each([false, true])(
    "release aborts only its session before freeing the device (execution ends on abort=%s)",
    async (endOnAbort) => {
      const timer = new FakeTimer();
      const tracker = new ExecutionTracker(timer, new FakeIdGenerator());
      const sessionId = "session-release-active";
      const deviceId = "emulator-5556";
      await sessionManager.createSession(sessionId, deviceId, "android");
      const execution = tracker.startExecution("executePlan", undefined, sessionId);
      const other = tracker.startExecution("executePlan", undefined, "other-session");
      const order: string[] = [];
      execution.abortController.signal.addEventListener("abort", () => {
        order.push("abort");
        if (endOnAbort) {
          tracker.endExecution(execution.id);
        }
      });
      const pool = new FakeDevicePool({ total: 1, idle: 0, assigned: 1, error: 0 });
      const free = spyOn(pool, "releaseDevice").mockImplementation(async () => {
        expect(execution.abortController.signal.aborted).toBe(true);
        order.push("free");
      });
      try {
        expect(
          await handleDaemonRequest(
            buildRequest("daemon/releaseSession", { sessionId }),
            new FakeDaemonState(sessionManager, pool),
            tracker,
          ),
        ).toEqual({
          success: true,
          result: {
            message: `Session ${sessionId} released`,
            device: deviceId,
            alreadyReleased: false,
          },
        });
        expect(order).toEqual(["abort", "free"]);
        expect(free.mock.calls).toEqual([[deviceId, sessionId]]);
        expect(tracker.hasActiveSessionUuidExecutions(sessionId)).toBe(!endOnAbort);
        expect(other.abortController.signal.aborted).toBe(false);
        // Immediate release never installs a drain deadline, even if work ignores abort.
        expect(timer.getPendingTimeouts()).toEqual([]);
        expect(timer.getSleepHistory()).toEqual([]);
      } finally {
        tracker.endExecution(execution.id);
        tracker.endExecution(other.id);
        free.mockRestore();
      }
    },
  );

  test("unknown session release stays idempotent without cancelling or waiting", async () => {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    const cancel = spyOn(tracker, "cancelSessionUuidExecutions");
    const pool = new FakeDevicePool({ total: 0, idle: 0, assigned: 0, error: 0 });
    try {
      expect(
        await handleDaemonRequest(
          buildRequest("daemon/releaseSession", { sessionId: "missing" }),
          new FakeDaemonState(sessionManager, pool),
          tracker,
        ),
      ).toEqual({
        success: true,
        result: {
          message: "Session missing already released or never existed",
          alreadyReleased: true,
        },
      });
      expect(cancel).not.toHaveBeenCalled();
      expect(pool.releasedDevices).toEqual([]);
      expect(timer.getPendingTimeouts()).toEqual([]);
      expect(timer.getSleepHistory()).toEqual([]);
    } finally {
      cancel.mockRestore();
    }
  });

  test("releases session and device without a cancellation await when idle", async () => {
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

    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    const cancel = spyOn(tracker, "cancelSessionUuidExecutions");
    const release = spyOn(sessionManager, "releaseSession");
    const pending = handleDaemonRequest(
      buildRequest("daemon/releaseSession", { sessionId }),
      state,
      tracker,
    );
    // The manager is reached synchronously, as before: no idle cancellation await.
    expect(release).toHaveBeenCalledWith(sessionId);
    const response = await pending;
    expect(cancel).not.toHaveBeenCalled();
    expect(timer.getPendingTimeouts()).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
    cancel.mockRestore();
    release.mockRestore();

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      message: `Session ${sessionId} released`,
      device: deviceId,
      alreadyReleased: false,
    });
    expect(devicePool.releasedDevices).toEqual([{ deviceId, expectedSessionId: sessionId }]);
    expect(sessionManager.getSession(sessionId)).toBeNull();
  });

  test.each(["removed", "present", "pool-failure"])(
    "release rejection preserves the original error with session %s",
    async (scenario) => {
      const sessionId = "release-failure";
      const deviceId = "emulator-5556";
      await sessionManager.createSession(sessionId, deviceId, "android");
      const devicePool = new FakeDevicePool({ total: 1, idle: 0, assigned: 1, error: 0 });
      const originalRelease = sessionManager.releaseSession.bind(sessionManager);
      const failure = new Error("release persistence failed");
      const poolFailure = new Error("pool release failed");
      const release = spyOn(sessionManager, "releaseSession").mockImplementation(async (id) => {
        if (scenario !== "present") {
          await originalRelease(id);
        }
        throw failure;
      });
      const poolRelease = spyOn(devicePool, "releaseDevice");
      if (scenario === "pool-failure") {
        poolRelease.mockRejectedValue(poolFailure);
      }
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await expect(
          handleDaemonRequest(
            buildRequest("daemon/releaseSession", { sessionId }),
            new FakeDaemonState(sessionManager, devicePool),
          ),
        ).rejects.toBe(failure);
        if (scenario === "present") {
          expect(poolRelease).not.toHaveBeenCalled();
          expect(sessionManager.getSession(sessionId)).not.toBeNull();
        } else {
          expect(poolRelease.mock.calls).toEqual([[deviceId, sessionId]]);
          expect(sessionManager.getSession(sessionId)).toBeNull();
        }
        if (scenario === "pool-failure") {
          expect(warn).toHaveBeenCalledWith(expect.stringContaining(sessionId), poolFailure);
        }
      } finally {
        release.mockRestore();
        poolRelease.mockRestore();
        warn.mockRestore();
      }
    },
  );

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

  test("marks a listed device session whose pooled identity is quarantined", async () => {
    const deviceId = "emulator-5554";
    const devicePool = new FakeDevicePool({ total: 1, idle: 1, assigned: 0, error: 0 });
    devicePool.devices.push({
      id: deviceId,
      name: "Pixel_8_API_35",
      platform: "android",
      sessionId: null,
      status: "idle",
      lastUsedAt: 0,
      assignmentCount: 0,
      errorCount: 0,
      incarnation: 1,
    });
    const registry = new DeviceSessionRegistry(fakeTimer, new FakeIdGenerator(["uuid-a"]));
    registry.onDeviceConnected({ deviceId, platform: "android", incarnation: 1 });
    devicePool.devices[0]!.identityUnresolved = true;
    const resolver = createRegistryDeviceSessionResolver(registry, {
      isPooledIdentityUnresolved: (serial) => devicePool.isPooledIdentityUnresolved(serial),
      assertDeviceActionable: () => {},
    });
    expect(resolver.resolveDeviceId("uuid-a")).toBeNull();

    const state = new FakeDaemonState(sessionManager, devicePool, registry);
    const response = await handleDaemonRequest(buildRequest("daemon/listDeviceSessions"), state);

    expect(response.result?.deviceSessions).toEqual([
      {
        deviceSessionUuid: "uuid-a",
        deviceId,
        platform: "android",
        epochStartedAt: fakeTimer.now(),
        identityUnresolved: true,
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
