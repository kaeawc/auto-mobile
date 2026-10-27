import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  STUCK_REAP_WARN_MS,
  SessionHeartbeatMonitor,
} from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { isTerminalReleaseReason } from "../../src/daemon/releaseReasons";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  NO_HEARTBEAT_RELEASE_BUDGET_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
} from "../../src/daemon/wire/sessionLivenessWindows";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// #11554 (hunt 2026-10-10, heartbeat lease, daemon side). A session stays in the session map for the whole
// awaited teardown of its release, and for that whole time its owner's heartbeats are answered
// "Session not found" (`isSessionReleasing`) and stamp nothing. The heartbeat monitor still judges
// it: `reapStaleSessions` skips only its own reaps, never a session another release is tearing
// down. Once the teardown outlasts lease + grace (a clock restore alone is awaited for up to
// CLOCK_RESTORE_TIMEOUT_MS = 15 s), the monitor "reaped" the releasing session as
// `heartbeat-timeout`, and `upgradeReleaseReason` let that terminal reason replace the
// non-terminal one the release was started with.
//
// So a recoverable handoff (`device-restart:<id>`, which the owner is meant to resume by naming the
// UUID) or a re-issuable `plan-auto-release` of a session whose owner never stopped heartbeating is
// was recorded and announced as a terminal heartbeat loss: the UUID was fenced and the owner's
// next call got `session_ownership_lost` / `acquire_new_session`.
//
// The monitor now judges a session with a non-terminal release in progress as of the instant that
// release began (heartbeats are refused from then on), and holds the release to the stuck
// deadline from its own start, since no monitor reap joins it any more.

const SESSION = "hunt-releasing-session";
const DEVICE = "emulator-5554";
const OWNER = "hunt-owner-token";
const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
/** A slow, but successful, clock restore: under its own 15 s budget, over lease + grace. */
const CLOCK_RESTORE_MS = 11_000;

const DEVICE_POOL = {
  refreshDevices: async () => 0,
  releaseDevice: async () => {},
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
};

describe("a non-terminal release whose teardown outlasts lease + grace, owner still heartbeating", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let reaped: string[];
  let announced: string[];

  function heartbeat() {
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => DEVICE_POOL,
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    return handleDaemonRequest(
      {
        id: "heartbeat",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: { sessionId: SESSION, livenessOwnerToken: OWNER },
      },
      state,
    );
  }

  /** The owner's proxy heartbeats on its cadence while the daemon's scans run on theirs. */
  async function ownerKeepsHeartbeatingFor(ms: number): Promise<boolean[]> {
    const acks: boolean[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += PROXY_HEARTBEAT_INTERVAL_MS) {
      acks.push((await heartbeat()).success);
      await timer.advanceTimeAsync(PROXY_HEARTBEAT_INTERVAL_MS, () => drainMicrotasks(50));
    }
    return acks;
  }

  beforeEach(async () => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
      restorers: {
        networkCondition: () => ({ restore: async () => undefined }),
        // `adb unroot` restarts adbd; the restore finishes only once the device reconnects.
        clock: () => ({ restore: () => timer.sleep(CLOCK_RESTORE_MS) }),
      },
    });
    manager.stopCleanupTimer();
    reaped = [];
    announced = [];
    manager.onSessionRelease((_sessionId, _deviceId, releaseReason) => {
      announced.push(releaseReason);
    });
    // Wired as the daemon wires it: the reap is a release with the monitor's reason.
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        reaped.push(reason);
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
    const session = await manager.createSession(SESSION, DEVICE, "android");
    manager.setClock(session, {
      initialAutomaticTime: 1,
      clockChangedByUs: true,
      rootedByUs: true,
    });
    expect(await manager.claimLivenessOwnership(SESSION, OWNER)).toBe("claimed");
    monitor.start();
    // A healthy owner: every heartbeat is acknowledged and nothing is reaped.
    expect(await ownerKeepsHeartbeatingFor(3 * SCAN_MS)).toEqual([true, true, true]);
    expect(reaped).toEqual([]);
  });

  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  test.each(["device-restart:Pixel_A", "plan-auto-release"] as const)(
    "%s is not rewritten into a terminal heartbeat-timeout",
    async (releaseReason) => {
      expect(isTerminalReleaseReason(releaseReason)).toBe(false);

      const release = manager.releaseSession(SESSION, releaseReason);
      // The owner is alive the whole time; the daemon just does not accept its heartbeats.
      const acks = await ownerKeepsHeartbeatingFor(CLOCK_RESTORE_MS + SCAN_MS);
      expect(await release).toBe(DEVICE);
      expect(acks.every((acknowledged) => !acknowledged)).toBe(true);

      // The release keeps the reason it was started with, and nothing terminal is raised: the
      // UUID stays recoverable / re-issuable by name.
      expect({
        announced,
        recorded: await manager.getReleasedSessionReason(SESSION),
        terminalFence: manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason,
        // The monitor must not release, on the owner's "silence", a session whose heartbeats
        // the daemon itself was refusing.
        reaped,
      }).toEqual({
        announced: [releaseReason],
        recorded: releaseReason,
        terminalFence: undefined,
        reaped: [],
      });
    },
  );
});

