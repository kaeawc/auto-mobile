import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import {
  DAEMON_STALLED_CODE,
  LIVENESS_RECOVERY_ATTEMPTS,
  LivenessRecovery,
  MIN_RECOVERY_ATTEMPT_MS,
  PROXY_STALLED_CODE,
  REACQUIRE_LOST_SESSIONS_ACTION,
  RECOVERY_SAFETY_MARGIN_MS,
  RESTART_DAEMON_THEN_RESUME_ACTION,
  TickLatenessClock,
  daemonLifecycleAllowed,
  livenessBudgetMs,
  livenessHandoverMessage,
  livenessHandoverPayload,
  ownershipConflictLeashMs,
  recoveryAttemptSlotMs,
  runWithoutDaemonLifecycle,
  type LivenessHandover,
  type LivenessRecoveryDeps,
  type LivenessStallCode,
  type RecoveryAttemptOutcome,
} from "../../src/daemon/proxyLivenessRecovery";
import { FakeTimer } from "../fakes/FakeTimer";

// #10053: per-session liveness recovery, driven entirely by a fake timer against a scripted daemon.

const LEASE_MS = 10_000;

interface Harness {
  timer: FakeTimer;
  recovery: LivenessRecovery;
  attempts: Array<{ sessionUuid: string; attempt: number; at: number }>;
  recovered: Array<{
    sessionUuid: string;
    code: LivenessStallCode;
    attempts: number;
    late: boolean;
  }>;
  gone: string[];
  handovers: LivenessHandover[];
}

function harness(options: {
  outcomeFor: (sessionUuid: string, attempt: number) => RecoveryAttemptOutcome | "hang";
  lastAckAt?: number;
  leaseMs?: number;
  deviceIds?: Record<string, string>;
}): Harness {
  const timer = new FakeTimer();
  const state: Harness = {
    timer,
    attempts: [],
    recovered: [],
    gone: [],
    handovers: [],
    recovery: undefined as never,
  };
  const deps: LivenessRecoveryDeps = {
    timer,
    leaseMs: options.leaseMs ?? LEASE_MS,
    lastAckAt: () => options.lastAckAt ?? 0,
    deviceIdOf: (sessionUuid) => options.deviceIds?.[sessionUuid],
    isActive: () => true,
    attempt: async (sessionUuid, attempt) => {
      state.attempts.push({ sessionUuid, attempt, at: timer.now() });
      const outcome = options.outcomeFor(sessionUuid, attempt);
      return outcome === "hang" ? new Promise<RecoveryAttemptOutcome>(() => {}) : outcome;
    },
    onRecovered: ({ sessionUuid, code, attempts, restoredAfterLapse }) =>
      state.recovered.push({ sessionUuid, code, attempts, late: restoredAfterLapse }),
    onSessionGone: (sessionUuid) => state.gone.push(sessionUuid),
    onHandover: (handover) => state.handovers.push(handover),
  };
  state.recovery = new LivenessRecovery(deps);
  return state;
}

