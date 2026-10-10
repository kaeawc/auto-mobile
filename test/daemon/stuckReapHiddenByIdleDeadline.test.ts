import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  STUCK_REAP_WARN_MS,
  SessionHeartbeatMonitor,
} from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  NO_HEARTBEAT_RELEASE_BUDGET_MS,
} from "../../src/daemon/sessionLivenessWindows";
import type { DeviceSessionRecord } from "../../src/db/deviceSessionRepository";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// #11481: the monitor forces a release that is stuck past STUCK_REAP_WARN_MS (#10963). It used to
// look only at the sessions `getAllSessions()` returns, which hides a session whose idle deadline
// has passed, so a heartbeat release that wedged across that deadline was never forced (and the
// idle sweep skips a session that is already releasing). An idle-sweep release is not one of the
// monitor's reaps at all, so it had no stuck deadline either. Stuck detection now runs over the
// releases in progress: the monitor's own reaps and the manager's idle releases.

const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
const DEVICE = "emulator-5554";

/** Session writes can be parked, like a wedged SQLite write. */
class ParkablePersistence extends FakeDeviceSessionPersistence {
  parkUpsert: Promise<void> | undefined;

  override async upsertActiveSession(record: DeviceSessionRecord): Promise<void> {
    await this.parkUpsert;
    await super.upsertActiveSession(record);
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

interface StuckRelease {
  /** Every force the monitor asked for, in order. */
  forced: string[];
  /** When each force was asked for. */
  forcedAt: number[];
  /** Every release announced to release listeners, as `sessionId:reason`. */
  released: string[];
  reapedAt: number | undefined;
  /** When the idle sweep (not the monitor) started releasing the session, if it did. */
  idleReleaseStartedAt: number | undefined;
  manager: SessionManager;
  timer: FakeTimer;
  /** Run scheduled scans for `ms` more. */
  runFor(ms: number): Promise<void>;
  /** Let the wedged release finish, as if the parked write returned. */
  unwedge(): Promise<void>;
}

/**
 * One owned, heartbeating session whose last tool call was `idleBeforeOwnerLossMs` ago when its
 * owner stops heartbeating, and whose release wedges inside the session manager (it waits on a
 * device rebind whose DB write never returns). Runs the real monitor and manager past the stuck
 * deadline of whichever release starts.
 */
async function stuckRelease(
  idleWindowMs: number,
  idleBeforeOwnerLossMs: number,
  options: { ownerKeepsHeartbeating?: boolean } = {},
): Promise<StuckRelease> {
  const timer = new FakeTimer();
  timer.setCurrentTime(0);
  const persistence = new ParkablePersistence();
  const manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
  cleanups.push(() => manager.stopCleanupTimer());
  const released: string[] = [];
  manager.onSessionRelease((sessionId, _deviceId, reason) => {
    released.push(`${sessionId}:${reason}`);
  });
  await manager.createSession("s", DEVICE, "android", idleWindowMs);
  manager.recordHeartbeat("s");

  // The owner stays alive but makes no tool call, then dies.
  timer.advanceTime(idleBeforeOwnerLossMs);
  manager.recordHeartbeat("s");

  // A rebind whose write does not return: the release that follows waits on it ("awaiting-rebind").
  const parked = Promise.withResolvers<void>();
  persistence.parkUpsert = parked.promise;
  void manager.rebindSession("s", "emulator-5556", "android").catch(() => undefined);
  await drainMicrotasks(20);

  const forced: string[] = [];
  const result: StuckRelease = {
    forced,
    forcedAt: [],
    released,
    reapedAt: undefined,
    idleReleaseStartedAt: undefined,
    manager,
    timer,
    runFor: async (ms) => {
      const until = timer.now() + ms;
      while (timer.now() < until) {
        if (options.ownerKeepsHeartbeating) {
          // A no-op once the session is releasing, exactly as the daemon's heartbeat handler is.
          manager.recordHeartbeat("s");
        }
        await timer.advanceTimeAsync(SCAN_MS, () => drainMicrotasks(20));
        result.idleReleaseStartedAt ??= manager.getIdleReleasesInProgress()[0]?.startedAtMs;
      }
    },
    unwedge: async () => {
      parked.resolve();
      await drainMicrotasks(200);
    },
  };
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async (sessionId, reason) => {
      result.reapedAt = timer.now();
      await manager.releaseSession(sessionId, reason);
    },
    timer,
    {
      forceStuckRelease: async (sessionId) => {
        forced.push(sessionId);
        result.forcedAt.push(timer.now());
        manager.forceStuckRelease(sessionId);
      },
    },
  );
  monitor.start();
  cleanups.push(() => void monitor.stop());

  await result.runFor(NO_HEARTBEAT_RELEASE_BUDGET_MS + STUCK_REAP_WARN_MS + 2 * SCAN_MS);
  return result;
}

/** Run `body` with warnings silenced: every case here logs the stuck release. */
async function quietly(body: () => Promise<void>): Promise<void> {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await body();
  } finally {
    warn.mockRestore();
  }
}

