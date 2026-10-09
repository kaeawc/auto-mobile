import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import {
  DAEMON_STALLED_CODE,
  LIVENESS_RECOVERY_ATTEMPTS,
  LivenessRecovery,
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

/** The scenarios below are written against a 20 s budget: a configured lease plus the suspect grace. */
const BUDGET_MS = 20_000;
const LEASE_MS = BUDGET_MS - SUSPECT_GRACE_MS;
/** The heartbeat request timeout of a 5s-cadence proxy on that lease. */
const REQUEST_TIMEOUT_MS = 5_000;

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
  requestTimeoutMs?: number;
  deviceIds?: Record<string, string>;
  /** Sessions the proxy has since heard an acknowledgement for, with when (proxy clock). */
  acknowledgedAt?: Record<string, number>;
  /** Called with each attempt's `claimSocketReset` so a test can see who may replace the socket. */
  onSocketReset?: (sessionUuid: string, attempt: number, granted: boolean) => void;
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
    requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    lastAckAt: () => options.lastAckAt ?? 0,
    hasAcknowledgedSince: (sessionUuid, sinceMs) =>
      (options.acknowledgedAt?.[sessionUuid] ?? Number.NEGATIVE_INFINITY) > sinceMs,
    deviceIdOf: (sessionUuid) => options.deviceIds?.[sessionUuid],
    isActive: () => true,
    attempt: async (sessionUuid, attempt, _deadlineMs, claimSocketReset) => {
      if (attempt > 1) {
        options.onSocketReset?.(sessionUuid, attempt, claimSocketReset());
      }
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

  test("slots divide what remains of the budget, and a spent budget falls back to the request timeout", () => {
    const slot = (now: number, requestTimeoutMs = REQUEST_TIMEOUT_MS) =>
      recoveryAttemptSlotMs({ leaseMs: LEASE_MS, lastAckAt: 0, now, requestTimeoutMs });
    expect(slot(6_000)).toBe(
      Math.floor((BUDGET_MS - RECOVERY_SAFETY_MARGIN_MS - 6_000) / LIVENESS_RECOVERY_ATTEMPTS),
    );
    // An hour-old acknowledgement says nothing about the daemon (review F4): each attempt is
    // given as long as a regular heartbeat, not a constant 250 ms.
    expect(slot(19_500)).toBe(REQUEST_TIMEOUT_MS);
    expect(slot(90_000)).toBe(REQUEST_TIMEOUT_MS);
    expect(slot(3_600_000, 4_000)).toBe(4_000);
    expect(slot(3_600_000, 1_000)).toBe(1_000);
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
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
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
  test("sessions joining a running recovery share its busy episode; the next recovery gets a new one", async () => {
    const h = harness({ outcomeFor: (session) => (session === "b" ? "hang" : "acknowledged") });
    const idle = h.recovery.busyEpisode();
    h.recovery.begin("b", DAEMON_STALLED_CODE);
    const first = h.recovery.busyEpisode();
    expect(first).not.toBe(idle);
    h.recovery.begin("a", PROXY_STALLED_CODE);
    expect(h.recovery.busyEpisode()).toBe(first);
    await h.timer.advanceTimeAsync(20_000);
    expect(h.recovered.map((r) => r.sessionUuid)).toEqual(["a"]);
    expect(h.recovery.isRecovering("b")).toBe(false);
    expect(h.recovery.busyEpisode()).toBe(first);

    h.recovery.begin("a", DAEMON_STALLED_CODE);
    expect(h.recovery.busyEpisode()).not.toBe(first);
  });

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

describe("recovery review fixes (PR 10115)", () => {
  test("F4: an hour-stale acknowledgement still gives each attempt a request timeout, not 250 ms", async () => {
    const h = harness({ outcomeFor: () => "unreachable", lastAckAt: 0 });
    h.timer.setCurrentTime(3_600_000);
    h.recovery.begin("session-a", PROXY_STALLED_CODE);
    await h.timer.advanceTimeAsync(30_000);

    expect(h.attempts.map((a) => a.at)).toEqual([
      3_600_000,
      3_600_000 + REQUEST_TIMEOUT_MS,
      3_600_000 + 2 * REQUEST_TIMEOUT_MS,
    ]);
  });

  test("F4: a proxy stall followed by a daemon that never answers is daemon_stalled, not proxy_stalled", async () => {
    const h = harness({ outcomeFor: () => "unreachable", deviceIds: { a: "emulator-5554" } });
    h.timer.setCurrentTime(3_600_000);
    h.recovery.begin("a", PROXY_STALLED_CODE);
    await h.timer.advanceTimeAsync(30_000);

    expect(h.handovers).toHaveLength(1);
    expect(h.handovers[0]).toMatchObject({
      code: "daemon_stalled",
      action: RESTART_DAEMON_THEN_RESUME_ACTION,
      attempts: 3,
      sessions: [{ sessionUuid: "a", deviceId: "emulator-5554" }],
    });
    expect(livenessHandoverMessage(h.handovers[0])).not.toContain("released them");
  });

  test("F4: a daemon answer of not-found still proves a proxy-stalled session lost", async () => {
    const h = harness({
      outcomeFor: (session, attempt) =>
        session === "lost" && attempt === 2 ? "session-gone" : "unreachable",
    });
    h.timer.setCurrentTime(3_600_000);
    h.recovery.begin("lost", PROXY_STALLED_CODE);
    h.recovery.begin("silent", PROXY_STALLED_CODE);
    await h.timer.advanceTimeAsync(30_000);

    // The lost session is reported as lost, the silent one as a stalled daemon: two handovers.
    expect(
      h.handovers.map((handover) => [handover.code, handover.sessions[0].sessionUuid]),
    ).toEqual([
      ["daemon_stalled", "silent"],
      ["proxy_stalled", "lost"],
    ]);
    expect(h.handovers[1].attempts).toBe(2);
    expect(h.handovers[1].action).toBe(REACQUIRE_LOST_SESSIONS_ACTION);
  });

  test.each([DAEMON_STALLED_CODE, PROXY_STALLED_CODE] as const)(
    "F3: a proxy displaced while stalled (%s recovery) is handed over as lost, not recovered",
    async (code) => {
      const h = harness({
        outcomeFor: () => "superseded",
        deviceIds: { a: "emulator-5554" },
      });
      h.timer.setCurrentTime(30_000);
      h.recovery.begin("a", code);
      await h.timer.advanceTimeAsync(30_000);

      expect(h.recovered).toEqual([]);
      // A displaced owner is told once; retrying would only be refused again.
      expect(h.attempts).toHaveLength(1);
      expect(h.handovers).toEqual([
        {
          code: "proxy_stalled",
          sessions: [
            { sessionUuid: "a", deviceId: "emulator-5554", lastAcknowledgedHeartbeatAt: 0 },
          ],
          attempts: 1,
          lastAcknowledgedHeartbeatAt: 0,
          action: REACQUIRE_LOST_SESSIONS_ACTION,
          ...(code === DAEMON_STALLED_CODE ? { stalledBy: "daemon" } : {}),
        },
      ]);
      expect(livenessHandoverMessage(h.handovers[0])).toContain("another liveness owner");
    },
  );

  test("F5: a failed session is not recovered again by the next keeper tick while its episode is open", async () => {
    const h = harness({ outcomeFor: () => "unreachable" });
    h.recovery.begin("a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(10_000);
    // b joins the same episode later (a stall onset mid-tick), so a's run ends at 12.7s while b's,
    // sharing what remains of the budget, ends at 16s and the episode stays open.
    h.recovery.begin("b", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(3_000);
    expect(h.attempts.filter((a) => a.sessionUuid === "a")).toHaveLength(3);
    expect(h.handovers).toEqual([]);

    // The keeper tick that would heartbeat `a` again finds it held.
    expect(h.recovery.isRecovering("a")).toBe(true);
    h.recovery.begin("a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(40_000);

    expect(h.attempts.filter((a) => a.sessionUuid === "a")).toHaveLength(3);
    expect(h.attempts.filter((a) => a.sessionUuid === "b")).toHaveLength(3);
    expect(h.handovers).toHaveLength(1);
    expect(h.handovers[0].attempts).toBe(3);
    expect(h.handovers[0].sessions.map((s) => s.sessionUuid)).toEqual(["a", "b"]);
    // After the handover the session is free to be recovered by a later episode.
    expect(h.recovery.isRecovering("a")).toBe(false);
  });

  test("F5: a session that became healthy after it failed is not handed over", async () => {
    const h = harness({
      outcomeFor: () => "unreachable",
      // a was acknowledged long after it failed; b never was.
      acknowledgedAt: { a: 1_000_000 },
    });
    h.recovery.begin("a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(2_000);
    h.recovery.begin("b", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(40_000);

    expect(h.handovers).toHaveLength(1);
    expect(h.handovers[0].sessions.map((s) => s.sessionUuid)).toEqual(["b"]);
  });

  test("#10973: an acknowledgement arriving while attempts go unanswered ends recovery, with no handover", async () => {
    const acknowledgedAt: Record<string, number> = {};
    const h = harness({ outcomeFor: () => "hang", acknowledgedAt });
    h.timer.setCurrentTime(6_000);
    h.recovery.begin("a", DAEMON_STALLED_CODE);
    // The heartbeat the keeper gave up on is acknowledged late, during the first attempt's slot.
    await h.timer.advanceTimeAsync(1_000);
    acknowledgedAt.a = h.timer.now();
    await h.timer.advanceTimeAsync(40_000);

    expect(h.handovers).toEqual([]);
    expect(h.attempts.map((a) => a.attempt)).toEqual([1]);
    expect(h.recovered).toEqual([
      { sessionUuid: "a", code: DAEMON_STALLED_CODE, attempts: 1, late: false },
    ]);
    expect(h.recovery.isRecovering("a")).toBe(false);
  });

  test("F5: no handover at all when every failed session has since been acknowledged", async () => {
    const h = harness({ outcomeFor: () => "unreachable", acknowledgedAt: { a: 1_000_000 } });
    h.recovery.begin("a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(40_000);

    expect(h.handovers).toEqual([]);
  });

  test("F6: the shared socket may be replaced by at most one attempt per episode, across sessions", async () => {
    const grants: Array<[string, number, boolean]> = [];
    const h = harness({
      outcomeFor: () => "unreachable",
      onSocketReset: (session, attempt, granted) => grants.push([session, attempt, granted]),
    });
    for (const session of ["a", "b", "c"]) {
      h.recovery.begin(session, DAEMON_STALLED_CODE);
    }
    await h.timer.advanceTimeAsync(40_000);

    // Each of three sessions asked on attempts 2 and 3; exactly one asked successfully.
    expect(grants).toHaveLength(6);
    expect(grants.filter(([, , granted]) => granted)).toHaveLength(1);
  });

  test("F6: a later episode may replace the socket once again", async () => {
    const grants: boolean[] = [];
    const h = harness({
      outcomeFor: () => "unreachable",
      onSocketReset: (_session, _attempt, granted) => grants.push(granted),
    });
    h.recovery.begin("a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(40_000);
    h.recovery.begin("b", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(40_000);

    expect(grants.filter(Boolean)).toHaveLength(2);
  });

  test("F11: stop cancels the in-flight slot wait and fires nothing afterwards", async () => {
    const h = harness({ outcomeFor: () => "unreachable" });
    h.recovery.begin("a", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(0);
    const pendingWaits = () => h.timer.getPendingTimeoutCount() + h.timer.getPendingSleepCount();
    expect(pendingWaits()).toBeGreaterThan(0);

    h.recovery.stop();
    await h.recovery.settled();

    expect(pendingWaits()).toBe(0);
    expect(h.attempts).toHaveLength(1);
    expect(h.handovers).toEqual([]);
  });
});

describe("handover reporting (#10991)", () => {
  test("proxy_stalled still names the device when the proxy forgets it while attempts run", async () => {
    const deviceIds: Record<string, string> = { lost1: "emulator-5554", lost2: "sim-1" };
    const h = harness({
      outcomeFor: () => "session-gone",
      lastAckAt: 1_000,
      deviceIds,
    });
    h.timer.setCurrentTime(30_000);
    h.recovery.begin("lost1", PROXY_STALLED_CODE);
    h.recovery.begin("lost2", PROXY_STALLED_CODE);
    // The heartbeat tick's own not-found answer drops the session's tracked device mid-recovery.
    delete deviceIds.lost1;
    delete deviceIds.lost2;
    await h.timer.advanceTimeAsync(10_000);

    expect(h.handovers).toHaveLength(1);
    expect(h.handovers[0].sessions.map((s) => [s.sessionUuid, s.deviceId])).toEqual([
      ["lost1", "emulator-5554"],
      ["lost2", "sim-1"],
    ]);
    expect(livenessHandoverMessage(h.handovers[0])).toContain("lost1 (emulator-5554)");
  });

  test("a proxy_stalled loss that follows a daemon stall blames the daemon, not the proxy", async () => {
    const h = harness({
      outcomeFor: () => "superseded",
      deviceIds: { s1: "emulator-5554" },
    });
    h.recovery.begin("s1", DAEMON_STALLED_CODE);
    await h.timer.advanceTimeAsync(10_000);

    const [handover] = h.handovers;
    expect(handover.code).toBe(PROXY_STALLED_CODE);
    const message = livenessHandoverMessage(handover);
    expect(message).toContain("daemon stalled");
    expect(message).toContain("s1 (emulator-5554)");
    expect(message).not.toContain("This MCP proxy stalled");
    // The wire payload keeps its stable shape: wording is the only difference.
    expect(Object.keys(livenessHandoverPayload(handover).error)).not.toContain("stalledBy");
  });

  test("a genuine proxy stall keeps the proxy wording", () => {
    const message = livenessHandoverMessage({
      code: PROXY_STALLED_CODE,
      sessions: [{ sessionUuid: "s1", deviceId: null, lastAcknowledgedHeartbeatAt: 0 }],
      attempts: 1,
      lastAcknowledgedHeartbeatAt: 0,
      action: REACQUIRE_LOST_SESSIONS_ACTION,
    });
    expect(message).toContain("This MCP proxy stalled");
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
