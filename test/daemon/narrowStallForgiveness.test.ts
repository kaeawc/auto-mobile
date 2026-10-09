import { afterEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  NO_HEARTBEAT_RELEASE_BUDGET_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
  SUSPECT_GRACE_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #11080 (owner decision 2026-10-09): stall forgiveness is narrow, and lease and idle deltas come
// from the monotonic clock. A daemon stall is forgiven for a session only when it began within one
// lease of that owner's last heartbeat, so a dead owner is released near the no-heartbeat budget
// even while every scan arrives late, while a live owner still survives the stall. A wall-clock
// step moves neither a lease nor an idle window (on darwin a forward step reads as host sleep).

const SESSION = "narrow-stall-session";
const DEVICE = "emulator-5554";
const OWNER = "narrow-stall-owner";
const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
const IDLE_MS = 60_000;

const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
};

interface Rig {
  timer: FakeTimer;
  manager: SessionManager;
  monitor: SessionHeartbeatMonitor;
  reaped: string[];
  heartbeat(): Promise<boolean>;
  /** Elapsed time on the monotonic clock, unaffected by wall-clock steps. */
  elapsed(): number;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.monitor.stop();
  rig?.manager.stopCleanupTimer();
  rig = undefined;
});

async function setUp(options: { sleepCountingClock?: boolean } = {}): Promise<Rig> {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  if (options.sleepCountingClock) {
    timer.simulateSleepCountingMonotonicClock();
  }
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const reaped: string[] = [];
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async (sessionId, reason) => {
      reaped.push(reason);
      await manager.releaseSession(sessionId, reason);
    },
    timer,
  );
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => DEVICE_POOL,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
  const heartbeat = async () =>
    (
      await handleDaemonRequest(
        {
          id: "heartbeat",
          type: "daemon_request",
          method: "daemon/heartbeat",
          params: { sessionId: SESSION, livenessOwnerToken: OWNER },
        },
        state,
      )
    ).success;
  await manager.createSession(SESSION, DEVICE, "android", IDLE_MS);
  expect(await heartbeat()).toBe(true);
  const startedAt = timer.monotonicNow();
  monitor.start();
  rig = {
    timer,
    manager,
    monitor,
    reaped,
    heartbeat,
    elapsed: () => timer.monotonicNow() - startedAt,
  };
  return rig;
}

/** Run scans that each fire `lateMs` late until the session is released; returns when. */
async function lateScansUntilRelease(r: Rig, lateMs: number, maxScans = 50): Promise<number> {
  for (let scan = 0; scan < maxScans; scan++) {
    r.timer.setCurrentTime(r.timer.getCurrentTime() + SCAN_MS + lateMs);
    await r.monitor.tick();
    if (r.manager.getSession(SESSION) === null) {
      return r.elapsed();
    }
  }
  throw new Error(`session still held after ${maxScans} late scans`);
}