/** Session writes can be parked, like a wedged SQLite write. */
class ParkablePersistence extends FakeDeviceSessionPersistence {
  parkUpsert: Promise<void> | undefined;

  override async upsertActiveSession(
    ...args: Parameters<FakeDeviceSessionPersistence["upsertActiveSession"]>
  ): Promise<number> {
    await this.parkUpsert;
    return super.upsertActiveSession(...args);
  }
}

describe("a non-terminal release and the bounds the heartbeat monitor still keeps", () => {
  const RELEASE_REASON = "device-restart:Pixel_A";
  let timer: FakeTimer;
  let persistence: ParkablePersistence;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let reaped: string[];
  let forcedAt: number[];
  let announced: string[];
  /** A control call in flight on the session: it vetoes the monitor's own reap. */
  let callInFlight: boolean;

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(0);
    callInFlight = false;
    persistence = new ParkablePersistence();
    manager = new SessionManager(timer, persistence, {
      barrier: () => new FakeDbWriteBarrier(),
      restorers: {
        networkCondition: () => ({ restore: async () => undefined }),
        clock: () => ({ restore: () => timer.sleep(SCAN_MS / 2) }),
      },
    });
    manager.stopCleanupTimer();
    reaped = [];
    forcedAt = [];
    announced = [];
    manager.onSessionRelease((_sessionId, _deviceId, releaseReason) => {
      announced.push(releaseReason);
    });
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => callInFlight,
      async (sessionId, reason) => {
        reaped.push(reason);
        await manager.releaseSession(sessionId, reason);
      },
      timer,
      {
        forceStuckRelease: async (sessionId) => {
          forcedAt.push(timer.now());
          manager.forceStuckRelease(sessionId);
        },
      },
    );
    await manager.createSession(SESSION, DEVICE, "android");
    expect(await manager.claimLivenessOwnership(SESSION, OWNER)).toBe("claimed");
    await deliverDaemonHeartbeat(manager, SESSION, { livenessOwnerToken: OWNER });
  });

  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  test("a wedged release is forced at the stuck deadline from its own start and stays recoverable", async () => {
    monitor.start();
    // A rebind whose write never returns: the release that follows waits on it and never settles.
    persistence.parkUpsert = new Promise<void>(() => undefined);
    void manager.rebindSession(SESSION, "emulator-5556", "android").catch(() => undefined);
    await drainMicrotasks(20);
    const releaseStartedAt = timer.now();
    void manager.releaseSession(SESSION, RELEASE_REASON).catch(() => undefined);

    await timer.advanceTimeAsync(STUCK_REAP_WARN_MS - SCAN_MS, () => drainMicrotasks(20));
    expect({ forcedAt, reaped }).toEqual({ forcedAt: [], reaped: [] });
    await timer.advanceTimeAsync(2 * SCAN_MS, () => drainMicrotasks(20));

    // Forced once, within one scan of the deadline measured from the release's own start: the
    // device does not stay held for as long as the teardown stays wedged.
    expect(forcedAt).toHaveLength(1);
    expect(forcedAt[0] - releaseStartedAt).toBeGreaterThanOrEqual(STUCK_REAP_WARN_MS);
    expect(forcedAt[0] - releaseStartedAt).toBeLessThanOrEqual(STUCK_REAP_WARN_MS + SCAN_MS);
    expect({
      announced,
      reaped,
      held: manager.getSessionForDevice(DEVICE),
      terminalFence: manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason,
    }).toEqual({ announced: [RELEASE_REASON], reaped: [], held: null, terminalFence: undefined });
  });

  test("a wedged release a joiner upgrades to a terminal reason is still forced at its own deadline", async () => {
    // The plan's own call is still in flight, so the monitor never starts a reap of its own that
    // would track the release instead.
    callInFlight = true;
    monitor.start();
    persistence.parkUpsert = new Promise<void>(() => undefined);
    void manager.rebindSession(SESSION, "emulator-5556", "android").catch(() => undefined);
    await drainMicrotasks(20);
    const releaseStartedAt = timer.now();
    void manager.releaseSession(SESSION, RELEASE_REASON).catch(() => undefined);
    await timer.advanceTimeAsync(2 * SCAN_MS, () => drainMicrotasks(20));

    // The owner's connection drops: its release joins the wedged one and upgrades the reason.
    void manager.releaseSession(SESSION, "owner-disconnected").catch(() => undefined);
    await timer.advanceTimeAsync(STUCK_REAP_WARN_MS - 3 * SCAN_MS, () => drainMicrotasks(20));
    expect({ forcedAt, reaped }).toEqual({ forcedAt: [], reaped: [] });
    await timer.advanceTimeAsync(2 * SCAN_MS, () => drainMicrotasks(20));

    // Still held to the deadline of the release's own start, and forced with the reason the
    // release carries by then: the upgrade must not hide a wedged release from the monitor.
    expect(forcedAt).toHaveLength(1);
    expect(forcedAt[0] - releaseStartedAt).toBeGreaterThanOrEqual(STUCK_REAP_WARN_MS);
    expect(forcedAt[0] - releaseStartedAt).toBeLessThanOrEqual(STUCK_REAP_WARN_MS + SCAN_MS);
    expect({
      announced,
      reaped,
      held: manager.getSessionForDevice(DEVICE),
      terminalFence: manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason,
    }).toEqual({
      announced: ["owner-disconnected"],
      reaped: [],
      held: null,
      terminalFence: "owner-disconnected",
    });

    // Forced once: later scans do not force the same release again.
    await timer.advanceTimeAsync(STUCK_REAP_WARN_MS + 2 * SCAN_MS, () => drainMicrotasks(20));
    expect(forcedAt).toHaveLength(1);
  });

  test("the source names one release in progress: its session, its start, while it holds the device", async () => {
    persistence.parkUpsert = new Promise<void>(() => undefined);
    void manager.rebindSession(SESSION, "emulator-5556", "android").catch(() => undefined);
    await drainMicrotasks(20);
    void manager.releaseSession(SESSION, RELEASE_REASON).catch(() => undefined);
    const [{ startedAtMs }] = manager.getNonTerminalReleasesInProgress();
    void manager.releaseSession(SESSION, "owner-disconnected").catch(() => undefined);

    const whileWedged = {
      upgradedStillListed: manager.getNonTerminalReleasesInProgress().length,
      thisRelease: manager.isReleaseInProgress(SESSION, startedAtMs),
      // A release of the same session id that began at another instant is another release.
      anotherStart: manager.isReleaseInProgress(SESSION, startedAtMs + 1),
      anotherSession: manager.isReleaseInProgress("another-session", startedAtMs),
    };
    manager.forceStuckRelease(SESSION);

    expect({
      ...whileWedged,
      onceForced: manager.isReleaseInProgress(SESSION, startedAtMs),
    }).toEqual({
      upgradedStillListed: 0,
      thisRelease: true,
      anotherStart: false,
      anotherSession: false,
      // A forced release no longer holds its device: the monitor forgets it, so it is forced once.
      onceForced: false,
    });
  });

  test("a new release of the same session id is held to its own deadline, not the settled one's", async () => {
    monitor.start();
    const first = manager.releaseSession(SESSION, RELEASE_REASON);
    await timer.advanceTimeAsync(2 * SCAN_MS, () => drainMicrotasks(20));
    expect(await first).toBe(DEVICE);

    // The same UUID is issued again and its release wedges, much later than the first one began.
    await timer.advanceTimeAsync(STUCK_REAP_WARN_MS / 2, () => drainMicrotasks(20));
    await manager.createSession(SESSION, DEVICE, "android");
    await deliverDaemonHeartbeat(manager, SESSION);
    persistence.parkUpsert = new Promise<void>(() => undefined);
    void manager.rebindSession(SESSION, "emulator-5556", "android").catch(() => undefined);
    await drainMicrotasks(20);
    const secondStartedAt = timer.now();
    void manager.releaseSession(SESSION, RELEASE_REASON).catch(() => undefined);

    await timer.advanceTimeAsync(STUCK_REAP_WARN_MS - SCAN_MS, () => drainMicrotasks(20));
    expect(forcedAt).toEqual([]);
    await timer.advanceTimeAsync(2 * SCAN_MS, () => drainMicrotasks(20));
    expect(forcedAt).toHaveLength(1);
    expect(forcedAt[0] - secondStartedAt).toBeGreaterThanOrEqual(STUCK_REAP_WARN_MS);
  });

  test("an owner that had already lost its lease when the release began is still reaped", async () => {
    // The owner went silent for the whole budget while its heartbeats were still accepted; no
    // scan ran in between (as when an in-flight call vetoes the reap).
    timer.advanceTime(NO_HEARTBEAT_RELEASE_BUDGET_MS + 1);
    const session = manager.getSession(SESSION);
    expect(session).not.toBeNull();
    if (session) {
      manager.setClock(session, {
        initialAutomaticTime: 1,
        clockChangedByUs: true,
        rootedByUs: true,
      });
    }
    const release = manager.releaseSession(SESSION, RELEASE_REASON);

    const tick = monitor.tick();
    await drainMicrotasks(50);
    await timer.advanceTimeAsync(SCAN_MS, () => drainMicrotasks(50));
    await tick;

    expect(await release).toBe(DEVICE);
    expect({ reaped, recorded: await manager.getReleasedSessionReason(SESSION) }).toEqual({
      reaped: ["heartbeat-timeout"],
      recorded: "heartbeat-timeout",
    });
  });
});
