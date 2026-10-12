import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import { SESSION_IDLE_TIMEOUT_ENV } from "../../src/daemon/sessionLivenessWindows";
import { UNSETTLED_EXECUTION_DEADLINE_GRACE_MS } from "../../src/daemon/unsettledExecutionVeto";
import { sessionReleasedDuringCallPayload } from "../../src/server/deviceSessionResult";
import { ExecutionTracker, type ActiveExecution } from "../../src/server/executionTracker";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #11381 items 1-2: reads neither hold idle release nor bound a control call's veto.
const SESSION = "idle-read-session";
const DEVICE = "emulator-5554";

describe("idle release ignores in-flight reads (#11381)", () => {
  let timer: FakeTimer;
  let tracker: ExecutionTracker;
  let manager: SessionManager;
  let idleDeadline: number;
  let started: ActiveExecution[];
  let releases: string[];
  const savedEnv = process.env[SESSION_IDLE_TIMEOUT_ENV];

  beforeEach(async () => {
    delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    timer = new FakeTimer();
    tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    started = [];
    releases = [];
    manager.setActiveSessionExecutionChecker((sessionId, query) =>
      tracker.hasActiveSessionUuidExecutions(sessionId, query),
    );
    manager.setSessionExecutionDeadlineLookup((sessionId, query) =>
      tracker.getLatestSessionExecutionDeadlineMs(sessionId, query),
    );
    manager.setExpiryReleaseExecutionCanceller((sessionId, cancellation, query) => {
      void tracker.cancelDeviceSessionExecutions(sessionId, cancellation, {
        excludeExecutionId: query.excludeExecutionId,
      });
    });
    manager.onSessionRelease((_sessionId, _deviceId, reason) => releases.push(reason));
    const session = await manager.createSession(SESSION, DEVICE, "android");
    expect(session.livenessPolicy).toBe("heartbeat");
    idleDeadline = session.expiresAt;
  });

  afterEach(() => {
    for (const execution of started) {
      tracker.endExecution(execution.id);
    }
    manager.stopCleanupTimer();
    if (savedEnv === undefined) {
      delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    } else {
      process.env[SESSION_IDLE_TIMEOUT_ENV] = savedEnv;
    }
  });

  function startCall(tool: string): ActiveExecution {
    const call = tracker.startExecution(tool, undefined, SESSION);
    started.push(call);
    return call;
  }

  function startRead(kind: "device" | "inventory", deadline = idleDeadline + 120_000) {
    const read = startCall(kind === "device" ? "observe" : "listDevices");
    if (kind === "device") {
      tracker.markDeviceReadCall(read.id, read.toolName);
    } else {
      tracker.markReadOnlySessionAccess(read.id);
    }
    tracker.setExecutionDeadline(read.id, () => deadline);
    return read;
  }

  function expectCutRead(read: ActiveExecution, reason: string): void {
    expect(read.abortController.signal.aborted).toBe(true);
    expect(read.abortController.signal.reason).toBe(read.cancelReason);
    expect(sessionReleasedDuringCallPayload(read.cancelReason)).toMatchObject({
      error: {
        code: "session_ownership_lost",
        sessionUuid: SESSION,
        reason,
        retryable: false,
        nextAction: "acquire_new_session",
      },
    });
  }

  for (const kind of ["device", "inventory"] as const) {
    for (const [path, reason] of [
      ["sweep", "cleanup-expired"],
      ["lazy lookup", "cleanup-expired"],
    ] as const) {
      test(`${path}: cuts a ${kind} read at the first instant past idle`, async () => {
        const read = startRead(kind);
        timer.setCurrentTime(idleDeadline + 1);
        if (path === "sweep") {
          manager.cleanupExpiredSessions();
        } else {
          expect(manager.getSession(SESSION)).toBeNull();
        }
        await manager.waitForSessionRelease(SESSION);
        expect(releases).toEqual([reason]);
        expectCutRead(read, reason);
        expect(manager.getSession(SESSION)).toBeNull();
      });
    }

    test(`a ${kind} read's later deadline never bounds a control veto`, async () => {
      const control = startCall("tapOn");
      const deadline = idleDeadline + 60_000;
      tracker.setExecutionDeadline(control.id, () => deadline);
      const read = startRead(kind, deadline + 60_000);
      timer.setCurrentTime(deadline + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS - 1);
      manager.cleanupExpiredSessions();
      await manager.waitForSessionRelease(SESSION);
      expect(releases).toEqual([]);
      expect(control.abortController.signal.aborted).toBe(false);
      expect(read.abortController.signal.aborted).toBe(false);

      timer.setCurrentTime(deadline + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS);
      manager.cleanupExpiredSessions();
      await manager.waitForSessionRelease(SESSION);
      expect(releases).toEqual(["cleanup-expired"]);
      expect(control.abortController.signal.aborted).toBe(true);
      expectCutRead(read, "cleanup-expired");
    });

    test(`a late read has no held device when only a ${kind} read is in flight`, () => {
      startRead(kind);
      timer.setCurrentTime(idleDeadline + 1);
      const arriving = startRead(kind);
      expect(
        manager.deviceHeldForLateRead(SESSION, {
          executionId: arriving.id,
          startTime: arriving.startTime,
        }),
      ).toBeUndefined();
    });

    test(`late control admission with only a ${kind} read gets the terminal idle refusal`, async () => {
      const read = startRead(kind);
      timer.setCurrentTime(idleDeadline + 1);
      const arriving = startCall("tapOn");
      const execution = { executionId: arriving.id, startTime: arriving.startTime };
      const refusal = await manager
        .getOrCreateSession(SESSION, undefined, undefined, execution)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refusal).toBeInstanceOf(TerminalSessionError);
      expect((refusal as TerminalSessionError).release).toMatchObject({
        sessionId: SESSION,
        releaseReason: "cleanup-expired",
        terminal: true,
      });
      await manager.waitForSessionRelease(SESSION);
      expect(releases).toEqual(["cleanup-expired"]);
      expectCutRead(read, "cleanup-expired");
      expect(arriving.abortController.signal.aborted).toBe(false);
    });
  }
});
