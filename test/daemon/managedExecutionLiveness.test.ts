import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  MANAGED_EXECUTION_LIVENESS_POLICY,
  clampManagedExecutionIdleTimeoutMs,
  holdsOwnerHeartbeatLease,
  resolveManagedExecutionIdleTimeoutMs,
} from "../../src/daemon/managedExecutionLiveness";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  NO_HEARTBEAT_RELEASE_BUDGET_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { SessionManager } from "../../src/daemon/sessionManager";
import { CLI_SESSION_LIVENESS_POLICY } from "../../src/daemon/constants";
import {
  MAX_MANAGED_SLOT_IDLE_TIMEOUT_MS,
  ManagedSlotConfigError,
} from "../../src/models/managedSlotConfig";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #11340: managed executions stay held while their owner lease is non-lapsed.
// The configured idle window stays stored; heartbeats and reads never move activity clocks.

const SESSION = "managed-execution-session";
const DEVICE = "emulator-5554";
const OWNER = "managed-proxy-token";
const MINUTE = 60_000;
/** Idle expiry is released by whichever sweep sees it first: a lookup or the periodic cleanup. */

describe("managed-execution idle window resolution", () => {
  test("defaults to the 2-minute idle window", () => {
    expect(resolveManagedExecutionIdleTimeoutMs()).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(DEFAULT_SESSION_IDLE_TIMEOUT_MS).toBe(2 * MINUTE);
  });

  test("accepts an override inside 2–60 minutes, bounds included", () => {
    expect(resolveManagedExecutionIdleTimeoutMs(2 * MINUTE)).toBe(2 * MINUTE);
    expect(resolveManagedExecutionIdleTimeoutMs(15 * MINUTE)).toBe(15 * MINUTE);
    expect(resolveManagedExecutionIdleTimeoutMs(60 * MINUTE)).toBe(60 * MINUTE);
    expect(MAX_MANAGED_SLOT_IDLE_TIMEOUT_MS).toBe(60 * MINUTE);
  });

  test("refuses an override outside the bounds instead of clamping it", () => {
    for (const invalid of [0, 2 * MINUTE - 1, 60 * MINUTE + 1, 1.5 * MINUTE + 0.5, Number.NaN]) {
      expect(() => resolveManagedExecutionIdleTimeoutMs(invalid)).toThrow(ManagedSlotConfigError);
    }
  });

  test("clamps a persisted window back inside the bounds on recovery", () => {
    expect(clampManagedExecutionIdleTimeoutMs(MINUTE)).toBe(2 * MINUTE);
    expect(clampManagedExecutionIdleTimeoutMs(90 * MINUTE)).toBe(60 * MINUTE);
    expect(clampManagedExecutionIdleTimeoutMs(30 * MINUTE)).toBe(30 * MINUTE);
    expect(clampManagedExecutionIdleTimeoutMs(Number.NaN)).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
  });

  test("managed-execution is judged on the owner lease like heartbeat, unlike cli-idle", () => {
    expect(holdsOwnerHeartbeatLease(MANAGED_EXECUTION_LIVENESS_POLICY)).toBe(true);
    expect(holdsOwnerHeartbeatLease("heartbeat")).toBe(true);
    expect(holdsOwnerHeartbeatLease("cli-idle")).toBe(false);
  });
});

