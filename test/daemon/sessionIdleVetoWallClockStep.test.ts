import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SESSION_IDLE_TIMEOUT_ENV } from "../../src/daemon/sessionLivenessWindows";
import { ExecutionTracker, type ActiveExecution } from "../../src/server/executionTracker";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";

// #11105 item 2: request deadlines are stamped on the wall clock, the idle veto judges them on
// the session clock. A wall step before a call starts must not end its veto early.

const SESSION = "veto-step-session";
const DEVICE = "emulator-5554";
const HOUR_MS = 3_600_000;

describe("idle-release veto under a wall-clock step (#11105)", () => {
  let timer: FakeTimer;
  let tracker: ExecutionTracker;
  let manager: SessionManager;
  let call: ActiveExecution;
  const savedEnv = process.env[SESSION_IDLE_TIMEOUT_ENV];

  beforeEach(async () => {
    delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    timer = new FakeTimer();
    tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    // Wired the way the daemon wires the real tracker.
    tracker.setSessionClockOffsetProvider(() => manager.sessionNow() - timer.now());
    manager.setActiveSessionExecutionChecker((sessionId, query) =>
      tracker.hasActiveSessionUuidExecutions(sessionId, query),
    );
    manager.setSessionExecutionDeadlineLookup((sessionId) =>
      tracker.getLatestSessionExecutionDeadlineMs(sessionId, { onSessionClock: true }),
    );
    manager.setExpiryReleaseExecutionCanceller((sessionId, reason, query) => {
      void tracker.cancelDeviceSessionExecutions(sessionId, reason, {
        excludeExecutionId: query.excludeExecutionId,
      });
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

  it("a backward step before the call does not abort it before its own deadline", () => {
    timer.stepWallClock(-HOUR_MS);
    call = tracker.startExecution("provision", undefined, SESSION);
    const callDeadline = timer.now() + 600_000;
    tracker.setExecutionDeadline(call.id, () => callDeadline);

    // Well past the idle window, still inside the call's 10 minute deadline.
    timer.advanceTime(400_000);
    manager.cleanupExpiredSessions();

    expect(call.abortController.signal.aborted).toBe(false);
    expect(manager.getSession(SESSION)).not.toBeNull();
  });

  it("the call is still aborted once its deadline plus grace has passed", () => {
    timer.stepWallClock(-HOUR_MS);
    call = tracker.startExecution("provision", undefined, SESSION);
    const callDeadline = timer.now() + 600_000;
    tracker.setExecutionDeadline(call.id, () => callDeadline);

    timer.advanceTime(700_000);
    manager.cleanupExpiredSessions();

    expect(call.abortController.signal.aborted).toBe(true);
  });

  it("a forward step before a progress extension does not stretch the veto past the abort (#11123)", () => {
    // Where the monotonic clock includes sleep (Linux, Windows) the session clock ignores a forward step.
    timer.simulateSleepCountingMonotonicClock();
    call = tracker.startExecution("provision", undefined, SESSION);
    const deadline = new ProgressExtendableDeadline(timer.now(), 600_000, 10 * HOUR_MS);
    tracker.setExecutionDeadline(
      call.id,
      () => deadline.value,
      (onExtended) => deadline.onExtended(onExtended),
    );
    timer.advanceTime(300_000);
    manager.sessionNow(); // the daemon samples the session clock continuously
    timer.stepWallClock(HOUR_MS);
    // Progress restamps the deadline with the stepped wall clock; the real abort fires 600s of
    // monotonic time later, on the session clock at sessionNow() + 600s.
    deadline.extendOnProgress(timer.now(), 600_000);

    const sessionDeadline = tracker.getLatestSessionExecutionDeadlineMs(SESSION, {
      onSessionClock: true,
    });

    expect(sessionDeadline).toBe(manager.sessionNow() + 600_000);
  });
});
