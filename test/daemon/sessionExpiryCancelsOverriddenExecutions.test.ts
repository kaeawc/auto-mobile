import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SESSION_IDLE_TIMEOUT_ENV } from "../../src/daemon/sessionLivenessWindows";
import {
  UNSETTLED_EXECUTION_DEADLINE_GRACE_MS,
  UNSETTLED_EXECUTION_VETO_CEILING_MS,
} from "../../src/daemon/unsettledExecutionVeto";
import { ExecutionTracker, type ActiveExecution } from "../../src/server/executionTracker";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

// #10820: once an in-flight call's veto runs out (#10713), an idle-expiry release must abort that
// call before the device goes back to the pool, as the heartbeat reap and owner-disconnect paths
// do (#9839). Inside the veto window it must abort nothing.

const SESSION = "expiry-cancel-session";
const DEVICE = "emulator-5554";

describe("idle-expiry release cancels the executions it overrides (#10820)", () => {
  let timer: FakeTimer;
  let tracker: ExecutionTracker;
  let manager: SessionManager;
  let releases: { reason: string; abortedAtRelease: boolean }[];
  let hung: ActiveExecution | undefined;
  let cancelCalls: { sessionId: string; reason: string }[];
  const savedEnv = process.env[SESSION_IDLE_TIMEOUT_ENV];

  beforeEach(async () => {
    delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    timer = new FakeTimer();
    tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    releases = [];
    cancelCalls = [];
    hung = undefined;
    // Wired the way the daemon wires the real tracker.
    manager.setActiveSessionExecutionChecker((sessionId, query) =>
      tracker.hasActiveSessionUuidExecutions(sessionId, query),
    );
    manager.setSessionExecutionDeadlineLookup((sessionId) =>
      tracker.getLatestSessionExecutionDeadlineMs(sessionId),
    );
    manager.setExpiryReleaseExecutionCanceller((sessionId, reason, query) => {
      cancelCalls.push({ sessionId, reason });
      void tracker.cancelDeviceSessionExecutions(sessionId, reason, {
        excludeExecutionId: query.excludeExecutionId,
      });
    });
    manager.onSessionRelease((_sessionId, _deviceId, reason) => {
      releases.push({ reason, abortedAtRelease: hung?.abortController.signal.aborted ?? false });
    });
    await manager.createSession(SESSION, DEVICE, "android");
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    if (savedEnv === undefined) {
      delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    } else {
      process.env[SESSION_IDLE_TIMEOUT_ENV] = savedEnv;
    }
  });

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }
  };

  const startHungCall = (): number => {
    hung = tracker.startExecution("rotate", undefined, SESSION);
    return manager.getAllSessions()[0]!.expiresAt;
  };

  it("sweep: aborts a call with a deadline only once its deadline plus grace passes", async () => {
    const idleDeadline = startHungCall();
    const requestDeadline = idleDeadline + 60_000;
    tracker.setExecutionDeadline(hung!.id, () => requestDeadline);

    timer.setCurrentTime(requestDeadline + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS - 1);
    manager.cleanupExpiredSessions();
    await settle();
    expect(hung!.abortController.signal.aborted).toBe(false);
    expect(cancelCalls).toEqual([]);
    expect(releases).toEqual([]);

    timer.setCurrentTime(requestDeadline + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS);
    manager.cleanupExpiredSessions();
    expect(hung!.abortController.signal.aborted).toBe(true);
    await settle();
    expect(cancelCalls).toEqual([{ sessionId: SESSION, reason: "cleanup-expired" }]);
    expect(releases).toEqual([{ reason: "cleanup-expired", abortedAtRelease: true }]);
  });

  it("sweep: aborts a deadline-less call only once the veto ceiling passes", async () => {
    const idleDeadline = startHungCall();

    timer.setCurrentTime(idleDeadline + UNSETTLED_EXECUTION_VETO_CEILING_MS - 1);
    manager.cleanupExpiredSessions();
    await settle();
    expect(hung!.abortController.signal.aborted).toBe(false);
    expect(releases).toEqual([]);

    timer.setCurrentTime(idleDeadline + UNSETTLED_EXECUTION_VETO_CEILING_MS);
    manager.cleanupExpiredSessions();
    await settle();
    expect(releases).toEqual([{ reason: "cleanup-expired", abortedAtRelease: true }]);
  });

  it("lazy lookup: aborts the overridden call before releasing", async () => {
    const idleDeadline = startHungCall();

    timer.setCurrentTime(idleDeadline + UNSETTLED_EXECUTION_VETO_CEILING_MS - 1);
    expect(manager.getSession(SESSION)).not.toBeNull();
    expect(hung!.abortController.signal.aborted).toBe(false);

    timer.setCurrentTime(idleDeadline + UNSETTLED_EXECUTION_VETO_CEILING_MS);
    expect(manager.getSession(SESSION)).toBeNull();
    expect(hung!.abortController.signal.aborted).toBe(true);
    await settle();
    expect(cancelCalls).toEqual([{ sessionId: SESSION, reason: "lazy-expiry" }]);
    expect(releases).toEqual([{ reason: "lazy-expiry", abortedAtRelease: true }]);
  });

  it("an ordinary idle release with nothing in flight cancels nothing", async () => {
    const idleDeadline = manager.getAllSessions()[0]!.expiresAt;
    timer.setCurrentTime(idleDeadline + 1);
    manager.cleanupExpiredSessions();
    await settle();
    expect(cancelCalls).toEqual([]);
    expect(releases.map((release) => release.reason)).toEqual(["cleanup-expired"]);
  });

  it("never cancels inside the veto window, even when a new-execution lookup expires the session", async () => {
    const idleDeadline = startHungCall();

    timer.setCurrentTime(idleDeadline + 1);
    expect(manager.getSessionForNewExecution(SESSION)).toBeNull();
    await settle();
    expect(hung!.abortController.signal.aborted).toBe(false);
    expect(cancelCalls).toEqual([]);
    expect(releases).toEqual([{ reason: "lazy-expiry", abortedAtRelease: false }]);
  });

  it("does not cancel the late execution whose own lookup expires the session", async () => {
    const idleDeadline = manager.getAllSessions()[0]!.expiresAt;
    timer.setCurrentTime(idleDeadline + 1);
    hung = tracker.startExecution("tapOn", undefined, SESSION);

    expect(
      manager.getSessionForNewExecution(SESSION, {
        executionId: hung.id,
        startTime: hung.startTime,
      }),
    ).toBeNull();
    await settle();
    expect(hung.abortController.signal.aborted).toBe(false);
    expect(cancelCalls).toEqual([]);
    expect(releases.map((release) => release.reason)).toEqual(["lazy-expiry"]);
  });
});
