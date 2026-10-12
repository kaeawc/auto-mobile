import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  SessionManager,
  TerminalSessionError,
  type SessionExecutionMetadata,
} from "../../src/daemon/sessionManager";
import { hasActiveSessionExecution } from "../../src/daemon/toolCallActivity";
import { sessionReleasedDuringCallPayload } from "../../src/server/deviceSessionResult";
import { SESSION_IDLE_TIMEOUT_ENV } from "../../src/daemon/sessionLivenessWindows";
import {
  ExecutionTracker,
  sessionExecutionMetadataOf,
  type ActiveExecution,
} from "../../src/server/executionTracker";
import {
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";
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
    tracker.setSessionClockOffsetProvider(
      (wallNowMs = timer.now()) => manager.sessionNow() - wallNowMs,
    );
    manager.setActiveSessionExecutionChecker((sessionId, query) =>
      tracker.hasActiveSessionUuidExecutions(sessionId, query),
    );
    manager.setSessionExecutionDeadlineLookup((sessionId) =>
      tracker.getLatestSessionExecutionDeadlineMs(sessionId, { onSessionClock: true }),
    );
    manager.setExpiryReleaseExecutionCanceller((sessionId, cancellation, query) => {
      void tracker.cancelDeviceSessionExecutions(sessionId, cancellation, {
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

// #11290: a call's start is stamped on the wall clock, the idle deadline it is judged against is
// on the session clock. The start is judged on the session clock too, so a wall step neither
// admits a call that began after the idle deadline nor refuses one that began before it.
describe("a new call's start is judged on the session clock (#11290)", () => {
  const IDLE_MS = 120_000;
  let timer: FakeTimer;
  let tracker: ExecutionTracker;
  let manager: SessionManager;
  const savedEnv = process.env[SESSION_IDLE_TIMEOUT_ENV];

  beforeEach(async () => {
    delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    timer = new FakeTimer();
    tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager.stopCleanupTimer();
    tracker.setSessionClockOffsetProvider(
      (wallNowMs = timer.now()) => manager.sessionNow() - wallNowMs,
    );
    manager.setActiveSessionExecutionChecker((sessionId, query) =>
      tracker.hasActiveSessionUuidExecutions(sessionId, query),
    );
    manager.setSessionExecutionDeadlineLookup((sessionId) =>
      tracker.getLatestSessionExecutionDeadlineMs(sessionId, { onSessionClock: true }),
    );
    manager.setExpiryReleaseExecutionCanceller((sessionId, cancellation, query) => {
      void tracker.cancelDeviceSessionExecutions(sessionId, cancellation, {
        excludeExecutionId: query.excludeExecutionId,
      });
    });
    await manager.createSession(SESSION, DEVICE, "android");
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    } else {
      process.env[SESSION_IDLE_TIMEOUT_ENV] = savedEnv;
    }
  });

  /** The metadata the server hands the session manager for a tracked execution. */
  const metadataOf = sessionExecutionMetadataOf;

  function admission(execution: SessionExecutionMetadata): "admitted" | "expired" | "refused" {
    try {
      return manager.getSessionForNewExecution(SESSION, execution) ? "admitted" : "expired";
    } catch {
      return "refused";
    }
  }

  function startLongCallHoldingTheSession(): void {
    const earlier = tracker.startExecution("provision", undefined, SESSION);
    const deadline = timer.now() + 600_000;
    tracker.setExecutionDeadline(earlier.id, () => deadline);
  }

  for (const step of [0, -HOUR_MS]) {
    it(`admits a call begun after the idle deadline while timely control work holds the session, wall step ${step}`, () => {
      startLongCallHoldingTheSession();
      timer.advanceTime(IDLE_MS + 80_000);
      manager.cleanupExpiredSessions();
      timer.stepWallClock(step);

      const late = tracker.startExecution("tapOn", undefined, SESSION);

      expect(admission(metadataOf(late))).toBe("admitted");
      expect(manager.getSession(SESSION)?.expiresAt).toBe(IDLE_MS);
    });

    it(`two calls both begun after the deadline cannot admit each other, wall step ${step}`, async () => {
      timer.advanceTime(IDLE_MS + 1);
      timer.stepWallClock(step);
      const first = tracker.startExecution("tapOn", undefined, SESSION);
      const second = tracker.startExecution("tapOn", undefined, SESSION);
      const admissionA = manager.admitIssuedSessionForAutomation(SESSION, metadataOf(first));
      const admissionB = manager.admitIssuedSessionForAutomation(SESSION, metadataOf(second));
      const outcomes = await Promise.allSettled([admissionA, admissionB]);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") {
          throw new Error("A late call was admitted");
        }
        expect(outcome.reason).toBeInstanceOf(TerminalSessionError);
        expect(outcome.reason).toMatchObject({
          release: { releaseReason: "cleanup-expired", terminal: true },
        });
      }
      expect(second.abortController.signal.aborted).toBe(true);
      expect(sessionReleasedDuringCallPayload(second.cancelReason)).toMatchObject({
        error: { reason: "cleanup-expired", idle: true },
      });
      await manager.waitForSessionRelease(SESSION);
      expect(manager.getSession(SESSION)).toBeNull();
    });

    it(`expires the session for a call begun after the idle deadline, wall step ${step}`, () => {
      timer.advanceTime(IDLE_MS + 10_000);
      timer.stepWallClock(step);

      const late = tracker.startExecution("tapOn", undefined, SESSION);

      expect(admission(metadataOf(late))).toBe("expired");
    });

    it(`judges a start reported without its session-clock stamp on the session clock, wall step ${step}`, () => {
      timer.advanceTime(IDLE_MS + 10_000);
      timer.stepWallClock(step);

      const late = tracker.startExecution("tapOn", undefined, SESSION);

      expect(admission({ executionId: late.id, startTime: late.startTime })).toBe("expired");
    });
  }

  it("a control call begun exactly at the deadline admits later non-owner control without stamping activity", async () => {
    timer.advanceTime(IDLE_MS);
    const timely = tracker.startExecution("tapOn", undefined, SESSION);
    timer.advanceTime(1);
    const late = tracker.startExecution("tapOn", undefined, SESSION);
    const session = await manager.admitIssuedSessionForAutomation(SESSION, metadataOf(late), {
      access: "non-owner-control",
    });
    expect(session?.expiresAt).toBe(IDLE_MS);
    expect(session?.lastUsedAt).toBe(0);
    tracker.endExecution(timely.id);
    tracker.endExecution(late.id);
  });

  it("a late control call with only an earlier read in flight expires and cuts that read", async () => {
    const read = tracker.startExecution("observe", undefined, SESSION);
    tracker.markDeviceReadCall(read.id, read.toolName);
    timer.advanceTime(IDLE_MS + 1);
    const late = tracker.startExecution("tapOn", undefined, SESSION);
    const pending = manager.admitIssuedSessionForAutomation(SESSION, metadataOf(late));
    await expect(pending).rejects.toBeInstanceOf(TerminalSessionError);
    await expect(pending).rejects.toMatchObject({ release: { releaseReason: "cleanup-expired" } });
    expect(sessionReleasedDuringCallPayload(read.cancelReason)).toMatchObject({
      error: { reason: "cleanup-expired", idle: true },
    });
    await manager.waitForSessionRelease(SESSION);
  });

  it("a derived session counts timely base control work on the session clock, never recovery alone", () => {
    const derived = `${SESSION}:tablet`;
    const earlier = tracker.startExecution("tapOn", undefined, SESSION);
    timer.stepWallClock(-HOUR_MS);
    timer.advanceTime(IDLE_MS + 1);
    const late = tracker.startExecution("tapOn", undefined, derived);
    const managerPort = {
      getDeviceLabels: (id: string) => (id === SESSION ? { tablet: derived } : undefined),
    };
    const query = {
      sessionClockStartedAtOrBefore: IDLE_MS,
      excludeExecutionId: late.id,
      excludeReads: true,
    };
    expect(
      hasActiveSessionExecution(
        tracker,
        managerPort,
        { isSessionRecoveryInFlight: () => false },
        derived,
        query,
      ),
    ).toBe(true);
    tracker.endExecution(earlier.id);
    expect(
      hasActiveSessionExecution(
        tracker,
        managerPort,
        { isSessionRecoveryInFlight: () => true },
        derived,
        query,
      ),
    ).toBe(false);
  });

  it("admits a call begun before the idle deadline after a forward wall step", () => {
    // Where the monotonic clock includes sleep (Linux, Windows) the session clock ignores a forward step.
    timer.simulateSleepCountingMonotonicClock();
    timer.advanceTime(IDLE_MS - 20_000);
    manager.sessionNow(); // the daemon samples the session clock continuously
    timer.stepWallClock(HOUR_MS);
    const timely = tracker.startExecution("tapOn", undefined, SESSION);

    // Its admission is judged only after the deadline passed.
    timer.advanceTime(30_000);

    expect(admission(metadataOf(timely))).toBe("admitted");
  });

  it("keeps a call's start where it was stamped when the wall clock steps before its admission", () => {
    timer.advanceTime(IDLE_MS - 20_000);
    const timely = tracker.startExecution("tapOn", undefined, SESSION);
    timer.stepWallClock(-HOUR_MS);
    timer.advanceTime(30_000);

    expect(tracker.getSessionClockStartTime(timely.id)).toBe(IDLE_MS - 20_000);
    expect(admission(metadataOf(timely))).toBe("admitted");
  });

  it("a start carried by the tool-selection context keeps its session-clock stamp", async () => {
    // A plan's label registration reads the call's metadata back from the ambient context
    // (planExecutionOrchestrator -> registerDeviceLabelMap -> createToolExecutionContext).
    timer.advanceTime(IDLE_MS - 20_000);
    const timely = tracker.startExecution("executePlan", undefined, SESSION);
    timer.stepWallClock(-HOUR_MS);
    timer.advanceTime(30_000);

    const outcome = await runWithToolSelectionContext(
      { execution: sessionExecutionMetadataOf(timely) },
      async () => admission(getToolSelectionContext()!.execution!),
    );

    expect(outcome).toBe("admitted");
  });

  it("a start whose stamp was dropped is judged late after a backward wall step", () => {
    // Why every producer must carry the stamp: the wall-clock start alone lands an hour late.
    timer.advanceTime(IDLE_MS - 20_000);
    const timely = tracker.startExecution("executePlan", undefined, SESSION);
    timer.stepWallClock(-HOUR_MS);
    timer.advanceTime(30_000);

    expect(admission({ executionId: timely.id, startTime: timely.startTime })).toBe("expired");
  });

  it("reports no session-clock start for an execution it does not track", () => {
    expect(tracker.getSessionClockStartTime("unknown")).toBeUndefined();
  });
});
