import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SessionHeartbeatMonitor,
  UNSETTLED_EXECUTION_VETO_CEILING_MS,
} from "../../src/daemon/SessionHeartbeatMonitor";
import { UNSETTLED_EXECUTION_DEADLINE_GRACE_MS } from "../../src/daemon/unsettledExecutionVeto";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { MAX_CALLER_MCP_REQUEST_TIMEOUT_MS } from "../../src/daemon/mcpRequestTimeout";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #10663: an active execution vetoes every automatic release of its session (#5343: never reap
// mid-call), and nothing bounded that veto. A tools/call handler that never settles after its
// owner disconnected held the session and its device for as long as it stayed unsettled. The
// heartbeat monitor now releases such a session once the veto has outlasted any request deadline.

const SESSION = "veto-session";
const DEVICE = "emulator-5554";
const OWNER = "harness-a";
const LEASE_MS = SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;
/** When a silent owner's session is first stale: past lease plus suspect grace. */
const STALE_AFTER_MS = LEASE_MS + SUSPECT_GRACE_MS + 1;

describe("unsettled-execution veto ceiling (#10663)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let tracker: ExecutionTracker;
  let monitor: SessionHeartbeatMonitor;
  let reaped: string[];

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    tracker = new ExecutionTracker(timer, new FakeIdGenerator(["hung-call", "next-call"]));
    const hasActiveExecutions = (sessionId: string): boolean =>
      tracker.hasActiveSessionUuidExecutions(sessionId);
    // As in the daemon: the same checker gates idle expiry and the monitor.
    sessionManager.setActiveSessionExecutionChecker(hasActiveExecutions);
    reaped = [];
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      {
        hasActiveExecutions,
        latestExecutionDeadlineMs: (sessionId) =>
          tracker.getLatestSessionExecutionDeadlineMs(sessionId),
      },
      async (sessionId, reason) => {
        reaped.push(reason);
        await sessionManager.releaseSession(sessionId, reason);
      },
      timer,
    );
    await sessionManager.createSession(SESSION, DEVICE, "android", 60_000);
    expect(await sessionManager.claimLivenessOwnership(SESSION, OWNER)).toBe("claimed");
    sessionManager.recordHeartbeat(SESSION);
  });

  afterEach(async () => {
    await monitor.stop();
    sessionManager.stopCleanupTimer();
  });

  test("the ceiling is the longest deadline any request can be given", () => {
    expect(UNSETTLED_EXECUTION_VETO_CEILING_MS).toBe(MAX_CALLER_MCP_REQUEST_TIMEOUT_MS);
  });

  test("a call that never settles after its owner went silent holds the session only up to the ceiling", async () => {
    // The owner's last call never settles; then the owner disconnects and stops heartbeating.
    tracker.startExecution("tapOn", undefined, SESSION);
    timer.setCurrentTime(STALE_AFTER_MS);
    await monitor.tick();
    expect(reaped).toEqual([]);

    timer.setCurrentTime(STALE_AFTER_MS + UNSETTLED_EXECUTION_VETO_CEILING_MS - 1);
    await monitor.tick();
    expect(reaped).toEqual([]);
    expect(sessionManager.getSession(SESSION)).not.toBeNull();

    timer.setCurrentTime(STALE_AFTER_MS + UNSETTLED_EXECUTION_VETO_CEILING_MS);
    await monitor.tick();

    expect(reaped).toEqual(["heartbeat-timeout"]);
    expect(sessionManager.getSession(SESSION)).toBeNull();
    // The hung call is still tracked: the release did not wait for it to settle.
    expect(tracker.hasActiveSessionUuidExecutions(SESSION)).toBe(true);
  });

  test("a call that settles inside the ceiling releases the stale session at the next scan", async () => {
    const execution = tracker.startExecution("tapOn", undefined, SESSION);
    timer.setCurrentTime(STALE_AFTER_MS);
    await monitor.tick();
    expect(reaped).toEqual([]);

    tracker.endExecution(execution.id);
    timer.advanceTime(1);
    await monitor.tick();

    expect(reaped).toEqual(["heartbeat-timeout"]);
  });

  test("the veto clock restarts once the session stops being stale", async () => {
    tracker.startExecution("tapOn", undefined, SESSION);
    timer.setCurrentTime(STALE_AFTER_MS);
    await monitor.tick();

    // The owner comes back: the session is live again and the veto record is dropped.
    sessionManager.recordHeartbeat(SESSION);
    await monitor.tick();
    const returnedAt = timer.now();

    // Silent again: a fresh veto window starts when it next goes stale, not at the first one.
    timer.setCurrentTime(returnedAt + STALE_AFTER_MS);
    await monitor.tick();
    timer.setCurrentTime(STALE_AFTER_MS + UNSETTLED_EXECUTION_VETO_CEILING_MS);
    await monitor.tick();
    expect(reaped).toEqual([]);

    timer.setCurrentTime(returnedAt + STALE_AFTER_MS + UNSETTLED_EXECUTION_VETO_CEILING_MS);
    await monitor.tick();
    expect(reaped).toEqual(["heartbeat-timeout"]);
  });

  test("a call with a request deadline holds the stale session only until that deadline plus grace (#10712)", async () => {
    const execution = tracker.startExecution("tapOn", undefined, SESSION);
    const deadlineMs = STALE_AFTER_MS + 60_000;
    tracker.setExecutionDeadline(execution.id, () => deadlineMs);
    timer.setCurrentTime(STALE_AFTER_MS);
    await monitor.tick();

    timer.setCurrentTime(deadlineMs + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS - 1);
    await monitor.tick();
    expect(reaped).toEqual([]);

    timer.setCurrentTime(deadlineMs + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS);
    await monitor.tick();
    expect(reaped).toEqual(["heartbeat-timeout"]);
  });

  test("a call without a deadline beside one with a deadline keeps the fallback ceiling (#10712)", async () => {
    const bounded = tracker.startExecution("tapOn", undefined, SESSION);
    tracker.setExecutionDeadline(bounded.id, () => STALE_AFTER_MS + 60_000);
    tracker.startExecution("observe", undefined, SESSION);
    timer.setCurrentTime(STALE_AFTER_MS);
    await monitor.tick();

    timer.setCurrentTime(STALE_AFTER_MS + UNSETTLED_EXECUTION_VETO_CEILING_MS - 1);
    await monitor.tick();
    expect(reaped).toEqual([]);
  });
});
