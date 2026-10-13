import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  STUCK_REAP_WARN_MS,
  SessionHeartbeatMonitor,
  type HeartbeatSessionSource,
} from "../../src/daemon/SessionHeartbeatMonitor";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../src/daemon/sessionLivenessWindows";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// #10704: one release that never settles must not wedge the heartbeat monitor. Other sessions are
// still released on schedule (including a CLI session, which has no other release path), stall
// forgiveness keeps working, and the stuck release is reported once instead of silently holding.

const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
const LEASE_MS = 5_000;
const CLI_IDLE_MS = 20_000;

describe("a release that never settles (#10704)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let reaps: { sessionId: string; reason: string; at: number }[];
  const hung = Promise.withResolvers<void>();

  beforeEach(async () => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    reaps = [];
    for (const [id, device] of [
      ["HUNG", "emulator-5554"],
      ["GONE", "emulator-5556"],
      ["LIVE", "emulator-5558"],
      ["CLI", "emulator-5560"],
    ] as const) {
      await manager.createSession(id, device, "android", 600_000, LEASE_MS);
      manager.recordHeartbeat(id);
    }
    expect(manager.adoptCliLivenessPolicy("CLI", CLI_IDLE_MS)).toBe(true);
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        reaps.push({ sessionId, reason, at: timer.now() });
        if (sessionId === "HUNG") {
          // The teardown parks forever.
          await hung.promise;
          return;
        }
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
    monitor.start();
  });

  afterEach(async () => {
    hung.resolve();
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  /** Run scheduled scans until `until`, the listed owners heartbeating before each one. */
  async function runUntil(until: number, heartbeating: readonly string[]): Promise<void> {
    while (timer.now() < until) {
      for (const id of heartbeating) {
        if (manager.getSession(id)) {
          manager.recordHeartbeat(id);
        }
      }
      await timer.advanceTimeAsync(SCAN_MS, () => drainMicrotasks(10));
    }
  }

  test("other sessions are released on schedule, forgiveness still works, and the stuck release is reported once", async () => {
    const warn = spyOn(logger, "warn");
    try {
      // HUNG's owner goes silent at once; its release starts and never settles.
      await runUntil(10_000, ["GONE", "LIVE"]);
      expect(reaps.filter((reap) => reap.sessionId === "HUNG")).toHaveLength(1);
      const hungAt = reaps.find((reap) => reap.sessionId === "HUNG")!.at;
      expect(hungAt).toBeLessThanOrEqual(LEASE_MS + SUSPECT_GRACE_MS + SCAN_MS);

      // GONE's owner exits at 10 s: released within lease + grace + one scan anyway.
      await runUntil(CLI_IDLE_MS + 2 * SCAN_MS, ["LIVE"]);
      const gone = reaps.find((reap) => reap.sessionId === "GONE");
      expect(gone?.reason).toBe("heartbeat-timeout");
      expect(gone!.at).toBeLessThanOrEqual(10_000 + LEASE_MS + SUSPECT_GRACE_MS + SCAN_MS);
      // The CLI session, judged only by the monitor, idles out on schedule.
      const cli = reaps.find((reap) => reap.sessionId === "CLI");
      expect(cli?.reason).toBe("cli-idle-timeout");
      expect(cli!.at).toBeLessThanOrEqual(CLI_IDLE_MS + SCAN_MS);

      // Reported once, after the warning threshold, and never released a second time.
      await runUntil(hungAt + STUCK_REAP_WARN_MS + 4 * SCAN_MS, ["LIVE"]);
      const stuck = warn.mock.calls.filter(([message]) =>
        String(message).startsWith("Session HUNG release has not settled"),
      );
      expect(stuck).toHaveLength(1);
      expect(reaps.filter((reap) => reap.sessionId === "HUNG")).toHaveLength(1);

      // A daemon stall far past LIVE's lease is still forgiven: the next scan keeps LIVE although
      // its owner's queued heartbeat has not been delivered yet.
      timer.setCurrentTime(timer.now() + 30_000);
      await timer.advanceTimeAsync(SCAN_MS, () => drainMicrotasks(10));
      expect(reaps.some((reap) => reap.sessionId === "LIVE")).toBe(false);
      expect(manager.getSession("LIVE")?.stallForgivenAt).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("monitor reap timestamps", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let session: Session;
  let monitor: SessionHeartbeatMonitor;
  let sourceStartedAt: number | undefined;
  let visible: boolean;
  let forcedAt: number[];
  let reapedAt: number[];
  let gate: ReturnType<typeof Promise.withResolvers<void>>;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

  beforeEach(async () => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    session = await manager.createSession("same-id", "emulator-5554", "android", 600_000, LEASE_MS);
    manager.recordHeartbeat(session.sessionId);
    timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS + 1);
    sourceStartedAt = undefined;
    visible = true;
    forcedAt = [];
    reapedAt = [];
    gate = Promise.withResolvers<void>();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    gate.resolve();
    if (monitor) {
      await monitor.stop();
    }
    manager.stopCleanupTimer();
    timer.reset();
    warn.mockRestore();
  });

  function start(
    joinAt = timer.now(),
    getReleaseStuckAtMs?: (sessionId: string) => number | undefined,
  ) {
    const source: HeartbeatSessionSource = {
      getAllSessions: () => (visible ? [session] : []),
      cleanupExpiredSessions: () => {},
      getNonTerminalReleasesInProgress: () =>
        sourceStartedAt === undefined
          ? []
          : [{ sessionId: session.sessionId, session, startedAtMs: sourceStartedAt }],
      isReleaseInProgress: (id, at) => id === session.sessionId && at === sourceStartedAt,
      ...(getReleaseStuckAtMs ? { getReleaseStuckAtMs } : {}),
    };
    monitor = new SessionHeartbeatMonitor(
      source,
      () => timer.now() < joinAt,
      async () => {
        reapedAt.push(timer.now());
        await gate.promise;
      },
      timer,
      {
        checkIntervalMs: SCAN_MS,
        forceStuckRelease: async () => {
          forcedAt.push(timer.now());
        },
      },
    );
    monitor.start();
  }

  const flush = () => drainMicrotasks(20);

  test("a source deadline is forced on its first due scan instead of the fallback deadline", async () => {
    sourceStartedAt = timer.now();
    const deadline = sourceStartedAt + STUCK_REAP_WARN_MS + SCAN_MS + 1;
    start(timer.now() + 2 * STUCK_REAP_WARN_MS, () => deadline);
    await timer.advanceTimeAsync(STUCK_REAP_WARN_MS, flush);
    expect(forcedAt).toEqual([]);
    await timer.advanceTimeAsync(SCAN_MS, flush);
    expect(forcedAt).toEqual([]);
    await timer.advanceTimeAsync(1, flush);
    expect(forcedAt).toEqual([]);
    await timer.advanceTimeAsync(SCAN_MS - 1, flush);
    expect(forcedAt).toEqual([deadline + SCAN_MS - 1]);
    await timer.advanceTimeAsync(2 * SCAN_MS, flush);
    expect(forcedAt).toHaveLength(1);
  });

  test("a reap without a tracked source release starts its deadline at the joining scan", async () => {
    const origin = timer.now();
    start();
    await timer.advanceTimeAsync(SCAN_MS, flush);
    expect(reapedAt).toEqual([origin + SCAN_MS]);
    await timer.advanceTimeAsync(STUCK_REAP_WARN_MS - 1, flush);
    expect(forcedAt).toEqual([]);
    await timer.advanceTimeAsync(1, flush);
    expect(forcedAt).toEqual([reapedAt[0]! + STUCK_REAP_WARN_MS]);
  });

  test("joining an already reported source release does not report or force it twice", async () => {
    sourceStartedAt = timer.now();
    start(sourceStartedAt + STUCK_REAP_WARN_MS);
    await timer.advanceTimeAsync(STUCK_REAP_WARN_MS, flush);
    expect(reapedAt).toEqual([sourceStartedAt + STUCK_REAP_WARN_MS]);
    expect(forcedAt).toEqual([sourceStartedAt + STUCK_REAP_WARN_MS]);
    await timer.advanceTimeAsync(STUCK_REAP_WARN_MS + SCAN_MS, flush);
    expect(forcedAt).toHaveLength(1);
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes("release has not settled")),
    ).toHaveLength(1);
  });

  for (const delayedJoinSettlement of [false, true]) {
    test(`a later release of the same id has a fresh deadline (${delayedJoinSettlement ? "delayed" : "prompt"} join settlement)`, async () => {
      sourceStartedAt = timer.now();
      start(sourceStartedAt + 2 * SCAN_MS);
      await timer.advanceTimeAsync(3 * SCAN_MS, flush);
      expect(reapedAt).toEqual([sourceStartedAt + 2 * SCAN_MS]);
      // The source release ends; even a join promise still unwinding must not retain its deadline.
      sourceStartedAt = undefined;
      visible = false;
      if (!delayedJoinSettlement) {
        gate.resolve();
        await flush();
      }
      await timer.advanceTimeAsync(SCAN_MS, flush);
      sourceStartedAt = timer.now();
      const secondStartedAt = sourceStartedAt;
      await timer.advanceTimeAsync(SCAN_MS, flush);
      await timer.advanceTimeAsync(STUCK_REAP_WARN_MS - SCAN_MS - 1, flush);
      expect(forcedAt).toEqual([]);
      // The old join's settle handler must not forget the second release's new tracked object.
      gate.resolve();
      await flush();
      await timer.advanceTimeAsync(1, flush);
      expect(forcedAt).toEqual([secondStartedAt + STUCK_REAP_WARN_MS]);
    });
  }
});
