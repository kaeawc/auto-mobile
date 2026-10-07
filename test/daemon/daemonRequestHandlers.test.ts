import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { logger } from "../../src/utils/logger";
import {
  DevicePoolStats,
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import {
  SessionManager,
  type LivenessClaimOutcome,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
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
import type { DeviceLeaseActivitySources } from "../../src/daemon/deviceLeaseActivity";

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
    const claim = Promise.withResolvers<LivenessClaimOutcome>();
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
      claim.resolve("claimed");
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
      // Additive liveness state (#10051); a fresh session is live with its full lease.
      liveness: { state: "live", remainingMs: session.heartbeatTimeoutMs },
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
      await sessionManager.createSession(sessionId, "emulator-5554", "android", 60_000);

      await handleDaemonRequest(
        buildRequest("daemon/heartbeat", {
          sessionId,
          livenessPolicy: firstPolicy,
          livenessOwnerToken: first,
          claimLivenessOwnership: true,
        }),
        state,
      );
      // The first owner's lease and its suspect grace window must lapse or the
      // daemon rejects the second claim (#10050, #10051).
      fakeTimer.advanceTime(10_001 + SUSPECT_GRACE_MS);
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

      // Replaying a displaced claim is a structured failure that records nothing (#10050).
      expect(
        await handleDaemonRequest(
          buildRequest("daemon/heartbeat", {
            sessionId,
            livenessOwnerToken: first,
            claimLivenessOwnership: true,
            livenessPolicy: firstPolicy,
          }),
          state,
        ),
      ).toEqual({
        success: false,
        code: "liveness_owner_superseded",
        error: expect.stringContaining("no longer owns"),
      });
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

  describe("liveness ownership contention (#10050)", () => {
    const sessionId = "contended-session";
    const claimRequest = (token: string, livenessPolicy = "heartbeat") =>
      buildRequest("daemon/heartbeat", {
        sessionId,
        livenessPolicy,
        livenessOwnerToken: token,
        claimLivenessOwnership: true,
      });
    const tickRequest = (token: string) =>
      buildRequest("daemon/heartbeat", {
        sessionId,
        livenessPolicy: "heartbeat",
        livenessOwnerToken: token,
      });

    async function stateWithSession(): Promise<FakeDaemonState> {
      await sessionManager.createSession(sessionId, "emulator-5554", "android", 60_000);
      return new FakeDaemonState(
        sessionManager,
        new FakeDevicePool({ total: 1, idle: 0, assigned: 1, error: 0 }),
      );
    }

    function snapshotOf(name: string) {
      const session = sessionManager.getSession(name)!;
      return {
        livenessPolicy: session.livenessPolicy,
        livenessOwnerToken: session.livenessOwnerToken,
        lastUsedAt: session.lastUsedAt,
        lastHeartbeat: session.lastHeartbeat,
        expiresAt: session.expiresAt,
        heartbeatTimeoutMs: session.heartbeatTimeoutMs,
        sessionTimeoutMs: session.sessionTimeoutMs,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
      };
    }

    test.each([
      { owner: "proxy-a", challenger: "proxy-b" },
      { owner: "proxy-b", challenger: "proxy-a" },
    ])(
      "rejects $challenger while $owner's lease is live and leaves $owner's state unchanged",
      async ({ owner, challenger }) => {
        const state = await stateWithSession();
        expect((await handleDaemonRequest(claimRequest(owner), state)).success).toBe(true);
        fakeTimer.advanceTime(5_000);
        expect((await handleDaemonRequest(tickRequest(owner), state)).success).toBe(true);
        const before = snapshotOf(sessionId);
        fakeTimer.advanceTime(4_000);

        // Even a claim that would widen the policy changes nothing.
        for (const policy of ["heartbeat", "cli"]) {
          expect(await handleDaemonRequest(claimRequest(challenger, policy), state)).toEqual({
            success: false,
            code: "liveness_owner_conflict",
            error: expect.stringContaining(sessionId),
          });
          expect(snapshotOf(sessionId)).toEqual(before);
        }

        // The rejected challenger holds no ownership: its ticks are superseded
        // no-ops, while the owner's tick still refreshes the lease.
        expect(await handleDaemonRequest(tickRequest(challenger), state)).toMatchObject({
          success: false,
          code: "liveness_owner_superseded",
        });
        expect(snapshotOf(sessionId)).toEqual(before);
        expect((await handleDaemonRequest(tickRequest(owner), state)).success).toBe(true);
        expect(snapshotOf(sessionId)).toMatchObject({
          livenessOwnerToken: owner,
          lastHeartbeat: fakeTimer.now(),
        });
      },
    );

    test.each([
      { owner: "proxy-a", challenger: "proxy-b" },
      { owner: "proxy-b", challenger: "proxy-a" },
    ])(
      "accepts $challenger once $owner's lease has expired and never lets $owner reclaim",
      async ({ owner, challenger }) => {
        const state = await stateWithSession();
        await handleDaemonRequest(claimRequest(owner), state);
        const leaseMs = sessionManager.getSession(sessionId)!.heartbeatTimeoutMs;

        // The lease is inclusive of its last millisecond.
        fakeTimer.advanceTime(leaseMs);
        expect(await handleDaemonRequest(claimRequest(challenger), state)).toMatchObject({
          success: false,
          code: "liveness_owner_conflict",
        });
        // Past the lease the owner's session is suspect (#10051) and still held for it.
        fakeTimer.advanceTime(1);
        expect(await handleDaemonRequest(claimRequest(challenger), state)).toMatchObject({
          success: false,
          code: "liveness_owner_conflict",
        });
        fakeTimer.advanceTime(SUSPECT_GRACE_MS);
        expect((await handleDaemonRequest(claimRequest(challenger), state)).success).toBe(true);
        expect(snapshotOf(sessionId)).toMatchObject({
          livenessOwnerToken: challenger,
          lastHeartbeat: fakeTimer.now(),
        });

        // The displaced owner's retried claim is a structured failure, not a
        // silent success, and records nothing, even after the new owner lapses.
        const afterTakeover = snapshotOf(sessionId);
        for (const elapsed of [0, leaseMs + 1]) {
          fakeTimer.advanceTime(elapsed);
          expect(await handleDaemonRequest(claimRequest(owner), state)).toEqual({
            success: false,
            code: "liveness_owner_superseded",
            error: expect.stringContaining(sessionId),
          });
          expect(snapshotOf(sessionId)).toEqual(afterTakeover);
        }
      },
    );

    test("lets the owner's stable token claim again while its lease is live", async () => {
      const state = await stateWithSession();
      await handleDaemonRequest(claimRequest("stable-token"), state);
      fakeTimer.advanceTime(3_000);

      expect((await handleDaemonRequest(claimRequest("stable-token"), state)).success).toBe(true);
      expect(snapshotOf(sessionId)).toMatchObject({
        livenessOwnerToken: "stable-token",
        livenessPolicy: "heartbeat",
        lastHeartbeat: fakeTimer.now(),
      });
    });

    test("does not hold a one-shot CLI owner's lease against the next invocation", async () => {
      const state = await stateWithSession();
      await handleDaemonRequest(claimRequest("cli-1", "cli"), state);
      fakeTimer.advanceTime(1_000);

      expect((await handleDaemonRequest(claimRequest("cli-2", "cli"), state)).success).toBe(true);
      expect(snapshotOf(sessionId)).toMatchObject({ livenessOwnerToken: "cli-2" });
    });
  });

  describe("CLI heartbeat keeper on a proxy-owned session (#10054)", () => {
    const sessionId = "keeper-vs-proxy";
    const keeperRequest = (token: string | undefined, claim: boolean) =>
      buildRequest("daemon/heartbeat", {
        sessionId,
        livenessPolicy: "cli",
        livenessOwnerKind: "cli-keeper",
        idleTimeoutMs: 600_000,
        ...(token ? { livenessOwnerToken: token } : {}),
        ...(claim ? { claimLivenessOwnership: true } : {}),
      });
    const proxyClaim = (token: string, livenessPolicy: string) =>
      buildRequest("daemon/heartbeat", {
        sessionId,
        livenessPolicy,
        livenessOwnerToken: token,
        claimLivenessOwnership: true,
      });

    async function stateWithSession(): Promise<FakeDaemonState> {
      await sessionManager.createSession(sessionId, "emulator-5554", "android", 60_000);
      return new FakeDaemonState(
        sessionManager,
        new FakeDevicePool({ total: 1, idle: 0, assigned: 1, error: 0 }),
      );
    }

    function snapshotOf() {
      const session = sessionManager.getSession(sessionId)!;
      return {
        livenessPolicy: session.livenessPolicy,
        livenessOwnerToken: session.livenessOwnerToken,
        lastUsedAt: session.lastUsedAt,
        lastHeartbeat: session.lastHeartbeat,
        expiresAt: session.expiresAt,
        heartbeatTimeoutMs: session.heartbeatTimeoutMs,
        sessionTimeoutMs: session.sessionTimeoutMs,
        hasReceivedHeartbeat: session.hasReceivedHeartbeat,
      };
    }

    test.each([
      { name: "a foreign-token claim", token: "keeper", claim: true },
      { name: "a claim with the proxy's own token", token: "proxy-a", claim: true },
      { name: "a foreign-token tick", token: "keeper", claim: false },
      { name: "a tick with the proxy's own token", token: "proxy-a", claim: false },
      { name: "a tokenless heartbeat", token: undefined, claim: false },
    ])(
      "refuses $name with liveness_owner_is_proxy and changes nothing",
      async ({ token, claim }) => {
        const state = await stateWithSession();
        expect((await handleDaemonRequest(proxyClaim("proxy-a", "heartbeat"), state)).success).toBe(
          true,
        );
        fakeTimer.advanceTime(3_000);
        const before = snapshotOf();
        fakeTimer.advanceTime(2_000);

        expect(await handleDaemonRequest(keeperRequest(token, claim), state)).toEqual({
          success: false,
          code: "liveness_owner_is_proxy",
          error: expect.stringContaining(`owned by an MCP proxy`),
        });
        expect(snapshotOf()).toEqual(before);
      },
    );

    test("names the session, the proxy ownership and session-info in the error", async () => {
      const state = await stateWithSession();
      await handleDaemonRequest(proxyClaim("proxy-a", "heartbeat"), state);

      const refusal = await handleDaemonRequest(keeperRequest("keeper", true), state);

      expect(refusal.error).toContain(sessionId);
      expect(refusal.error).toContain("only liveness owner");
      expect(refusal.error).toContain(`--daemon session-info ${sessionId}`);
    });

    test("refuses even when the proxy's lease has expired, where the generic conflict would not fire", async () => {
      const state = await stateWithSession();
      await handleDaemonRequest(proxyClaim("proxy-a", "heartbeat"), state);
      fakeTimer.advanceTime(sessionManager.getSession(sessionId)!.heartbeatTimeoutMs + 1);
      const before = snapshotOf();

      expect(await handleDaemonRequest(keeperRequest("keeper", true), state)).toMatchObject({
        success: false,
        code: "liveness_owner_is_proxy",
      });
      expect(snapshotOf()).toEqual(before);
    });

    test("keeps a one-shot CLI session on the keeper's claim and ticks as before", async () => {
      const state = await stateWithSession();

      expect(await handleDaemonRequest(keeperRequest("keeper", true), state)).toMatchObject({
        success: true,
        result: { sessionId, livenessPolicy: "cli-idle" },
      });
      expect(snapshotOf()).toMatchObject({
        livenessPolicy: "cli-idle",
        livenessOwnerToken: "keeper",
      });

      fakeTimer.advanceTime(30_000);
      expect(await handleDaemonRequest(keeperRequest("keeper", false), state)).toMatchObject({
        success: true,
      });
      expect(snapshotOf()).toMatchObject({ lastHeartbeat: fakeTimer.now() });

      // A later one-shot keeper with a new token claims the cli-idle session.
      expect(await handleDaemonRequest(keeperRequest("keeper-2", true), state)).toMatchObject({
        success: true,
      });
      expect(snapshotOf()).toMatchObject({ livenessOwnerToken: "keeper-2" });
    });

    test("does not refuse a one-shot --cli proxy's own declaration without the keeper marker", async () => {
      const state = await stateWithSession();
      await handleDaemonRequest(proxyClaim("cli-proxy", "heartbeat"), state);

      expect(await handleDaemonRequest(proxyClaim("cli-proxy", "cli"), state)).toMatchObject({
        success: true,
        result: { livenessPolicy: "cli-idle" },
      });
      expect(snapshotOf()).toMatchObject({
        livenessPolicy: "cli-idle",
        livenessOwnerToken: "cli-proxy",
      });
    });
  });

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
      const tickMs = Math.floor(timeoutMs / 5);
      // Lease plus the suspect grace window (#10051) must pass before the reap.
      const ticksUntilReap = Math.floor((timeoutMs + SUSPECT_GRACE_MS) / tickMs) + 1;
      for (let tick = 0; tick < ticksUntilReap; tick++) {
        fakeTimer.advanceTime(tickMs);
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

  test("reports a device's lease status for a would-be lease taker (#10497)", async () => {
    const state = new FakeDaemonState(
      sessionManager,
      new FakeDevicePool({ total: 1, idle: 0, assigned: 1, error: 0 }),
    );
    spyOn(sessionManager, "getSessionForDevice").mockImplementation((deviceId) =>
      deviceId === "emulator-5600" ? "session-abc" : null,
    );

    const response = await handleDaemonRequest(
      buildRequest("daemon/deviceLeaseStatus", { deviceId: "emulator-5600" }),
      state,
    );

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({
      pid: process.pid,
      deviceId: "emulator-5600",
      sessionId: "session-abc",
      activeExecutions: 0,
      streaming: false,
    });
    expect(
      (await handleDaemonRequest(buildRequest("daemon/deviceLeaseStatus", {}), state)).success,
    ).toBe(false);
  });

  test("reports CtrlProxy requests and idleness that no tool call is bound to (#10497 review)", async () => {
    class ActivityState extends FakeDaemonState {
      getDeviceLeaseActivitySources(): DeviceLeaseActivitySources {
        return {
          sessionForDevice: () => null,
          activeExecutionCount: () => 0,
          toolIdleForMs: () => null,
          hasStreamSubscriber: () => false,
          clientActivity: () => ({ inFlightRequests: 2, idleForMs: 1_500 }),
        };
      }
    }
    const state = new ActivityState(
      sessionManager,
      new FakeDevicePool({ total: 1, idle: 1, assigned: 0, error: 0 }),
    );

    const response = await handleDaemonRequest(
      buildRequest("daemon/deviceLeaseStatus", { deviceId: "emulator-5600" }),
      state,
    );

    expect(response.result).toEqual({
      pid: process.pid,
      deviceId: "emulator-5600",
      sessionId: null,
      activeExecutions: 0,
      inFlightRequests: 2,
      streaming: false,
      idleForMs: 1_500,
    });
  });

  test("returns an empty device-session list when no devices are connected", async () => {
    const devicePool = new FakeDevicePool({ total: 0, idle: 0, assigned: 0, error: 0 });
    const state = new FakeDaemonState(sessionManager, devicePool);

    const response = await handleDaemonRequest(buildRequest("daemon/listDeviceSessions"), state);

    expect(response.success).toBe(true);
    expect(response.result).toEqual({ deviceSessions: [], totalDeviceSessions: 0 });
  });
});
