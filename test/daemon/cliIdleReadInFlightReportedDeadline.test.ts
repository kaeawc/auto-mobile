import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleSessionInfo } from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { ExecutionTracker } from "../../src/daemon/executionTracker";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

// Idle-release reports and releasers agree: only control calls veto, for every liveness
// policy. An inventory or device read in flight never postpones the reported deadline (#11381).

const SESSION = "00000000-0000-4000-8000-000000000044";
const DEVICE = "emulator-5554";
const CLI_IDLE_MS = 120_000;

const drain = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

describe("cli-idle session with a read in flight past its idle deadline", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let reaped: Array<{ at: number; reason: string }>;
  let tracker: ExecutionTracker;
  let started: string[];

  beforeEach(async () => {
    timer = new FakeTimer();
    tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    started = [];
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager.setActiveSessionExecutionChecker((sessionId, query) =>
      tracker.hasActiveSessionUuidExecutions(sessionId, query),
    );
    manager.setSessionExecutionDeadlineLookup((sessionId, query) =>
      tracker.getLatestSessionExecutionDeadlineMs(sessionId, query),
    );
    reaped = [];
    monitor = new SessionHeartbeatMonitor(
      manager,
      // The monitor's probe is built with excludeReads: a read in flight is not seen.
      () => false,
      async (sessionId, reason) => {
        reaped.push({ at: timer.now(), reason });
        await manager.releaseSession(sessionId, reason);
      },
      { timer },
    );
    await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: 60_000 });
    manager.adoptCliLivenessPolicy(SESSION, CLI_IDLE_MS);
    monitor.start();
  });

  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
    for (const id of started) {
      tracker.endExecution(id);
    }
  });

  test("session-info does not report an idle release later than the monitor performs it", async () => {
    const lastToolActivityAt = manager.getSession(SESSION)!.lastUsedAt;
    startRead();

    await timer.advanceTimeAsync(CLI_IDLE_MS - 10_000, drain);
    const state = { getSessionManager: () => manager };
    const info = await handleSessionInfo(
      {
        id: "s1",
        type: "daemon_request",
        method: "daemon/sessionInfo",
        params: { sessionId: SESSION },
      },
      state,
      { getActiveDeviceSessionExecutionCount: () => 1 },
    );
    expect(info.success).toBe(true);
    const reportedIdleReleaseAt = info.result?.idleReleaseAt;
    if (typeof reportedIdleReleaseAt !== "number") {
      throw new Error("session-info reported no idleReleaseAt");
    }

    await timer.advanceTimeAsync(20_000, drain);

    // The monitor ignores the read: the session is gone at the idle deadline.
    expect(reaped.map((r) => r.reason)).toEqual(["cli-idle-timeout"]);
    // The daemon's own report must not promise a later release than the one it performs.
    expect(reportedIdleReleaseAt).toBeLessThanOrEqual(reaped[0].at);
    expect(reportedIdleReleaseAt).toBe(lastToolActivityAt + CLI_IDLE_MS);
  });

  test("a control call in flight still pushes the reported deadline out, by its own deadline only", () => {
    const controlDeadlineMs = timer.now() + CLI_IDLE_MS + 5_000;
    const lookups: Array<boolean | undefined> = [];
    const control = tracker.startExecution("tapOn", undefined, SESSION);
    started.push(control.id);
    tracker.setExecutionDeadline(control.id, () => controlDeadlineMs);
    startRead(controlDeadlineMs + 60_000);
    manager.setSessionExecutionDeadlineLookup((_sessionId, query) => {
      lookups.push(query?.excludeReads);
      return tracker.getLatestSessionExecutionDeadlineMs(SESSION, query);
    });

    expect(manager.getIdleReleaseExecutionVeto(SESSION)).toEqual({
      latestDeadlineMs: controlDeadlineMs,
    });
    expect(lookups).toEqual([true]);
  });

  function startRead(deadline?: number): void {
    const read = tracker.startExecution("observe", undefined, SESSION);
    started.push(read.id);
    tracker.markDeviceReadCall(read.id, read.toolName);
    if (deadline !== undefined) {
      tracker.setExecutionDeadline(read.id, () => deadline);
    }
  }

  test("a heartbeat-policy session's report excludes a read, as its idle sweep does", () => {
    manager.restoreHeartbeatLivenessPolicy(SESSION);
    startRead();

    expect(manager.getIdleReleaseExecutionVeto(SESSION)).toBeUndefined();
  });
});
