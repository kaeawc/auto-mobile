import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  UNSETTLED_EXECUTION_DEADLINE_GRACE_MS,
  UNSETTLED_EXECUTION_VETO_CEILING_MS,
} from "../../src/daemon/unsettledExecutionVeto";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  LEGACY_SESSION_IDLE_TIMEOUT_ENV,
  NO_HEARTBEAT_RELEASE_BUDGET_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
  SESSION_IDLE_TIMEOUT_ENV,
  SUSPECT_GRACE_MS,
  getSessionIdleTimeoutMs,
} from "../../src/daemon/sessionLivenessWindows";
import {
  DAEMON_BOUND_SESSION_REPLAY_TTL_MS,
  DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
} from "../../src/daemon/constants";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

// Owner decision 2026-10-08: a device session is released ~10 s after its owner's last heartbeat,
// and 2 min after the END of its last tool call while heartbeats keep arriving. A tool call in
// flight is activity and is never released mid-call.

const SESSION = "idle-window-session";
const DEVICE = "emulator-5554";

describe("session release windows (owner decision 2026-10-08)", () => {
  it("releases a silent owner within 10 s and keeps the proxy cadence well inside the lease", () => {
    expect(NO_HEARTBEAT_RELEASE_BUDGET_MS).toBe(10_000);
    expect(
      DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS +
        SUSPECT_GRACE_MS +
        DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
    ).toBeLessThanOrEqual(10_000);
    // One late or lost beat never lapses the lease; four must be missed before release.
    expect(
      DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS / PROXY_HEARTBEAT_INTERVAL_MS,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS) / PROXY_HEARTBEAT_INTERVAL_MS,
    ).toBeGreaterThanOrEqual(4);
    expect(SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS).toBe(DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS);
  });

  it("uses one 2-minute idle window for daemon idle, proxy replay and CLI idle", () => {
    expect(DEFAULT_SESSION_IDLE_TIMEOUT_MS).toBe(2 * 60_000);
    expect(DAEMON_BOUND_SESSION_REPLAY_TTL_MS).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
  });

  it("reads a positive integer idle override and ignores anything else (#10671)", () => {
    expect(getSessionIdleTimeoutMs({})).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(getSessionIdleTimeoutMs({ [SESSION_IDLE_TIMEOUT_ENV]: "60000" })).toBe(60_000);
    expect(getSessionIdleTimeoutMs({ [LEGACY_SESSION_IDLE_TIMEOUT_ENV]: " 45000 " })).toBe(45_000);
    for (const invalid of ["", "0", "-5", "1.5", "12abc", "abc", "1e9"]) {
      expect(getSessionIdleTimeoutMs({ [SESSION_IDLE_TIMEOUT_ENV]: invalid })).toBe(
        DEFAULT_SESSION_IDLE_TIMEOUT_MS,
      );
    }
  });
});

