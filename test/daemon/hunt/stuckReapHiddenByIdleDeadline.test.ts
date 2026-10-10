import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  STUCK_REAP_WARN_MS,
  SessionHeartbeatMonitor,
} from "../../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  NO_HEARTBEAT_RELEASE_BUDGET_MS,
} from "../../../src/daemon/sessionLivenessWindows";
import type { DeviceSessionRecord } from "../../../src/db/deviceSessionRepository";
import { logger } from "../../../src/utils/logger";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

// Hunt: the monitor forces a release that is stuck past STUCK_REAP_WARN_MS (#10963), but it only
// looks at the sessions `getAllSessions()` returns, and that hides a session whose idle deadline
// has passed. A heartbeat release that wedges inside the session manager for a session that was
// already most of the way through its idle window is therefore never forced: once `expiresAt`
// passes, the session is invisible to the scan (and the idle sweep skips it because it is already
// releasing), so its device stays held for as long as the release stays wedged.

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

/**
 * One owned, heartbeating session whose last tool call was `idleBeforeOwnerLossMs` ago when its
 * owner stops heartbeating, and whose release wedges inside the session manager (it waits on a
 * device rebind whose DB write never returns). Returns the sessions the monitor forced.
 */
async function forcedAfterStuckDeadline(
  idleWindowMs: number,
  idleBeforeOwnerLossMs: number,
): Promise<{ forced: string[]; reapedAt: number | undefined; heldDevice: string | null }> {
  const timer = new FakeTimer();
  timer.setCurrentTime(0);
  const persistence = new ParkablePersistence();
  const manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
  cleanups.push(() => manager.stopCleanupTimer());
  await manager.createSession("s", DEVICE, "android", idleWindowMs);
  manager.recordHeartbeat("s");

  // The owner stays alive but makes no tool call, then dies.
  timer.advanceTime(idleBeforeOwnerLossMs);
  manager.recordHeartbeat("s");

  // A rebind whose write never returns: the release that follows waits on it ("awaiting-rebind").
  persistence.parkUpsert = new Promise<void>(() => {});
  void manager.rebindSession("s", "emulator-5556", "android").catch(() => undefined);
  await drainMicrotasks(20);

  const forced: string[] = [];
  let reapedAt: number | undefined;
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async (sessionId, reason) => {
      reapedAt = timer.now();
      await manager.releaseSession(sessionId, reason);
    },
    timer,
    {
      forceStuckRelease: async (sessionId) => {
        forced.push(sessionId);
        manager.forceStuckRelease(sessionId);
      },
    },
  );
  monitor.start();
  cleanups.push(() => void monitor.stop());

  const until =
    idleBeforeOwnerLossMs + NO_HEARTBEAT_RELEASE_BUDGET_MS + STUCK_REAP_WARN_MS + 2 * SCAN_MS;
  while (timer.now() < until) {
    await timer.advanceTimeAsync(SCAN_MS, () => drainMicrotasks(20));
  }
  return { forced, reapedAt, heldDevice: manager.getSessionForDevice(DEVICE) };
}

describe("a stuck heartbeat release is forced whatever the session's idle deadline", () => {
  test("control: forced when the idle deadline is still far away", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await forcedAfterStuckDeadline(600_000, 90_000);
      expect(result.reapedAt).toBeLessThanOrEqual(90_000 + NO_HEARTBEAT_RELEASE_BUDGET_MS);
      expect(result.forced).toEqual(["s"]);
      expect(result.heldDevice).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test("forced when the idle deadline passes while the release is stuck", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      // Default 2-minute idle window; the owner dies 90 s after its last tool call, so the idle
      // deadline (120 s) falls between the reap (~100 s) and the stuck deadline (~140 s).
      const result = await forcedAfterStuckDeadline(DEFAULT_SESSION_IDLE_TIMEOUT_MS, 90_000);
      expect(result.reapedAt).toBeLessThanOrEqual(90_000 + NO_HEARTBEAT_RELEASE_BUDGET_MS);
      expect(result.forced).toEqual(["s"]);
      expect(result.heldDevice).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
