import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  SessionManager,
  TerminalSessionError,
  SessionHeldByRecoveryError,
  type SessionExecutionMetadata,
} from "../../src/daemon/sessionManager";
import { DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS } from "../../src/models/deviceAcquisitionRefusals";
import { hasActiveSessionExecution } from "../../src/daemon/toolCallActivity";
import { sessionReleasedDuringCallPayload } from "../../src/daemon/deviceSessionResult";
import { SESSION_IDLE_TIMEOUT_ENV } from "../../src/daemon/wire/sessionLivenessWindows";
import {
  ExecutionTracker,
  sessionExecutionMetadataOf,
  type ActiveExecution,
} from "../../src/daemon/executionTracker";
import {
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import {
  UNSETTLED_EXECUTION_VETO_CEILING_MS,
  UNSETTLED_EXECUTION_DEADLINE_GRACE_MS,
} from "../../src/daemon/unsettledExecutionVeto";

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
    manager.setActiveSessionExecutionChecker(
      (sessionId, query) =>
        !query?.recoveryOnly && tracker.hasActiveSessionUuidExecutions(sessionId, query),
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
  let releases: string[];
  const savedEnv = process.env[SESSION_IDLE_TIMEOUT_ENV];

  beforeEach(async () => {
    delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    timer = new FakeTimer();
    tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager.stopCleanupTimer();
    releases = [];
    manager.onSessionRelease((_sessionId, _deviceId, reason) => releases.push(reason));
    tracker.setSessionClockOffsetProvider(
      (wallNowMs = timer.now()) => manager.sessionNow() - wallNowMs,
    );
    manager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(
        {
          tracker,
          sessionManager: manager,
          devicePool: { isSessionRecoveryInFlight: () => false },
        },
        sessionId,
        query,
      ),
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

  function startLongCallHoldingTheSession(): ActiveExecution {
    const earlier = tracker.startExecution("provision", undefined, SESSION);
    const deadline = timer.now() + 600_000;
    tracker.setExecutionDeadline(earlier.id, () => deadline);
    return earlier;
  }

  for (const step of [0, -HOUR_MS]) {
    for (const condition of ["aborted", "past request deadline"] as const) {
      it(`admission liveness refuses late control behind timely work ${condition}, wall step ${step}`, async () => {
        const earlier = startLongCallHoldingTheSession();
        timer.stepWallClock(step);
        timer.advanceTime(condition === "aborted" ? IDLE_MS + 1 : 600_001);
        if (condition === "aborted") {
          earlier.abortController.abort();
        }
        const read = tracker.startExecution("observe", undefined, SESSION);
        tracker.markDeviceReadCall(read.id, read.toolName);
        expect(manager.deviceHeldForLateRead(SESSION, metadataOf(read))).toBe(DEVICE);
        await expect(
          manager.admitIssuedSessionForAutomation(SESSION, metadataOf(read), {
            access: "read-only",
          }),
        ).resolves.toBeUndefined();
        expect(manager.getAllSessions()[0]?.expiresAt).toBe(IDLE_MS);
        expect(releases).toEqual([]);
        const late = tracker.startExecution("tapOn", undefined, SESSION);
        const pending = manager.admitIssuedSessionForAutomation(SESSION, metadataOf(late));
        await expect(pending).rejects.toBeInstanceOf(TerminalSessionError);
        await expect(pending).rejects.toMatchObject({
          release: { releaseReason: "cleanup-expired" },
        });
        expect(sessionReleasedDuringCallPayload(earlier.cancelReason)).toMatchObject({
          error: { reason: "cleanup-expired", idle: true },
        });
        expect(late.abortController.signal.aborted).toBe(false);
        await manager.waitForSessionRelease(SESSION);
        expect(releases).toEqual(["cleanup-expired"]);
        expect(manager.getSession(SESSION)).toBeNull();
        tracker.endExecution(late.id);
      });
    }

    it(`admission liveness bounds periodic late control behind wedged dated work, wall step ${step}`, async () => {
      // Ends at the first control call after the wedged call stops being live; with no call,
      // the sweep ends it by the wedged call's request deadline + 10 s grace.
      const earlier = startLongCallHoldingTheSession();
      timer.stepWallClock(step);
      let expiresAt = IDLE_MS;
      for (let attempt = 0; attempt < 5; attempt++) {
        timer.advanceTime(IDLE_MS + 1);
        const late = tracker.startExecution("tapOn", undefined, SESSION);
        if (attempt < 4) {
          expect(admission(metadataOf(late))).toBe("admitted");
          await manager.admitIssuedSessionForAutomation(SESSION, metadataOf(late));
          const refreshed = manager.getAllSessions()[0]!.expiresAt;
          expect(refreshed).toBeGreaterThan(expiresAt);
          expect(refreshed).toBe(manager.sessionNow() + IDLE_MS);
          expiresAt = refreshed;
        } else {
          const pending = manager.admitIssuedSessionForAutomation(SESSION, metadataOf(late));
          await expect(pending).rejects.toBeInstanceOf(TerminalSessionError);
          await expect(pending).rejects.toMatchObject({
            release: { releaseReason: "cleanup-expired" },
          });
        }
        tracker.endExecution(late.id);
      }
      await manager.waitForSessionRelease(SESSION);
      expect(releases).toEqual(["cleanup-expired"]);
      expect(manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason).toBe("cleanup-expired");
      expect(manager.getSession(SESSION)).toBeNull();
      expect(sessionReleasedDuringCallPayload(earlier.cancelReason)).toMatchObject({
        error: { reason: "cleanup-expired", idle: true },
      });
    });

    it(`with no late control call, the sweep ends wedged work at its deadline plus grace, wall step ${step}`, async () => {
      const earlier = startLongCallHoldingTheSession();
      timer.stepWallClock(step);
      timer.advanceTime(600_000 + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS - 1);
      manager.cleanupExpiredSessions();
      expect(releases).toEqual([]);
      expect(earlier.abortController.signal.aborted).toBe(false);
      expect(manager.getAllSessions()[0]?.expiresAt).toBe(IDLE_MS);
      timer.advanceTime(1);
      manager.cleanupExpiredSessions();
      await manager.waitForSessionRelease(SESSION);
      expect(releases).toEqual(["cleanup-expired"]);
      expect(manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason).toBe("cleanup-expired");
      expect(manager.getSession(SESSION)).toBeNull();
      expect(sessionReleasedDuringCallPayload(earlier.cancelReason)).toMatchObject({
        error: { reason: "cleanup-expired", idle: true },
      });
    });

    it(`admission liveness of undated timely work ends 30 min after its own start, wall step ${step}`, async () => {
      const earlier = tracker.startExecution("provision", undefined, SESSION);
      timer.stepWallClock(step);
      timer.advanceTime(UNSETTLED_EXECUTION_VETO_CEILING_MS);
      const atCeiling = tracker.startExecution("tapOn", undefined, SESSION);
      expect(admission(metadataOf(atCeiling))).toBe("admitted");
      tracker.endExecution(atCeiling.id);
      timer.advanceTime(1);
      const afterCeiling = tracker.startExecution("tapOn", undefined, SESSION);
      const pending = manager.admitIssuedSessionForAutomation(SESSION, metadataOf(afterCeiling));
      await expect(pending).rejects.toBeInstanceOf(TerminalSessionError);
      await expect(pending).rejects.toMatchObject({
        release: { releaseReason: "cleanup-expired" },
      });
      expect(sessionReleasedDuringCallPayload(earlier.cancelReason)).toMatchObject({
        error: { reason: "cleanup-expired", idle: true },
      });
      await manager.waitForSessionRelease(SESSION);
      expect(releases).toEqual(["cleanup-expired"]);
    });

    it(`admits a call begun after the idle deadline while timely control work holds the session, wall step ${step}`, async () => {
      startLongCallHoldingTheSession();
      timer.advanceTime(IDLE_MS + 80_000);
      manager.cleanupExpiredSessions();
      timer.stepWallClock(step);

      const late = tracker.startExecution("tapOn", undefined, SESSION);

      expect(admission(metadataOf(late))).toBe("admitted");
      expect(manager.getSession(SESSION)?.expiresAt).toBe(IDLE_MS);
      const read = tracker.startExecution("observe", undefined, SESSION);
      tracker.markDeviceReadCall(read.id, read.toolName);
      expect(manager.deviceHeldForLateRead(SESSION, metadataOf(read))).toBe(DEVICE);
      await expect(
        manager.admitIssuedSessionForAutomation(SESSION, metadataOf(read), { access: "read-only" }),
      ).resolves.toBeUndefined();
      expect(manager.getAllSessions()[0]?.expiresAt).toBe(IDLE_MS);
      expect(releases).toEqual([]);
    });

    it(`two calls both begun after the deadline cannot admit each other, wall step ${step}`, async () => {
      timer.advanceTime(IDLE_MS + 1);
      timer.stepWallClock(step);
      const first = tracker.startExecution("tapOn", undefined, SESSION);
      const second = tracker.startExecution("tapOn", undefined, SESSION);
      const read = tracker.startExecution("observe", undefined, SESSION);
      tracker.markDeviceReadCall(read.id, read.toolName);
      expect(manager.deviceHeldForLateRead(SESSION, metadataOf(read))).toBe(DEVICE);
      await expect(
        manager.admitIssuedSessionForAutomation(SESSION, metadataOf(read), { access: "read-only" }),
      ).resolves.toBeUndefined();
      expect(manager.hasSession(SESSION)).toBe(true);
      expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
      expect(manager.getAllSessions()[0]?.expiresAt).toBe(IDLE_MS);
      expect(releases).toEqual([]);
      const admissionA = manager.admitIssuedSessionForAutomation(SESSION, metadataOf(first));
      const admissionB = manager.admitIssuedSessionForAutomation(SESSION, metadataOf(second));
      const outcomes = await Promise.allSettled([admissionA, admissionB]);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") {
          throw new Error("A late call was admitted");
        }
        expect(outcome.reason).toBeInstanceOf(TerminalSessionError);
        expect(outcome.reason).toMatchObject({ release: { releaseReason: "cleanup-expired" } });
      }
      expect(first.abortController.signal.aborted).toBe(false);
      expect(sessionReleasedDuringCallPayload(second.cancelReason)).toMatchObject({
        error: { reason: "cleanup-expired", idle: true },
      });
      await manager.waitForSessionRelease(SESSION);
      expect(releases).toEqual(["cleanup-expired"]);
      tracker.endExecution(first.id);
      tracker.endExecution(second.id);
      manager.cleanupExpiredSessions();
      await manager.waitForSessionRelease(SESSION);
      expect(manager.getSession(SESSION)).toBeNull();
      expect(releases).toEqual(["cleanup-expired"]);
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

  for (const step of [0, -HOUR_MS]) {
    for (const access of ["control", "read-only"] as const) {
      it(`recovery alone preserves the held session for a late ${access} call without admitting it, wall step ${step}`, async () => {
        let recovering = true;
        manager.setActiveSessionExecutionChecker((sessionId, query) =>
          hasActiveSessionExecution(
            {
              tracker,
              sessionManager: manager,
              devicePool: { isSessionRecoveryInFlight: () => recovering },
            },
            sessionId,
            query,
          ),
        );
        timer.stepWallClock(step);
        timer.advanceTime(IDLE_MS + 1);
        const late = tracker.startExecution(
          access === "control" ? "tapOn" : "observe",
          undefined,
          SESSION,
        );
        if (access === "read-only") {
          tracker.markDeviceReadCall(late.id, late.toolName);
          expect(manager.deviceHeldForLateRead(SESSION, metadataOf(late))).toBe(DEVICE);
          await expect(
            manager.admitIssuedSessionForAutomation(SESSION, metadataOf(late), { access }),
          ).resolves.toBeUndefined();
        } else {
          const pending = manager.admitIssuedSessionForAutomation(SESSION, metadataOf(late));
          await expect(pending).rejects.toBeInstanceOf(SessionHeldByRecoveryError);
          await expect(pending).rejects.toMatchObject({
            name: "SessionHeldByRecoveryError",
            code: "session_held_by_recovery",
            retryable: true,
            retryAfterMs: DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
            sessionUuid: SESSION,
            deviceId: DEVICE,
          });
        }
        manager.cleanupExpiredSessions();
        expect(manager.hasSession(SESSION)).toBe(true);
        expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
        expect(manager.getAllSessions()[0]?.expiresAt).toBe(IDLE_MS);
        expect(releases).toEqual([]);
        expect(late.abortController.signal.aborted).toBe(false);
        if (access === "control") {
          recovering = false;
          const pending = manager.admitIssuedSessionForAutomation(SESSION, metadataOf(late));
          await expect(pending).rejects.toBeInstanceOf(TerminalSessionError);
          await expect(pending).rejects.toMatchObject({
            release: { releaseReason: "cleanup-expired" },
          });
          await manager.waitForSessionRelease(SESSION);
          expect(releases).toEqual(["cleanup-expired"]);
        }
      });
    }
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
        {
          tracker,
          sessionManager: managerPort,
          devicePool: { isSessionRecoveryInFlight: () => false },
        },
        derived,
        query,
      ),
    ).toBe(true);
    tracker.endExecution(earlier.id);
    expect(
      hasActiveSessionExecution(
        {
          tracker,
          sessionManager: managerPort,
          devicePool: { isSessionRecoveryInFlight: () => true },
        },
        derived,
        query,
      ),
    ).toBe(false);
    expect(
      hasActiveSessionExecution(
        {
          tracker,
          sessionManager: managerPort,
          devicePool: { isSessionRecoveryInFlight: () => true },
        },
        derived,
        { excludeExecutionId: late.id, excludeReads: true },
      ),
    ).toBe(true);
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