describe("the idle window counts from the end of the last tool call", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let persistence: FakeDeviceSessionPersistence;
  let inFlight: boolean;
  let releases: { at: number; reason: string }[];
  const savedEnv = process.env[SESSION_IDLE_TIMEOUT_ENV];

  beforeEach(async () => {
    delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    manager = new SessionManager(timer, persistence);
    inFlight = false;
    releases = [];
    manager.setActiveSessionExecutionChecker(() => inFlight);
    manager.onSessionRelease((_sessionId, _deviceId, reason) => {
      releases.push({ at: timer.now(), reason });
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

  const sweep = async (): Promise<void> => {
    manager.cleanupExpiredSessions();
    await Promise.resolve();
    await Promise.resolve();
  };

  it("a new session gets the 2-minute idle window", () => {
    const session = manager.getAllSessions()[0]!;
    expect(session.sessionTimeoutMs).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(session.expiresAt).toBe(session.createdAt + DEFAULT_SESSION_IDLE_TIMEOUT_MS);
  });

  it("never releases mid-call, and restarts the window when a call longer than it ends", async () => {
    await manager.getOrCreateSession(SESSION);
    inFlight = true;
    timer.setCurrentTime(3 * DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    await sweep();
    expect(manager.hasSession(SESSION)).toBe(true);

    inFlight = false;
    const endedAt = timer.now();
    manager.recordToolCallEnded(SESSION);
    expect(manager.getAllSessions()[0]!.expiresAt).toBe(endedAt + DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(manager.getAllSessions()[0]!.lastUsedAt).toBe(endedAt);
    await sweep();
    expect(manager.hasSession(SESSION)).toBe(true);

    timer.setCurrentTime(endedAt + DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    await sweep();
    expect(manager.hasSession(SESSION)).toBe(true);

    timer.setCurrentTime(endedAt + DEFAULT_SESSION_IDLE_TIMEOUT_MS + 1);
    await sweep();
    expect(releases.map((release) => release.reason)).toEqual(["cleanup-expired"]);
  });

  it("releases a session whose deadline-less call never settles once the veto outlives the ceiling (#10713)", async () => {
    await manager.getOrCreateSession(SESSION);
    inFlight = true;
    const idleDeadline = manager.getAllSessions()[0]!.expiresAt;

    timer.setCurrentTime(idleDeadline + UNSETTLED_EXECUTION_VETO_CEILING_MS - 1);
    await sweep();
    expect(manager.hasSession(SESSION)).toBe(true);
    expect(releases).toEqual([]);

    timer.setCurrentTime(idleDeadline + UNSETTLED_EXECUTION_VETO_CEILING_MS);
    await sweep();
    expect(releases.map((release) => release.reason)).toEqual(["cleanup-expired"]);
  });

  it("bounds a never-settling call's veto by its request deadline plus grace (#10712, #10713)", async () => {
    await manager.getOrCreateSession(SESSION);
    inFlight = true;
    const idleDeadline = manager.getAllSessions()[0]!.expiresAt;
    const requestDeadline = idleDeadline + 60_000;
    manager.setSessionExecutionDeadlineLookup(() => requestDeadline);

    timer.setCurrentTime(requestDeadline + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS - 1);
    await sweep();
    expect(manager.hasSession(SESSION)).toBe(true);
    expect(releases).toEqual([]);

    timer.setCurrentTime(requestDeadline + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS);
    await sweep();
    expect(releases.map((release) => release.reason)).toEqual(["cleanup-expired"]);
  });

  it("a request deadline that passed before the idle deadline releases at the idle deadline", async () => {
    await manager.getOrCreateSession(SESSION);
    inFlight = true;
    const idleDeadline = manager.getAllSessions()[0]!.expiresAt;
    const requestDeadline = timer.now() + 1_000;
    manager.setSessionExecutionDeadlineLookup(() => requestDeadline);

    timer.setCurrentTime(idleDeadline);
    await sweep();
    expect(manager.hasSession(SESSION)).toBe(true);

    timer.setCurrentTime(idleDeadline + 1);
    await sweep();
    expect(releases.map((release) => release.reason)).toEqual(["cleanup-expired"]);
  });

  it("a call with no deadline keeps the ceiling fallback even when a lookup is wired", async () => {
    await manager.getOrCreateSession(SESSION);
    inFlight = true;
    const idleDeadline = manager.getAllSessions()[0]!.expiresAt;
    manager.setSessionExecutionDeadlineLookup(() => Number.POSITIVE_INFINITY);

    timer.setCurrentTime(idleDeadline + UNSETTLED_EXECUTION_VETO_CEILING_MS - 1);
    await sweep();
    expect(manager.hasSession(SESSION)).toBe(true);

    timer.setCurrentTime(idleDeadline + UNSETTLED_EXECUTION_VETO_CEILING_MS);
    await sweep();
    expect(releases.map((release) => release.reason)).toEqual(["cleanup-expired"]);
  });

  it("a call end never shortens a deadline a later call start already set", async () => {
    timer.setCurrentTime(10_000);
    manager.recordToolCallEnded(SESSION);
    const deadline = manager.getAllSessions()[0]!.expiresAt;
    timer.setCurrentTime(5_000);
    manager.recordToolCallEnded(SESSION);
    expect(manager.getAllSessions()[0]!.expiresAt).toBe(deadline);
  });

  it("keeps the call-end refresh when persisting it fails", async () => {
    await manager.getOrCreateSession(SESSION);
    inFlight = true;
    timer.setCurrentTime(3 * DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    inFlight = false;
    const write = spyOn(persistence, "recordActivity").mockRejectedValueOnce(
      new Error("database is locked"),
    );
    try {
      const endedAt = timer.now();
      manager.recordToolCallEnded(SESSION);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(write).toHaveBeenCalled();
      expect(manager.getAllSessions()[0]!.expiresAt).toBe(
        endedAt + DEFAULT_SESSION_IDLE_TIMEOUT_MS,
      );
      timer.setCurrentTime(endedAt + DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
      await sweep();
      expect(manager.hasSession(SESSION)).toBe(true);
      expect(releases).toEqual([]);
    } finally {
      write.mockRestore();
    }
  });

  // #10824: a call refused because the session expired while earlier work still runs must not
  // push the idle deadline out when it ends, or repeated refusals keep the session alive.
  it("a late call refused while earlier work runs leaves the idle deadline where it was", async () => {
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    tracker.onSessionExecutionEnded((sessionUuids, end) => {
      for (const sessionUuid of sessionUuids) {
        manager.recordToolCallEnded(sessionUuid, end);
      }
    });
    await manager.getOrCreateSession(SESSION);
    inFlight = true;
    const idleDeadline = manager.getAllSessions()[0]!.expiresAt;
    timer.setCurrentTime(idleDeadline + 10_000);

    const late = tracker.startExecution("observe", undefined, SESSION);
    await expect(
      manager.admitIssuedSessionForAutomation(SESSION, {
        executionId: late.id,
        startTime: late.startTime,
      }),
    ).rejects.toThrow(/expired before this execution began/);
    tracker.endExecution(late.id);
    expect(manager.getAllSessions()[0]!.expiresAt).toBe(idleDeadline);

    // The earlier, admitted work ending is use: it restarts the window from its end.
    const earlier = tracker.startExecution("observe", undefined, SESSION);
    tracker.markSessionAdmitted(earlier.id);
    inFlight = false;
    tracker.endExecution(earlier.id);
    expect(manager.getAllSessions()[0]!.expiresAt).toBe(
      timer.now() + DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    );
  });

  it("ignores an unknown session", () => {
    expect(() => manager.recordToolCallEnded("missing")).not.toThrow();
  });
});

describe("CLI idle is measured from tool activity, not heartbeats", () => {
  let timer: FakeTimer;
  let manager: SessionManager;

  beforeEach(async () => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await manager.createSession(SESSION, DEVICE, "android");
    expect(manager.adoptCliLivenessPolicy(SESSION, DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS)).toBe(true);
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  it("an external heartbeat loop with no tool calls does not hold a CLI session past the window", async () => {
    const reaped: string[] = [];
    const monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (_sessionId, reason) => {
        reaped.push(reason);
      },
      timer,
    );
    const step = PROXY_HEARTBEAT_INTERVAL_MS;
    for (let at = step; at <= DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS; at += step) {
      timer.setCurrentTime(at);
      manager.recordHeartbeat(SESSION);
    }
    await monitor.tick();
    expect(reaped).toEqual([]);

    timer.setCurrentTime(DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS + step);
    manager.recordHeartbeat(SESSION);
    await monitor.tick();
    expect(reaped).toEqual(["cli-idle-timeout"]);
  });
});

describe("ExecutionTracker session execution-end notification", () => {
  it("reports the session UUIDs of an ended execution once, and stops after unsubscribe", () => {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator());
    const ended: (readonly string[])[] = [];
    const unsubscribe = tracker.onSessionExecutionEnded((uuids) => ended.push(uuids));

    const withSession = tracker.startExecution("tapOn", undefined, SESSION);
    const sessionless = tracker.startExecution("listDevices");
    tracker.endExecution(withSession.id);
    tracker.endExecution(withSession.id);
    tracker.endExecution(sessionless.id);
    expect(ended).toEqual([[SESSION]]);

    unsubscribe();
    const later = tracker.startExecution("tapOn", undefined, SESSION);
    tracker.endExecution(later.id);
    expect(ended).toHaveLength(1);
  });

  it("reports whether the ended execution was admitted under its session (#10824)", () => {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator());
    const ended: { uuids: readonly string[]; admitted: boolean }[] = [];
    tracker.onSessionExecutionEnded((uuids, { admitted }) => ended.push({ uuids, admitted }));

    const refused = tracker.startExecution("tapOn", undefined, SESSION);
    tracker.endExecution(refused.id);
    const admitted = tracker.startExecution("tapOn", undefined, SESSION);
    tracker.markSessionAdmitted(admitted.id);
    tracker.endExecution(admitted.id);

    expect(ended).toEqual([
      { uuids: [SESSION], admitted: false },
      { uuids: [SESSION], admitted: true },
    ]);
  });

  it("does not report a read-only inventory call as session use", () => {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator());
    const ended: (readonly string[])[] = [];
    tracker.onSessionExecutionEnded((uuids) => ended.push(uuids));

    const inventory = tracker.startExecution("listDevices", undefined, SESSION);
    tracker.markReadOnlySessionAccess(inventory.id);
    tracker.endExecution(inventory.id);
    expect(ended).toEqual([]);

    const use = tracker.startExecution("tapOn", undefined, SESSION);
    tracker.endExecution(use.id);
    expect(ended).toEqual([[SESSION]]);
  });
});