describe("managed-execution session liveness", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let releases: { at: number; reason: string }[];

  const state = (): DaemonStateAccess => ({
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
    }),
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  });

  const heartbeat = (params: Record<string, unknown> = {}) =>
    handleDaemonRequest(
      {
        id: "hb",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: { sessionId: SESSION, livenessOwnerToken: OWNER, ...params },
      },
      state(),
    );

  /** The idle sweep (`cleanupExpiredSessions`) plus the heartbeat monitor's lease sweep. */
  const sweep = async (): Promise<void> => {
    manager.cleanupExpiredSessions();
    await monitor.tick();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeAll(async () => {
    // Warm first-use policy/heartbeat setup; each test still gets fresh fakes below.
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    manager = new SessionManager(timer, persistence);
    try {
      await manager.createSession(SESSION, DEVICE, "android");
      await heartbeat({ claimLivenessOwnership: true });
      await manager.adoptManagedExecutionLivenessPolicy(SESSION);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  beforeEach(async () => {
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    manager = new SessionManager(timer, persistence);
    releases = [];
    manager.setActiveSessionExecutionChecker(() => false);
    manager.onSessionRelease((_sessionId, _deviceId, reason) => {
      releases.push({ at: timer.now(), reason });
    });
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
    await manager.createSession(
      SESSION,
      DEVICE,
      "android",
      undefined,
      undefined,
      "Pixel_managed_execution",
    );
    expect(await heartbeat({ claimLivenessOwnership: true })).toMatchObject({ success: true });
  });

  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  test("adopts the policy with the default idle window and persists it", async () => {
    const session = await manager.adoptManagedExecutionLivenessPolicy(SESSION);

    expect(session.livenessPolicy).toBe(MANAGED_EXECUTION_LIVENESS_POLICY);
    expect(session.sessionTimeoutMs).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(session.heartbeatTimeoutMs).toBe(SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS);
    const row = await persistence.getSession!(SESSION);
    expect(row?.liveness_policy).toBe(MANAGED_EXECUTION_LIVENESS_POLICY);
    expect(row?.session_timeout_ms).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
  });

  test("default: a heartbeating managed execution is held after 30 minutes without use", async () => {
    await manager.adoptManagedExecutionLivenessPolicy(SESSION);
    const lastToolActivity = manager.getSession(SESSION)!.lastUsedAt;

    timer.setCurrentTime(lastToolActivity + 30 * MINUTE);
    await heartbeat();
    await sweep();
    expect(manager.getAllSessions().map((session) => session.sessionId)).toContain(SESSION);
    expect(manager.getSession(SESSION)?.lastUsedAt).toBe(lastToolActivity);
    expect(releases).toEqual([]);
    const ack = await heartbeat({ reportIdleRelease: true });
    expect(ack).toMatchObject({ success: true, result: { idleReleaseAt: null } });
    await manager.getOrCreateSession(SESSION, undefined, undefined, {
      executionId: "late-control",
      startTime: timer.now(),
    });
    expect(manager.hasSession(SESSION)).toBe(true);
  });

  test("override: the stored 10-minute window does not release a live owner", async () => {
    await manager.adoptManagedExecutionLivenessPolicy(SESSION, { idleTimeoutMs: 10 * MINUTE });
    const lastToolActivity = manager.getSession(SESSION)!.lastUsedAt;

    // Fast-forward through the quiet stretch with the lease kept live; the keeper's cadence is
    // exercised by the 2-minute test, and a per-beat loop over 10 minutes would blow the budget.
    timer.setCurrentTime(lastToolActivity + 10 * MINUTE);
    await heartbeat();
    await sweep();
    expect(manager.hasSession(SESSION)).toBe(true);

    timer.setCurrentTime(lastToolActivity + 10 * MINUTE + 1);
    await heartbeat();
    await sweep();
    expect(manager.hasSession(SESSION)).toBe(true);
    expect(releases).toEqual([]);
  });

  test("the idle window restarts from the end of a tool call, not from a heartbeat", async () => {
    await manager.adoptManagedExecutionLivenessPolicy(SESSION, { idleTimeoutMs: 5 * MINUTE });
    timer.advanceTime(4 * MINUTE);
    await heartbeat();
    await manager.getOrCreateSession(SESSION);
    manager.recordToolCallEnded(SESSION);
    const endedAt = timer.now();

    expect(manager.getSession(SESSION)!.expiresAt).toBe(endedAt + 5 * MINUTE);
    await heartbeat();
    expect(manager.getSession(SESSION)!.expiresAt).toBe(endedAt + 5 * MINUTE);
  });

  test("reads never extend the idle window", async () => {
    await manager.adoptManagedExecutionLivenessPolicy(SESSION);
    const before = { ...manager.getSession(SESSION)! };
    timer.advanceTime(MINUTE);

    await manager.getOrCreateSession(SESSION, undefined, undefined, undefined, false, "read-only");
    manager.getSessionCache(SESSION);

    const after = manager.getSession(SESSION)!;
    expect(after.lastUsedAt).toBe(before.lastUsedAt);
    expect(after.expiresAt).toBe(before.expiresAt);
  });

  test("session-info and heartbeat reporting use the judged live, suspect and lapsed lease", async () => {
    await manager.adoptManagedExecutionLivenessPolicy(SESSION);
    const info = () =>
      handleDaemonRequest(
        {
          id: "info",
          type: "daemon_request",
          method: "daemon/sessionInfo",
          params: { sessionId: SESSION },
        },
        state(),
      );
    expect(await info()).toMatchObject({ success: true, result: { idleReleaseAt: null } });
    expect(await heartbeat({ reportIdleRelease: true })).toMatchObject({
      success: true,
      result: { idleReleaseAt: null },
    });
    timer.advanceTime(5_000);
    expect(await info()).toMatchObject({
      success: true,
      result: { idleReleaseAt: null, liveness: { state: "suspect" } },
    });
    timer.advanceTime(3_001);
    expect(await info()).toMatchObject({
      success: true,
      result: { idleReleaseAt: DEFAULT_SESSION_IDLE_TIMEOUT_MS, liveness: { state: "lapsed" } },
    });
  });

  test("adopting the policy is not use: the deadline is anchored on the last tool activity", async () => {
    const lastToolActivity = manager.getSession(SESSION)!.lastUsedAt;
    timer.advanceTime(MINUTE);

    await manager.adoptManagedExecutionLivenessPolicy(SESSION, { idleTimeoutMs: 3 * MINUTE });

    expect(manager.getSession(SESSION)!.expiresAt).toBe(lastToolActivity + 3 * MINUTE);
    expect(manager.getSession(SESSION)!.lastUsedAt).toBe(lastToolActivity);
  });

  test("an out-of-bounds override is refused and changes nothing", async () => {
    const before = { ...manager.getSession(SESSION)! };

    await expect(
      manager.adoptManagedExecutionLivenessPolicy(SESSION, { idleTimeoutMs: 61 * MINUTE }),
    ).rejects.toBeInstanceOf(ManagedSlotConfigError);

    expect(manager.getSession(SESSION)!.livenessPolicy).toBe("heartbeat");
    expect(manager.getSession(SESSION)!.sessionTimeoutMs).toBe(before.sessionTimeoutMs);
  });

  test("an unknown session is refused", async () => {
    await expect(manager.adoptManagedExecutionLivenessPolicy("missing")).rejects.toThrow(
      "not active",
    );
  });

  test("heartbeat loss releases the session within 10 s, after the suspect grace", async () => {
    await manager.adoptManagedExecutionLivenessPolicy(SESSION);
    timer.setCurrentTime(30 * MINUTE);
    await heartbeat();
    const lastBeat = timer.now();

    for (let elapsed = 0; elapsed < NO_HEARTBEAT_RELEASE_BUDGET_MS;) {
      elapsed += DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
      timer.setCurrentTime(lastBeat + elapsed);
      await sweep();
      if (elapsed === 8_000) {
        // Lease (4 s) plus grace (4 s) not yet exceeded: still held, suspect.
        expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
      }
    }

    expect(releases).toEqual([{ at: lastBeat + 10_000, reason: "heartbeat-timeout" }]);
    expect(NO_HEARTBEAT_RELEASE_BUDGET_MS).toBe(10_000);
    expect(await persistence.getSession!(SESSION)).toMatchObject({
      release_reason: "heartbeat-timeout",
    });
    const info = await handleDaemonRequest(
      {
        id: "info",
        type: "daemon_request",
        method: "daemon/sessionInfo",
        params: { sessionId: SESSION },
      },
      state(),
    );
    expect(info).toMatchObject({ success: false, releaseReason: "heartbeat-timeout" });
    expect(info).not.toHaveProperty("idle");
  });

  test("a one-shot CLI declaration cannot move the session onto cli-idle", async () => {
    await manager.adoptManagedExecutionLivenessPolicy(SESSION);

    const ack = await heartbeat({
      livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
      idleTimeoutMs: 1,
      claimLivenessOwnership: true,
    });

    expect(ack).toMatchObject({
      success: true,
      result: { livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY, livenessUnchanged: true },
    });
    expect(manager.adoptCliLivenessPolicy(SESSION)).toBe(false);
    expect(manager.getSession(SESSION)!.livenessPolicy).toBe(MANAGED_EXECUTION_LIVENESS_POLICY);
    expect(manager.getSession(SESSION)!.heartbeatTimeoutMs).toBe(
      SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS,
    );
  });

  test("a cli-idle session cannot be adopted for a managed execution", async () => {
    manager.adoptCliLivenessPolicy(SESSION);

    await expect(manager.adoptManagedExecutionLivenessPolicy(SESSION)).rejects.toThrow(
      "one-shot CLI",
    );
  });

  test("a rehydrated row keeps its policy and a 30-minute window (not the legacy default)", async () => {
    await manager.adoptManagedExecutionLivenessPolicy(SESSION, { idleTimeoutMs: 30 * MINUTE });
    const row = (await persistence.getSession!(SESSION))!;

    const liveness = (
      manager as unknown as {
        recoveryLivenessFromPersisted(persisted: typeof row): {
          livenessPolicy: string;
          sessionTimeoutMs: number;
        };
      }
    ).recoveryLivenessFromPersisted(row);

    expect(liveness.livenessPolicy).toBe(MANAGED_EXECUTION_LIVENESS_POLICY);
    expect(liveness.sessionTimeoutMs).toBe(30 * MINUTE);
  });

  test.each(["managed-execution", "heartbeat"] as const)(
    "restart past the persisted idle deadline preserves %s policy semantics",
    async (policy) => {
      if (policy === "managed-execution") {
        await manager.adoptManagedExecutionLivenessPolicy(SESSION);
      }
      manager.stopCleanupTimer();
      await persistence.markReleased(SESSION, "released", timer.now(), "daemon-restart");
      timer.setCurrentTime(30 * MINUTE);
      manager = new SessionManager(timer, persistence);
      await manager.rehydratePersistedSessions({
        async assignDeviceToSession(sessionId, _platform, target) {
          const session = await manager.createSession(
            sessionId,
            target?.deviceId ?? DEVICE,
            "android",
            target?.liveness?.sessionTimeoutMs,
            target?.liveness?.heartbeatTimeoutMs,
            target?.stableDeviceId,
            target?.liveness,
            target?.initialOwnership,
          );
          return session.assignedDevice;
        },
      });
      if (policy === "managed-execution") {
        expect(manager.getSession(SESSION)?.ownership).toBe("awaiting-owner");
        expect(await heartbeat()).toMatchObject({ success: true });
        await manager.getOrCreateSession(SESSION, undefined, undefined, {
          executionId: "restart-control",
          startTime: timer.now(),
        });
        expect((await persistence.getSession!(SESSION))?.release_reason).toBeNull();
      } else {
        expect(manager.hasSession(SESSION)).toBe(false);
        expect((await persistence.getSession!(SESSION))?.release_reason).toBe("expired");
        expect(await heartbeat()).toMatchObject({
          success: false,
          releaseReason: "expired",
          idle: true,
        });
      }
    },
  );

  describe("#11162 session-clock interplay", () => {
    test("a non-owner's tool calls do not keep a dead owner's lease alive across a stall", async () => {
      await manager.adoptManagedExecutionLivenessPolicy(SESSION, { idleTimeoutMs: 10 * MINUTE });
      const ownerBeat = timer.now();
      // The owner stops; another connection keeps naming the session (activity, not liveness).
      timer.advanceTime(3_000);
      await manager.getOrCreateSession(SESSION);
      // The daemon stalls for 3 s; forgiveness anchors on the owner's heartbeat, not that call.
      manager.forgiveDaemonStall(timer.now(), 3_000, 0, ownerBeat + 1_000);
      timer.setCurrentTime(ownerBeat + 4_000 + 3_000 + 1);

      expect(manager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");
    });

    test("a daemon stall shifts the idle deadline by the lost time, capped at the override", async () => {
      await manager.adoptManagedExecutionLivenessPolicy(SESSION, { idleTimeoutMs: 5 * MINUTE });
      const deadline = manager.getSession(SESSION)!.expiresAt;
      timer.advanceTime(MINUTE);

      manager.forgiveDaemonStall(timer.now(), 20_000);

      expect(manager.getSession(SESSION)!.expiresAt).toBe(deadline + 20_000);
      expect(manager.getSession(SESSION)!.expiresAt).toBeLessThanOrEqual(timer.now() + 5 * MINUTE);
    });
  });
});