describe("narrow stall forgiveness on a slow daemon (#11080)", () => {
  for (const lateMs of [3_000, 8_000]) {
    test(`a dead owner is released within the no-heartbeat budget plus one scan when every scan is ${lateMs} ms late`, async () => {
      const r = await setUp();

      const releasedAfter = await lateScansUntilRelease(r, lateMs);

      // Before #11080 every late scan was forgiven in full and this took ~5 x (2 s + L).
      expect(releasedAfter).toBeLessThanOrEqual(NO_HEARTBEAT_RELEASE_BUDGET_MS + SCAN_MS + lateMs);
      expect(r.reaped).toEqual(["heartbeat-timeout"]);
    });

    test(`a live owner heartbeating between scans that are each ${lateMs} ms late is never released`, async () => {
      const r = await setUp();
      const session = r.manager.getSession(SESSION);

      for (let scan = 0; scan < 20; scan++) {
        r.timer.setCurrentTime(r.timer.getCurrentTime() + SCAN_MS + lateMs);
        // The scan runs before the owner's buffered heartbeat: the worse order for the owner.
        await r.monitor.tick();
        expect(await r.heartbeat()).toBe(true);
      }

      expect(r.reaped).toEqual([]);
      expect(r.manager.getSession(SESSION)).toBe(session);
    });
  }

  test("a long stall that begins while the owner is live is forgiven in full", async () => {
    const r = await setUp();
    const session = r.manager.getSession(SESSION);
    r.timer.setCurrentTime(r.timer.getCurrentTime() + PROXY_HEARTBEAT_INTERVAL_MS);
    expect(await r.heartbeat()).toBe(true);

    r.timer.setCurrentTime(r.timer.getCurrentTime() + 25_000);
    await r.monitor.tick();

    expect(r.reaped).toEqual([]);
    expect(r.manager.getSessionLeaseState(SESSION)?.phase).toBe("live");
    expect(await r.heartbeat()).toBe(true);
    expect(r.manager.getSession(SESSION)).toBe(session);
  });

  test("an owner that heartbeats only after its lease ran out gets no stall it did not need", async () => {
    const r = await setUp();
    // On-time scans with no heartbeat until the lease (4 s) has run out.
    for (let scan = 0; scan < 3; scan++) {
      r.timer.setCurrentTime(r.timer.getCurrentTime() + SCAN_MS);
      await r.monitor.tick();
    }
    const session = r.manager.getSession(SESSION);
    expect(r.manager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");

    r.timer.setCurrentTime(r.timer.getCurrentTime() + SCAN_MS + 8_000);
    r.manager.getSession(SESSION);

    expect(session?.stallForgivenAt).toBeUndefined();
  });
});

describe("wall-clock steps do not move leases (#11080)", () => {
  for (const sleepCountingClock of [false, true]) {
    const platform = sleepCountingClock ? "Linux/Windows clock" : "darwin clock";

    test(`a backward step does not extend a dead owner's hold (${platform})`, async () => {
      const r = await setUp({ sleepCountingClock });
      r.timer.stepWallClock(-60_000);

      const releasedAfter = await lateScansUntilRelease(r, 0);

      expect(releasedAfter).toBeLessThanOrEqual(NO_HEARTBEAT_RELEASE_BUDGET_MS + SCAN_MS);
      expect(r.reaped).toEqual(["heartbeat-timeout"]);
    });

    test(`a backward step does not blind the stall detector (${platform})`, async () => {
      const r = await setUp({ sleepCountingClock });
      r.timer.stepWallClock(-60_000);
      r.timer.setCurrentTime(r.timer.getCurrentTime() + PROXY_HEARTBEAT_INTERVAL_MS);
      expect(await r.heartbeat()).toBe(true);

      r.timer.setCurrentTime(r.timer.getCurrentTime() + 20_000);
      await r.monitor.tick();

      expect(r.reaped).toEqual([]);
      expect(await r.heartbeat()).toBe(true);
    });

    test(`a heartbeating owner survives a backward and a forward step (${platform})`, async () => {
      const r = await setUp({ sleepCountingClock });
      const session = r.manager.getSession(SESSION);

      // Forward by less than the idle window: on darwin it reads as that much host sleep.
      for (const step of [-60_000, 0, 20_000, 0, -5_000]) {
        r.timer.stepWallClock(step);
        r.timer.setCurrentTime(r.timer.getCurrentTime() + SCAN_MS);
        await r.monitor.tick();
        expect(await r.heartbeat()).toBe(true);
      }

      expect(r.reaped).toEqual([]);
      expect(r.manager.getSession(SESSION)).toBe(session);
    });

    test(`a backward step does not lengthen the idle window (${platform})`, async () => {
      const r = await setUp({ sleepCountingClock });
      r.timer.stepWallClock(-30_000);

      let releasedAfter: number | undefined;
      while (releasedAfter === undefined) {
        r.timer.setCurrentTime(r.timer.getCurrentTime() + SCAN_MS);
        await r.monitor.tick();
        if (r.manager.getSession(SESSION) === null) {
          releasedAfter = r.elapsed();
        } else {
          expect(await r.heartbeat()).toBe(true);
        }
        expect(r.elapsed()).toBeLessThanOrEqual(IDLE_MS + SUSPECT_GRACE_MS + SCAN_MS);
      }

      // Heartbeats prove liveness, not use: released at the idle window, not 30 s later.
      expect(releasedAfter).toBeGreaterThan(IDLE_MS - SCAN_MS);
    });
  }

  test("a forward step is ignored where the monotonic clock runs through sleep", async () => {
    const r = await setUp({ sleepCountingClock: true });
    const session = r.manager.getSession(SESSION)!;
    const expiresAt = session.expiresAt;

    r.timer.stepWallClock(45_000);
    r.timer.setCurrentTime(r.timer.getCurrentTime() + SCAN_MS);
    await r.monitor.tick();

    expect(r.manager.getSession(SESSION)).toBe(session);
    expect(session.stallForgivenAt).toBeUndefined();
    expect(session.expiresAt).toBe(expiresAt);
    expect(r.manager.sessionNow() - expiresAt).toBe(SCAN_MS - IDLE_MS);
  });

  test("on darwin a forward step reads as host sleep: idle counts it, the live owner's lease does not", async () => {
    const r = await setUp();
    const session = r.manager.getSession(SESSION)!;

    r.timer.stepWallClock(45_000);
    r.timer.setCurrentTime(r.timer.getCurrentTime() + SCAN_MS);
    await r.monitor.tick();

    // Indistinguishable from a 45 s sleep: the lease is excused, the idle window is not.
    expect(r.manager.getSession(SESSION)).toBe(session);
    expect(r.manager.sessionNow() - session.expiresAt).toBe(45_000 + SCAN_MS - IDLE_MS);
    expect(await r.heartbeat()).toBe(true);
  });
});