describe("a stuck heartbeat release is forced whatever the session's idle deadline", () => {
  test("control: forced when the idle deadline is still far away", async () => {
    await quietly(async () => {
      const result = await stuckRelease(600_000, 90_000);
      expect(result.reapedAt).toBeLessThanOrEqual(90_000 + NO_HEARTBEAT_RELEASE_BUDGET_MS);
      expect(result.forced).toEqual(["s"]);
      expect(result.manager.getSessionForDevice(DEVICE)).toBeNull();
    });
  });

  test("forced when the idle deadline passes while the release is stuck", async () => {
    await quietly(async () => {
      // Default 2-minute idle window; the owner dies 90 s after its last tool call, so the idle
      // deadline (120 s) falls between the reap (~100 s) and the stuck deadline (~140 s).
      const result = await stuckRelease(DEFAULT_SESSION_IDLE_TIMEOUT_MS, 90_000);
      expect(result.reapedAt).toBeLessThanOrEqual(90_000 + NO_HEARTBEAT_RELEASE_BUDGET_MS);
      expect(result.forced).toEqual(["s"]);
      expect(result.manager.getSessionForDevice(DEVICE)).toBeNull();
      // The forced release keeps the reason the stuck release carried (#11361).
      expect(result.released).toEqual(["s:heartbeat-timeout"]);
    });
  });

  test("forced once; the wedged release completing later releases nothing again", async () => {
    await quietly(async () => {
      const result = await stuckRelease(DEFAULT_SESSION_IDLE_TIMEOUT_MS, 90_000);
      await result.runFor(2 * STUCK_REAP_WARN_MS);
      expect(result.forced).toEqual(["s"]);

      await result.unwedge();
      await result.runFor(2 * STUCK_REAP_WARN_MS);
      expect(result.forced).toEqual(["s"]);
      expect(result.released).toEqual(["s:heartbeat-timeout"]);
      expect(result.manager.getSessionForDevice(DEVICE)).toBeNull();
      expect(result.manager.getIdleReleasesInProgress()).toEqual([]);
    });
  });
});

describe("a stuck idle release is held to the same deadline", () => {
  /** The owner keeps heartbeating and makes no tool call: the idle sweep releases the session. */
  const idleRelease = () =>
    stuckRelease(DEFAULT_SESSION_IDLE_TIMEOUT_MS, DEFAULT_SESSION_IDLE_TIMEOUT_MS, {
      ownerKeepsHeartbeating: true,
    });

  test("an idle release that is stuck is forced too", async () => {
    await quietly(async () => {
      // The idle sweep (which the monitor runs on every scan) releases the session at its
      // 2-minute deadline. That release wedges the same way, and is not one of the monitor's reaps.
      const result = await idleRelease();
      expect(result.reapedAt).toBeUndefined();
      expect(result.manager.getSessionForDevice(DEVICE)).toBeNull();
      expect(result.forced).toEqual(["s"]);
      expect(result.released).toEqual(["s:cleanup-expired"]);
    });
  });

  test("not before the stuck deadline, and at the first scan past it", async () => {
    await quietly(async () => {
      const result = await idleRelease();
      const startedAt = result.idleReleaseStartedAt ?? Number.NaN;
      // Released by the first scan past the idle deadline, then forced by the first scan past
      // the release's own stuck deadline.
      expect(startedAt).toBeGreaterThan(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
      expect(startedAt).toBeLessThanOrEqual(DEFAULT_SESSION_IDLE_TIMEOUT_MS + SCAN_MS);
      expect(result.forcedAt).toHaveLength(1);
      expect(result.forcedAt[0]).toBeGreaterThanOrEqual(startedAt + STUCK_REAP_WARN_MS);
      expect(result.forcedAt[0]).toBeLessThan(startedAt + STUCK_REAP_WARN_MS + SCAN_MS);
    });
  });

  test("forced once; the wedged release completing later releases nothing again", async () => {
    await quietly(async () => {
      const result = await idleRelease();
      await result.runFor(2 * STUCK_REAP_WARN_MS);
      expect(result.forced).toEqual(["s"]);

      await result.unwedge();
      await result.runFor(2 * STUCK_REAP_WARN_MS);
      expect(result.forced).toEqual(["s"]);
      expect(result.released).toEqual(["s:cleanup-expired"]);
      expect(result.manager.getSessionForDevice(DEVICE)).toBeNull();
      expect(result.manager.getIdleReleasesInProgress()).toEqual([]);
    });
  });

  test("an idle release that settles in time is never forced", async () => {
    await quietly(async () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(0);
      const manager = new SessionManager(
        timer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
      );
      cleanups.push(() => manager.stopCleanupTimer());
      await manager.createSession("s", DEVICE, "android", DEFAULT_SESSION_IDLE_TIMEOUT_MS);
      const forced: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        manager,
        () => false,
        async () => {},
        timer,
        {
          forceStuckRelease: async (sessionId) => {
            forced.push(sessionId);
          },
        },
      );
      monitor.start();
      cleanups.push(() => void monitor.stop());
      const until = DEFAULT_SESSION_IDLE_TIMEOUT_MS + 2 * STUCK_REAP_WARN_MS;
      while (timer.now() < until) {
        manager.recordHeartbeat("s");
        await timer.advanceTimeAsync(SCAN_MS, () => drainMicrotasks(20));
      }
      expect(manager.getSessionForDevice(DEVICE)).toBeNull();
      expect(forced).toEqual([]);
    });
  });
});