describe("recovery budget arithmetic", () => {
  test("derives the budget and the conflict leash from the lease and the suspect grace", () => {
    expect(livenessBudgetMs(LEASE_MS)).toBe(LEASE_MS + SUSPECT_GRACE_MS);
    expect(livenessBudgetMs(3_000)).toBe(3_000 + SUSPECT_GRACE_MS);
    // One heartbeat cadence beyond lease + grace, so the retry after the daemon lets go still lands.
    expect(ownershipConflictLeashMs(LEASE_MS, 2_000)).toBe(LEASE_MS + SUSPECT_GRACE_MS + 2_000);
    expect(ownershipConflictLeashMs(5_000, 5_000)).toBe(5_000 + SUSPECT_GRACE_MS + 5_000);
    // Covers a lapsed foreign owner's whole lease + grace at any cadence.
    expect(ownershipConflictLeashMs(LEASE_MS, 2_000)).toBeGreaterThan(livenessBudgetMs(LEASE_MS));
  });

  test("slots divide what remains of the budget and never drop below the minimum", () => {
    expect(recoveryAttemptSlotMs({ leaseMs: LEASE_MS, lastAckAt: 0, now: 6_000 })).toBe(
      Math.floor((20_000 - RECOVERY_SAFETY_MARGIN_MS - 6_000) / LIVENESS_RECOVERY_ATTEMPTS),
    );
    expect(recoveryAttemptSlotMs({ leaseMs: LEASE_MS, lastAckAt: 0, now: 19_500 })).toBe(
      MIN_RECOVERY_ATTEMPT_MS,
    );
    expect(recoveryAttemptSlotMs({ leaseMs: LEASE_MS, lastAckAt: 0, now: 90_000 })).toBe(
      MIN_RECOVERY_ATTEMPT_MS,
    );
  });

  test("tick lateness is how far a tick overshot its cadence, and a reset forgets the last tick", () => {
    const clock = new TickLatenessClock(2_000);
    expect(clock.note(1_000)).toBe(0);
    expect(clock.note(3_000)).toBe(0);
    expect(clock.note(3_500)).toBe(0);
    expect(clock.note(18_500)).toBe(13_000);
    clock.reset();
    expect(clock.note(99_000)).toBe(0);
  });
});

