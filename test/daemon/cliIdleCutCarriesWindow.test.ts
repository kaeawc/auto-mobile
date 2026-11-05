import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { sessionReleasedDuringCallPayload } from "../../src/daemon/deviceSessionResult";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import { ExecutionTracker } from "../../src/daemon/executionTracker";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

// #16939: a call cut by a cli-idle-timeout release is told the idle window its session had. The
// window reaches the cancellation only through SessionLeaseExpiry.cancelExecutionsCutByRelease,
// so this drives a real in-flight call through a real idle expiry by SessionHeartbeatMonitor,
// whose reap cuts calls and then releases as the daemon's does (DaemonSessions,
// `cutCallsLearnRelease`), with the execution tracker wired as the daemon wires it.

const SESSION = "cli-idle-cut-session";
const DEVICE = "emulator-5554";
const WINDOW_MS = 300_000;

const ENV_KEYS = [
  "AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
  "AUTO_MOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("a cli-idle-timeout cut carries the session's idle window (#16939)", () => {
  let timer: FakeTimer;
  let tracker: ExecutionTracker;
  let manager: SessionManager;

  beforeEach(async () => {
    clearEnv();
    timer = new FakeTimer();
    tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager.setActiveSessionExecutionChecker(
      (sessionId, query) =>
        !query?.recoveryOnly && tracker.hasActiveSessionUuidExecutions(sessionId, query),
    );
    manager.setSessionExecutionDeadlineLookup((sessionId) =>
      tracker.getLatestSessionExecutionDeadlineMs(sessionId),
    );
    manager.setExpiryReleaseExecutionCanceller((sessionId, cancellation, query) => {
      void tracker.cancelDeviceSessionExecutions(sessionId, cancellation, {
        excludeExecutionId: query.excludeExecutionId,
      });
    });
    await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: 60_000 });
    manager.adoptCliLivenessPolicy(SESSION, WINDOW_MS);
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    clearEnv();
  });

  it("the idle release cuts the in-flight call with details.idleTimeoutMs", async () => {
    const monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        manager.cancelExecutionsCutByRelease(sessionId, reason);
        await manager.releaseSession(sessionId, reason);
      },
      { timer },
    );
    const call = tracker.startExecution("tapOn", undefined, SESSION);

    timer.advanceTime(WINDOW_MS + 1);
    await monitor.tick();

    expect(call.abortController.signal.aborted).toBe(true);
    const cut = call.cancelReason;
    expect(cut).toBeInstanceOf(SessionReleasedDuringCallError);
    expect((cut as SessionReleasedDuringCallError).details).toEqual({
      sessionUuid: SESSION,
      reason: "cli-idle-timeout",
      idle: true,
      idleTimeoutMs: WINDOW_MS,
    });
    expect(sessionReleasedDuringCallPayload(cut)?.error).toMatchObject({
      reason: "cli-idle-timeout",
      idleTimeoutMs: WINDOW_MS,
    });
  });
});
