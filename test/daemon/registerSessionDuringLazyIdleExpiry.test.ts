import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { expireIfDue } from "../helpers/expireIfDue";
import type { Kysely } from "kysely";
import {
  DAEMON_REGISTER_SESSION_METHOD,
  SESSION_RELEASE_DRAIN_TIMEOUT_MS,
} from "../../src/daemon/wire/constants";
import {
  handleDaemonRequest,
  type DaemonMethodResult,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import { SESSION_OWNERSHIP_LOST_CODE } from "../../src/daemon/sessionReleasedDuringCall";
import { DAEMON_SESSION_NOT_FOUND_CODE, type DaemonRequest } from "../../src/daemon/types";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "../../src/models/deviceSessionRecovery";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";

// #12042: registration's own lookup can start lazy idle expiry while device-state
// restoration is still running, before the release publishes its terminal fence.
const SESSION = "00000000-0000-4000-8000-0000000000a1";
const DEVICE = "emulator-5554";
const IDLE_MS = 120_000;
const OBSERVER_TIMEOUT_MS = 10_000;

const request = (method: string, params: unknown): DaemonRequest => ({
  id: "test",
  type: "daemon_request",
  method,
  params,
});

const idleRefusal = {
  success: false,
  code: SESSION_OWNERSHIP_LOST_CODE,
  retryable: false,
  nextAction: ACQUIRE_NEW_SESSION_NEXT_ACTION,
  error: expect.stringContaining(`Session ${SESSION} is terminal after cleanup-expired`),
  details: { sessionUuid: SESSION, reason: "cleanup-expired", idle: true },
  releaseReason: "cleanup-expired",
  idle: true,
} satisfies DaemonMethodResult;
const bareNotFound = {
  success: false,
  code: DAEMON_SESSION_NOT_FOUND_CODE,
  error: `Session not found: ${SESSION}`,
} satisfies DaemonMethodResult;
const idleNotFound = {
  ...bareNotFound,
  releaseReason: "cleanup-expired",
  idle: true,
} satisfies DaemonMethodResult;

describe("registerSession during lazy idle expiry (#12042)", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let manager: SessionManager;
  let registry: ObserverSessionRegistry;
  let state: DaemonStateAccess;
  let restoreStarted: boolean;
  let finishRestore: () => void;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    restoreStarted = false;
    const restored = Promise.withResolvers<void>();
    finishRestore = restored.resolve;
    manager = new SessionManager(timer, new DeviceSessionRepository({ db, timer }), {
      barrier: () => new FakeDbWriteBarrier(),
      keepScreenAwakeRestorer: () => ({
        restore: async () => {
          restoreStarted = true;
          await restored.promise;

          return { status: "restored" as const };
        },
      }),
    });
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId("daemon-a");
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-a"]));
    registry = new ObserverSessionRegistry(timer, OBSERVER_TIMEOUT_MS);
    manager.setObserverSessionRegistry(registry);
    state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getObserverSessionRegistry: () => registry,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
      getDevicePool: () => {
        throw new Error("These requests must not consult the pool");
      },
    };
    await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_MS });
    manager.setKeepScreenAwake(SESSION, { applied: true, method: "svc", svcWasEnabled: false });
  });

  afterEach(async () => {
    finishRestore();
    await manager.waitForSessionRelease(SESSION);
    registry.dispose();
    timer.reset();
    await db.destroy();
  });

  const register = (sessionId = SESSION) =>
    handleDaemonRequest(
      request(DAEMON_REGISTER_SESSION_METHOD, { sessionId, clientName: "desktop" }),
      state,
    );
  const heartbeat = () =>
    handleDaemonRequest(request("daemon/heartbeat", { sessionId: SESSION }), state);
  const sessionInfo = () =>
    handleDaemonRequest(request("daemon/sessionInfo", { sessionId: SESSION }), state);

  async function registerBeforeFence(registration = register()) {
    return await Promise.race([
      registration,
      drainMicrotasks(100).then(() => {
        throw new Error("Registration did not settle while restore was blocked");
      }),
    ]);
  }

  function expireWithoutLookup(): void {
    timer.advanceTime(IDLE_MS + 1);
    expect(manager.hasSession(SESSION)).toBe(true);
    expect(restoreStarted).toBe(false);
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
  }

  function expectPreFenceRestore(): void {
    expect(restoreStarted).toBe(true);
    expect(manager.getReleasingSession(SESSION)).not.toBeNull();
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
  }

  async function expectIdleControlRefusal(
    control = manager.admitIssuedSessionForAutomation(SESSION, {
      executionId: "late-control",
      startTime: timer.now(),
    }),
  ): Promise<void> {
    // After teardown the terminal answer must settle without advancing fake time.
    const outcome = await Promise.race([
      control.then(
        (session) => ({ kind: "accepted", session }),
        (error: unknown) => ({ kind: "rejected", error }),
      ),
      drainMicrotasks(100).then(() => ({ kind: "pending" })),
    ]);
    expect(outcome.kind).toBe("rejected");
    if (!("error" in outcome)) {
      throw new Error("Expected terminal control refusal");
    }
    expect(outcome.error).toBeInstanceOf(TerminalSessionError);
    expect(outcome.error).toMatchObject({
      release: { releaseReason: "cleanup-expired", terminal: true },
    });
  }

  test("a finished idle release refuses registration", async () => {
    expireWithoutLookup();
    expect(expireIfDue(manager, SESSION)).toBeNull();
    finishRestore();
    await manager.waitForSessionRelease(SESSION);

    const release = spyOn(manager, "releaseSession");
    try {
      expect(await register()).toEqual(idleRefusal);
      expect(registry.list()).toEqual([]);
      expect(release).not.toHaveBeenCalled();
      expect(manager.getReleasingSession(SESSION)).toBeNull();
    } finally {
      release.mockRestore();
    }
  });

  test("the lookup that starts idle release refuses immediately before the fence", async () => {
    expireWithoutLookup();
    const answer = await registerBeforeFence();
    expectPreFenceRestore();

    expect(answer).toEqual(idleRefusal);
    expect(registry.list()).toEqual([]);
  });

  test("a session issued and already idle-expired while the persisted row is read is refused, not registered", async () => {
    // Leave a recoverable row and no live session; reissuance happens only during the read.
    manager.setKeepScreenAwake(SESSION, { applied: false, method: "svc", svcWasEnabled: false });
    await manager.releaseSession(SESSION, "daemon-shutdown");
    expect(manager.hasSession(SESSION)).toBe(false);
    const finishRead = Promise.withResolvers<void>();
    let reading = false;
    const expired = spyOn(manager, "getExpiredReleaseSnapshot").mockImplementationOnce(async () => {
      reading = true;
      await finishRead.promise;
      return undefined;
    });
    try {
      const registration = register();
      await drainUntil(() => reading, { description: "blocked persisted snapshot read" });
      await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_MS });
      manager.setKeepScreenAwake(SESSION, { applied: true, method: "svc", svcWasEnabled: false });
      expireWithoutLookup();
      finishRead.resolve();
      const answer = await registerBeforeFence(registration);
      expect(answer).toEqual(idleRefusal);
      expectPreFenceRestore();
      expect(await heartbeat()).toEqual(idleNotFound);
      expect(await sessionInfo()).toEqual(idleNotFound);
      const control = manager.admitIssuedSessionForAutomation(SESSION, {
        executionId: "late-control",
        startTime: timer.now(),
      });
      expect(
        await Promise.race([
          control.then(
            () => "accepted",
            () => "rejected",
          ),
          drainMicrotasks(100).then(() => "pending"),
        ]),
      ).toBe("pending");
      finishRestore();
      await expectIdleControlRefusal(control);
      expect(await heartbeat()).toEqual(idleNotFound);
      expect(await sessionInfo()).toEqual(idleNotFound);
      expect(await register()).toEqual(idleRefusal);
      expect(registry.list()).toEqual([]);
      expect(expired).toHaveBeenCalledTimes(1);
    } finally {
      finishRead.resolve();
      expired.mockRestore();
      finishRestore();
    }
  });

  test("control admission waits for pre-fence teardown then rejects with the idle end", async () => {
    expireWithoutLookup();
    expect(manager.getSession(SESSION)).toBeNull();
    await drainUntil(() => restoreStarted, { description: "blocked keep-awake restore" });

    const control = manager.admitIssuedSessionForAutomation(SESSION, {
      executionId: "late-control",
      startTime: timer.now(),
    });
    try {
      expect(
        await Promise.race([
          control.then(
            () => "accepted",
            () => "rejected",
          ),
          drainMicrotasks(100).then(() => "pending"),
        ]),
      ).toBe("pending");
      expectPreFenceRestore();
      finishRestore();
      await expectIdleControlRefusal(control);
      await expectIdleControlRefusal();
    } finally {
      finishRestore();
    }
  });

  test("after registration, pre-fence heartbeat and session-info name the idle end", async () => {
    expireWithoutLookup();
    await registerBeforeFence();
    expectPreFenceRestore();

    expect(await heartbeat()).toEqual(idleNotFound);
    expect(await sessionInfo()).toEqual(idleNotFound);
    expect(registry.list()).toEqual([]);
    expectPreFenceRestore();
  });

  for (const method of ["daemon/heartbeat", "daemon/sessionInfo"]) {
    test(`${method} names the idle end when its own lookup starts pre-fence release`, async () => {
      expireWithoutLookup();
      expect(await handleDaemonRequest(request(method, { sessionId: SESSION }), state)).toEqual(
        idleNotFound,
      );
      expectPreFenceRestore();
      expect(await heartbeat()).toEqual(idleNotFound);
      expect(await sessionInfo()).toEqual(idleNotFound);
      finishRestore();
      await manager.waitForSessionRelease(SESSION);
      expect(await heartbeat()).toEqual(idleNotFound);
      expect(await sessionInfo()).toEqual(idleNotFound);
    });
  }

  test("heartbeat and session-info name the idle end while the sweep is restoring state", async () => {
    expireWithoutLookup();
    const cleanup = manager.cleanupExpiredSessions();
    try {
      await drainUntil(() => restoreStarted, { description: "sweep keep-awake restore" });
      expectPreFenceRestore();
      expect(await heartbeat()).toEqual(idleNotFound);
      expect(await sessionInfo()).toEqual(idleNotFound);
      finishRestore();
      await cleanup;
      expect(await heartbeat()).toEqual(idleNotFound);
      expect(await sessionInfo()).toEqual(idleNotFound);
    } finally {
      finishRestore();
      await cleanup;
    }
  });

  test("explicit release stays bare before the fence and names its reason after restore", async () => {
    // An overdue session exercises session-info's not-found fallback as well as heartbeat's.
    // The explicit terminal reason wins over the idle deadline in registration's predicate.
    expireWithoutLookup();
    const release = manager.releaseSession(SESSION, "explicit-release");
    try {
      await drainUntil(() => restoreStarted, {
        description: "explicit-release keep-awake restore",
      });
      expectPreFenceRestore();
      expect(manager.peekTerminalAnswerForEndedSession(SESSION)?.release.releaseReason).toBe(
        "explicit-release",
      );
      expect(await heartbeat()).toEqual(bareNotFound);
      expect(await sessionInfo()).toEqual(bareNotFound);
      finishRestore();
      await release;
      const released = { ...bareNotFound, releaseReason: "explicit-release" };
      expect(await heartbeat()).toEqual(released);
      expect(await sessionInfo()).toEqual(released);
    } finally {
      finishRestore();
      await release;
    }
  });

  test("an overdue daemon-shutdown handoff stays bare before the fence and answers expired after restore", async () => {
    expireWithoutLookup();
    const release = manager.releaseSession(SESSION, "daemon-shutdown", { allowExpired: true });
    try {
      await drainUntil(() => restoreStarted, { description: "daemon-shutdown keep-awake restore" });
      expectPreFenceRestore();
      expect(manager.peekTerminalAnswerForEndedSession(SESSION)?.release.releaseReason).toBe(
        "cleanup-expired",
      );
      expect(await heartbeat()).toEqual(bareNotFound);
      expect(await sessionInfo()).toEqual(bareNotFound);
      finishRestore();
      await release;
      const released = {
        ...bareNotFound,
        releaseReason: "expired",
        idle: true,
      } satisfies DaemonMethodResult;
      expect(await heartbeat()).toEqual(released);
      expect(await sessionInfo()).toEqual(released);
    } finally {
      finishRestore();
      await release;
    }
  });

  test("a CLI idle release names cli-idle-timeout before and after the fence", async () => {
    expect(manager.adoptCliLivenessPolicy(SESSION, IDLE_MS)).toBe(true);
    expireWithoutLookup();
    const release = manager.releaseSession(SESSION, "cli-idle-timeout");
    try {
      await drainUntil(() => restoreStarted, { description: "CLI idle keep-awake restore" });
      expectPreFenceRestore();
      const released = {
        ...bareNotFound,
        releaseReason: "cli-idle-timeout",
        idle: true,
      } satisfies DaemonMethodResult;
      expect(await manager.getReleasedSessionReason(SESSION)).toBe("cli-idle-timeout");
      expect(await heartbeat()).toEqual(released);
      finishRestore();
      await release;
      expect(await heartbeat()).toEqual(released);
      expect(await sessionInfo()).toEqual(released);
    } finally {
      finishRestore();
      await release;
    }
  });

  test("commit-fenced device loss stays bare during pre-fence teardown", async () => {
    expireWithoutLookup();
    const release = manager.releaseSessionUnlessSuperseded(
      SESSION,
      "device-disconnected:emulator-5554",
      { commitFence: () => true },
    );
    try {
      await drainUntil(() => restoreStarted, { description: "device-loss keep-awake restore" });
      expectPreFenceRestore();
      expect(await heartbeat()).toEqual(bareNotFound);
      expect(await sessionInfo()).toEqual(bareNotFound);
    } finally {
      finishRestore();
      await release;
    }
  });

  test("a live unexpired session's session-info stays live", async () => {
    expect(await sessionInfo()).toMatchObject({
      success: true,
      result: { sessionId: SESSION, assignedDevice: DEVICE },
    });
    expect(restoreStarted).toBe(false);
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
  });

  test("timely control work keeps both wires live past the idle deadline", async () => {
    manager.setActiveSessionExecutionChecker(
      (_sessionId, query) =>
        query?.sessionClockStartedAtOrBefore === undefined ||
        1_000 <= query.sessionClockStartedAtOrBefore,
    );
    expireWithoutLookup();
    expect(manager.peekTerminalAnswerForEndedSession(SESSION)).toBeUndefined();
    expect(await manager.getReleasedSessionReason(SESSION)).toBeUndefined();
    expect(await register()).toMatchObject({ success: true, result: { accepted: true } });
    expect(registry.list()).toEqual([]);
    expect(manager.getReleasingSession(SESSION)).toBeNull();
    expect(await heartbeat()).toMatchObject({ success: true });
    expect(await sessionInfo()).toMatchObject({ success: true, result: { sessionId: SESSION } });
    expect(restoreStarted).toBe(false);
  });

  test("a never-issued UUID stays bare on heartbeat and session-info", async () => {
    const sessionId = "00000000-0000-4000-8000-0000000000a2";
    for (const method of ["daemon/heartbeat", "daemon/sessionInfo"]) {
      expect(await handleDaemonRequest(request(method, { sessionId }), state)).toEqual({
        ...bareNotFound,
        error: `Session not found: ${sessionId}`,
      });
    }
  });

  test("a second registration drains teardown then returns the idle refusal", async () => {
    expireWithoutLookup();
    await registerBeforeFence();
    expectPreFenceRestore();
    const drain = spyOn(manager, "waitForSessionReleaseWithin");
    try {
      const second = register();
      expect(
        await Promise.race([
          second.then(() => "answered"),
          drainMicrotasks(100).then(() => "pending"),
        ]),
      ).toBe("pending");
      expect(drain).toHaveBeenCalledWith(SESSION, SESSION_RELEASE_DRAIN_TIMEOUT_MS);
      expect(registry.list()).toEqual([]);
      expectPreFenceRestore();
      finishRestore();
      expect(await second).toEqual(idleRefusal);
      expect(registry.list()).toEqual([]);
    } finally {
      finishRestore();
      drain.mockRestore();
    }
  });

  test("a second registration whose drain times out keeps the bounded retry answer", async () => {
    expireWithoutLookup();
    await registerBeforeFence();
    expectPreFenceRestore();
    const drain = spyOn(manager, "waitForSessionReleaseWithin");
    try {
      const second = register();
      expect(
        await Promise.race([
          second.then(() => "answered"),
          drainMicrotasks(100).then(() => "pending"),
        ]),
      ).toBe("pending");
      expect(drain).toHaveBeenCalledWith(SESSION, SESSION_RELEASE_DRAIN_TIMEOUT_MS);
      expect(timer.getPendingTimeouts().at(-1)).toBe(SESSION_RELEASE_DRAIN_TIMEOUT_MS);
      timer.fireNewestPendingTimeout();
      expect(await second).toEqual({
        success: false,
        error: `Session ${SESSION} release is still in progress after ${SESSION_RELEASE_DRAIN_TIMEOUT_MS}ms; retry registration`,
      });
      expect(registry.list()).toEqual([]);
      expectPreFenceRestore();
    } finally {
      finishRestore();
      drain.mockRestore();
    }
  });

  test("after teardown every surface names the same idle end without an observer", async () => {
    expireWithoutLookup();
    await registerBeforeFence();
    expectPreFenceRestore();
    finishRestore();
    await manager.waitForSessionRelease(SESSION);

    expect(await register()).toEqual(idleRefusal);
    expect(await heartbeat()).toEqual(idleNotFound);
    expect(await sessionInfo()).toEqual(idleNotFound);
    await expectIdleControlRefusal();
    expect(registry.list()).toEqual([]);
  });

  test("a never-issued UUID still registers as an observer", async () => {
    const fresh = "00000000-0000-4000-8000-0000000000a2";
    expect(await register(fresh)).toEqual({
      success: true,
      result: {
        accepted: true,
        heartbeatTimeoutMs: OBSERVER_TIMEOUT_MS,
        expiresAtMs: expect.any(Number),
      },
    });
    expect(registry.list().map((observer) => observer.sessionId)).toEqual([fresh]);
    expect(restoreStarted).toBe(false);
  });

  test("a live session registers as itself without starting release", async () => {
    const session = manager.getSession(SESSION)!;
    expect(await register()).toEqual({
      success: true,
      result: {
        accepted: true,
        heartbeatTimeoutMs: session.heartbeatTimeoutMs,
        expiresAtMs: expect.any(Number),
      },
    });
    expect(registry.list()).toEqual([]);
    expect(restoreStarted).toBe(false);
    expect(manager.getReleasingSession(SESSION)).toBeNull();
  });

  test("an explicit release in pre-fence teardown keeps its bounded retry answer", async () => {
    const release = manager.releaseSession(SESSION, "explicit-release");
    await drainUntil(() => restoreStarted, { description: "blocked keep-awake restore" });
    expectPreFenceRestore();
    expect(manager.peekTerminalAnswerForEndedSession(SESSION)?.release.releaseReason).toBe(
      "explicit-release",
    );
    const drain = spyOn(manager, "waitForSessionReleaseWithin");
    try {
      const registration = register();
      // The registration has synchronously entered its drain on the original path.
      await Promise.resolve();
      await Promise.resolve();
      expect(drain).toHaveBeenCalledWith(SESSION, SESSION_RELEASE_DRAIN_TIMEOUT_MS);
      timer.fireNewestPendingTimeout();
      expect(await registration).toEqual({
        success: false,
        error: `Session ${SESSION} release is still in progress after ${SESSION_RELEASE_DRAIN_TIMEOUT_MS}ms; retry registration`,
      });
      expectPreFenceRestore();
      expect(registry.list()).toEqual([]);
    } finally {
      drain.mockRestore();
      finishRestore();
      await release;
    }
  });
});