describe("LivenessRecovery attempts", () => {
  test("an unresponsive daemon gets exactly three attempts, then one handover", async () => {
    const h = harness({
      outcomeFor: () => "unreachable",
      deviceIds: { "session-a": "emulator-5554" },
    });
    h.timer.setCurrentTime(6_000);
    h.recovery.begin("session-a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(20_000);

    expect(h.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(h.recovered).toEqual([]);
    expect(h.handovers).toEqual([
      {
        code: "daemon_stalled",
        sessions: [
          { sessionUuid: "session-a", deviceId: "emulator-5554", lastAcknowledgedHeartbeatAt: 0 },
        ],
        attempts: 3,
        lastAcknowledgedHeartbeatAt: 0,
        action: RESTART_DAEMON_THEN_RESUME_ACTION,
      },
    ]);
    expect(h.recovery.isRecovering("session-a")).toBe(false);
  });

  test("attempts that hang are cut off by their slot and still count as attempts", async () => {
    const h = harness({ outcomeFor: () => "hang" });
    h.timer.setCurrentTime(6_000);
    h.recovery.begin("session-a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(20_000);

    expect(h.attempts).toHaveLength(3);
    expect(h.handovers).toHaveLength(1);
    expect(h.handovers[0].attempts).toBe(3);
  });

  test.each([1, 2, 3])("a daemon that answers attempt %i leaves no handover", async (answersAt) => {
    const h = harness({
      outcomeFor: (_session, attempt) => (attempt === answersAt ? "acknowledged" : "unreachable"),
    });
    h.timer.setCurrentTime(6_000);
    h.recovery.begin("session-a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(20_000);

    expect(h.attempts).toHaveLength(answersAt);
    expect(h.recovered).toEqual([
      { sessionUuid: "session-a", code: "daemon_stalled", attempts: answersAt, late: false },
    ]);
    expect(h.handovers).toEqual([]);
  });

  test.each([
    { intervalMs: 2_000, detectedAfterMs: 2_000 + 4_000 },
    { intervalMs: 5_000, detectedAfterMs: 5_000 + 5_000 },
  ])(
    "three attempts finish inside lease plus grace at the $intervalMs ms heartbeat cadence",
    async ({ detectedAfterMs }) => {
      // Last ack at 0; the first tick's own deadline expires at `detectedAfterMs`, which is when
      // recovery starts. Every attempt hangs, the worst case for how long recovery can take.
      const h = harness({ outcomeFor: () => "hang" });
      h.timer.setCurrentTime(detectedAfterMs);
      h.recovery.begin("session-a", DAEMON_STALLED_CODE);
      await h.timer.advanceTimeAsync(livenessBudgetMs(LEASE_MS));

      expect(h.handovers).toHaveLength(1);
      expect(h.attempts).toHaveLength(LIVENESS_RECOVERY_ATTEMPTS);
      // The final attempt's slot ends before the daemon would release the session.
      const lastSlotEnd =
        h.attempts[2].at +
        recoveryAttemptSlotMs({
          leaseMs: LEASE_MS,
          lastAckAt: 0,
          now: detectedAfterMs,
        });
      expect(lastSlotEnd).toBeLessThanOrEqual(
        livenessBudgetMs(LEASE_MS) - RECOVERY_SAFETY_MARGIN_MS,
      );
    },
  );

  test("attempts are spread over equal slots, so a fast refusal does not burn all three at once", async () => {
    const h = harness({ outcomeFor: () => "unreachable" });
    h.timer.setCurrentTime(5_000);
    h.recovery.begin("session-a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(20_000);

    const slot = Math.floor((20_000 - RECOVERY_SAFETY_MARGIN_MS - 5_000) / 3);
    expect(h.attempts.map((a) => a.at)).toEqual([5_000, 5_000 + slot, 5_000 + 2 * slot]);
  });

  test("begin is a no-op while the session is already recovering", async () => {
    const h = harness({ outcomeFor: () => "unreachable" });
    h.recovery.begin("session-a", DAEMON_STALLED_CODE);
    h.recovery.begin("session-a", PROXY_STALLED_CODE);
    await h.timer.advanceTimeAsync(20_000);

    expect(h.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(h.handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
  });

  test("stop abandons recovery without a handover", async () => {
    const h = harness({ outcomeFor: () => "unreachable" });
    h.recovery.begin("session-a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(0);
    h.recovery.stop();
    await h.timer.advanceTimeAsync(20_000);

    expect(h.handovers).toEqual([]);
    expect(h.attempts.length).toBeLessThanOrEqual(1);
  });
});

describe("LivenessRecovery states", () => {
  test("daemon_stalled: a session the daemon says is gone is dropped, not handed over", async () => {
    const h = harness({
      outcomeFor: (session) => (session === "gone" ? "session-gone" : "acknowledged"),
    });
    h.recovery.begin("gone", DAEMON_STALLED_CODE);
    h.recovery.begin("alive", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(20_000);

    expect(h.gone).toEqual(["gone"]);
    expect(h.recovered.map((r) => r.sessionUuid)).toEqual(["alive"]);
    expect(h.handovers).toEqual([]);
  });

  test("proxy_stalled: lost sessions and their devices are listed in one handover", async () => {
    const h = harness({
      outcomeFor: (session) => (session === "restored" ? "acknowledged" : "session-gone"),
      lastAckAt: 1_000,
      deviceIds: { lost1: "emulator-5554", lost2: "sim-1" },
    });
    h.timer.setCurrentTime(30_000);
    for (const session of ["lost1", "restored", "lost2"]) {
      h.recovery.begin(session, PROXY_STALLED_CODE);
    }
    await h.timer.advanceTimeAsync(10_000);

    // Restored past the lease: the daemon had held it as suspect and kept the UUID.
    expect(h.recovered).toEqual([
      { sessionUuid: "restored", code: "proxy_stalled", attempts: 1, late: true },
    ]);
    expect(h.handovers).toHaveLength(1);
    const [handover] = h.handovers;
    expect(handover.code).toBe("proxy_stalled");
    expect(handover.action).toBe(REACQUIRE_LOST_SESSIONS_ACTION);
    expect(handover.sessions.map((s) => [s.sessionUuid, s.deviceId])).toEqual([
      ["lost1", "emulator-5554"],
      ["lost2", "sim-1"],
    ]);
    expect(h.gone).toEqual([]);
  });

  test("sessions failing in the same state share one handover naming all of them", async () => {
    const h = harness({ outcomeFor: () => "unreachable" });
    h.recovery.begin("a", DAEMON_STALLED_CODE);
    h.recovery.begin("b", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(20_000);

    expect(h.handovers).toHaveLength(1);
    expect(h.handovers[0].sessions.map((s) => s.sessionUuid)).toEqual(["a", "b"]);
    expect(h.handovers[0].attempts).toBe(3);
  });

  test("a session that stays unknown to this proxy reports a null device", async () => {
    const h = harness({ outcomeFor: () => "unreachable" });
    h.recovery.begin("a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(20_000);

    expect(h.handovers[0].sessions[0].deviceId).toBeNull();
  });
});

describe("handover payload", () => {
  const daemonStalled: LivenessHandover = {
    code: "daemon_stalled",
    sessions: [
      { sessionUuid: "s1", deviceId: "emulator-5554", lastAcknowledgedHeartbeatAt: 1_000 },
      { sessionUuid: "s2", deviceId: null, lastAcknowledgedHeartbeatAt: 2_000 },
    ],
    attempts: 3,
    lastAcknowledgedHeartbeatAt: 2_000,
    action: RESTART_DAEMON_THEN_RESUME_ACTION,
  };

  test("daemon_stalled carries sessions, devices, attempts, last ack and the restart action", () => {
    const { error } = livenessHandoverPayload(daemonStalled);

    expect(error).toMatchObject({
      code: "daemon_stalled",
      attempts: 3,
      maxAttempts: 3,
      lastAcknowledgedHeartbeatAt: 2_000,
      recovery: { action: "restart_daemon_then_resume_by_session_uuid" },
      sessions: [
        { sessionUuid: "s1", deviceId: "emulator-5554", lastAcknowledgedHeartbeatAt: 1_000 },
        { sessionUuid: "s2", deviceId: null, lastAcknowledgedHeartbeatAt: 2_000 },
      ],
    });
    expect(error.message).toContain("s1 (emulator-5554)");
    expect(error.message).toContain("never restarts the daemon");
    expect(error.message).toContain("resume each session by passing its sessionUuid");
  });

  test("proxy_stalled names the lost sessions and tells the harness to reacquire", () => {
    const message = livenessHandoverMessage({
      ...daemonStalled,
      code: "proxy_stalled",
      action: REACQUIRE_LOST_SESSIONS_ACTION,
    });

    expect(message).toContain("s1 (emulator-5554), s2");
    expect(message).toContain("Reacquire");
    expect(message).not.toContain("restart the daemon");
  });
});

describe("a proxy never stops or restarts the daemon (#10053)", () => {
  const root = path.resolve(__dirname, "../..");

  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/`[^`]*`/g, "``")
      .replace(/"[^"\n]*"/g, '""');
  }

  test("the recovery module has no daemon-management dependency or call", () => {
    const source = codeOnly(
      readFileSync(path.join(root, "src/daemon/proxyLivenessRecovery.ts"), "utf8"),
    );

    expect(source).not.toMatch(/from "\.\/manager"/);
    expect(source).not.toMatch(/daemonManager|DaemonManager/);
    expect(source).not.toMatch(/child_process|spawn|exec\(|kill\(/);
    expect(source).not.toMatch(/\.(restart|stop|start|shutdown|kill)\(/);
  });

  test("the proxy's recovery methods never reach the daemon manager", () => {
    const proxy = codeOnly(readFileSync(path.join(root, "src/daemon/daemonMcpProxy.ts"), "utf8"));
    const from = proxy.indexOf("private createLivenessRecovery()");
    const to = proxy.indexOf("private async heartbeatOtherHeldSessions()");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const recoveryMethods = proxy.slice(from, to);

    expect(recoveryMethods).not.toMatch(/daemonManager/);
    expect(recoveryMethods).not.toMatch(/startDaemon|restartDaemon|\.restart\(|\.kill\(/);
    // The recovery attempt connects observation-only.
    expect(recoveryMethods).toContain("runWithoutDaemonLifecycle");
  });

  test("a lifecycle-free context refuses lifecycle and the default allows it", async () => {
    expect(daemonLifecycleAllowed()).toBe(true);
    await runWithoutDaemonLifecycle(async () => {
      expect(daemonLifecycleAllowed()).toBe(false);
      await Promise.resolve();
      expect(daemonLifecycleAllowed()).toBe(false);
    });
    expect(daemonLifecycleAllowed()).toBe(true);
  });
});
