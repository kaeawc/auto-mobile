import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  cancelAndReleaseSession,
  releaseSessionAndDevice,
} from "../../src/daemon/releaseSessionAndDevice";
import {
  DEFAULT_STALL_MARGIN_MS,
  SessionHeartbeatMonitor,
} from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { executionTracker } from "../../src/server/executionTracker";
import type { Timer } from "../../src/utils/SystemTimer";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// H8 (stall forgiveness resets the awaiting-owner clock).
//
// After a daemon restart, a session whose owner is gone (Claude Code closed during the restart)
// is rehydrated `awaiting-owner` and should be reaped `rehydration-owner-timeout` once
// `heartbeatTimeoutMs` (10 s) passes with no owner. Since #10115 (5147bbad), a monitor tick that
// fires more than DEFAULT_STALL_MARGIN_MS (2 s) late calls SessionManager.forgiveDaemonStall,
// whose doc comment promises to move each lease "forward by exactly the lost interval". It instead
// RESETS `awaitingOwnerSince` to the resume time and `expiresAt` to resume + sessionTimeoutMs
// (src/daemon/sessionManager.ts:5653-5668), and the reap decision in the same tick
// (SessionHeartbeatMonitor.rehydrationOwnerStaleReason, src/daemon/SessionHeartbeatMonitor.ts:281-292)
// then sees an age of 0. While ticks keep arriving late, the session and its device are held
// indefinitely: neither the owner timeout nor the 30-minute idle backstop ever arrives.
//
// What is real here: SessionManager (daemon-1 creation, daemon-shutdown release, daemon-2
// rehydration, forgiveDaemonStall, cleanupExpiredSessions), DevicePool (assignment, rehydrated
// binding, release), the daemon/heartbeat request handler (the owner's claim in daemon 1),
// SessionHeartbeatMonitor with its real SingleFlightInterval scheduled on the timer, and the reap
// composition Daemon.cancelAndReleaseSession uses (cancelAndReleaseSession +
// releaseSessionAndDevice + SessionManager.releaseSession + DevicePool.releaseDevice).
// What is faked: the clock (FakeTimer under HostClock), DB persistence (FakeDeviceSessionPersistence),
// the write barrier (FakeDbWriteBarrier) and device discovery (FakeDeviceUtils).

const SESSION = "6f1c2f0e-7a51-4c55-9b3e-0d9d7c1a8e11";
const OWNER_TOKEN = "claude-code-proxy-keeper";
const DEVICE = { deviceId: "emulator-5554", name: "Pixel_8_API_35", platform: "android" as const };
const CHECK_INTERVAL_MS = 10_000; // SessionHeartbeatMonitor's production default
const LATE_MS = DEFAULT_STALL_MARGIN_MS + 500; // just over the stall margin
const OWNER_TIMEOUT_MS = SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // SessionManager.SESSION_TIMEOUT_MS
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Production's Timer reads two clocks: SystemTimer.now() is Date.now() (wall clock), while
 * setInterval runs on the runtime's monotonic event-loop clock. A host suspend/dark wake advances
 * the wall clock without advancing the monotonic schedule, and an event-loop stall delivers the
 * interval callback late; either way the monitor's next scheduled tick observes now() later than
 * its 10 s schedule. HostClock models exactly that split: every timer is scheduled on the
 * FakeTimer (monotonic), and now() adds the wall-clock time the schedule did not see.
 */
class HostClock implements Timer {
  private unscheduledMs = 0;
  readonly intervalFires = new Map<number, number>();

  constructor(readonly monotonic: FakeTimer) {}

  now(): number {
    return this.monotonic.now() + this.unscheduledMs;
  }

  sleep(ms: number): Promise<void> {
    return this.monotonic.sleep(ms);
  }

  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    return this.monotonic.setTimeout(callback, ms);
  }

  clearTimeout(handle: NodeJS.Timeout): void {
    this.monotonic.clearTimeout(handle);
  }

  setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    return this.monotonic.setInterval(() => {
      this.intervalFires.set(ms, (this.intervalFires.get(ms) ?? 0) + 1);
      callback();
    }, ms);
  }

  clearInterval(handle: NodeJS.Timeout): void {
    this.monotonic.clearInterval(handle);
  }

  /** Wall-clock time the event loop's timers did not see (host suspend, or a stall). */
  loseWallClock(ms: number): void {
    this.unscheduledMs += ms;
  }
}

interface Reap {
  reason: string;
  at: number;
}

interface Daemon {
  manager: SessionManager;
  pool: DevicePool;
}

interface RestartedDaemon extends Daemon {
  monitor: SessionHeartbeatMonitor;
  reaps: Reap[];
  restartedAt: number;
  forgiveDaemonStall: ReturnType<typeof spyOn>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function bootDaemon(
  clock: HostClock,
  persistence: FakeDeviceSessionPersistence,
  daemonSessionId: string,
): Promise<Daemon> {
  const manager = new SessionManager(clock, persistence, () => new FakeDbWriteBarrier());
  cleanups.push(async () => manager.stopCleanupTimer());
  const deviceManager = new FakeDeviceUtils();
  deviceManager.setBootedDevices("android", [DEVICE]);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, daemonSessionId, { timer: clock, deviceManager }),
  );
  await pool.initializeWithDevices([DEVICE]);
  return { manager, pool };
}

function heartbeatState({ manager, pool }: Daemon): DaemonStateAccess {
  return {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => pool,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
}

/** Daemon.cancelAndReleaseSession(sessionId, reason) as the heartbeat monitor calls it. */
async function daemonCancelAndRelease(
  { manager, pool }: Daemon,
  sessionId: string,
  reason: string,
  allowExpired = false,
): Promise<void> {
  await cancelAndReleaseSession(sessionId, reason, async () => {
    const assignedDeviceId =
      pool.getAllDevices().find((device) => device.sessionId === sessionId)?.id ?? null;
    await releaseSessionAndDevice(manager, pool, assignedDeviceId, sessionId, reason, {
      release: async () => {
        const deviceId = await manager.releaseSession(sessionId, reason, allowExpired);
        return deviceId !== null && pool.getDevice(deviceId)?.sessionId === sessionId
          ? deviceId
          : null;
      },
    });
  });
}

/**
 * Daemon 1 assigns the device and the agent's proxy claims liveness ownership through the real
 * heartbeat handler. The daemon then restarts (shutdown releases with `daemon-shutdown`, the
 * recoverable reason) while Claude Code is closed, so nobody will ever heartbeat again. Daemon 2
 * rehydrates the persisted session and starts its heartbeat monitor, in production order.
 */
async function restartWithOwnerGone(): Promise<{ clock: HostClock; daemon: RestartedDaemon }> {
  const clock = new HostClock(new FakeTimer());
  clock.monotonic.setCurrentTime(1_000);
  const persistence = new FakeDeviceSessionPersistence();

  const first = await bootDaemon(clock, persistence, "daemon-1");
  await first.pool.assignDeviceToSession(SESSION, "android");
  const claim = await handleDaemonRequest(
    {
      id: "keeper-claim",
      type: "daemon_request",
      method: "daemon/heartbeat",
      params: { sessionId: SESSION, livenessOwnerToken: OWNER_TOKEN, claimLivenessOwnership: true },
    },
    heartbeatState(first),
  );
  expect(claim.success).toBe(true);
  clock.monotonic.advanceTime(3_000);
  await daemonCancelAndRelease(first, SESSION, "daemon-shutdown", true);
  expect(await persistence.getSession?.(SESSION)).toMatchObject({
    release_reason: "daemon-shutdown",
    liveness_owner_token: OWNER_TOKEN,
  });
  first.manager.stopCleanupTimer();

  clock.monotonic.advanceTime(5_000);
  const second = await bootDaemon(clock, persistence, "daemon-2");
  const summary = await second.manager.rehydratePersistedSessions(second.pool);
  expect(summary.rehydrated).toEqual([SESSION]);
  const restartedAt = clock.now();

  const reaps: Reap[] = [];
  const forgiveDaemonStall = spyOn(second.manager, "forgiveDaemonStall");
  // Daemon.startHeartbeatMonitor, with Daemon.hasActiveSessionExecution's checks.
  const monitor = new SessionHeartbeatMonitor(
    second.manager,
    (sessionId) =>
      second.pool.isSessionRecoveryInFlight(sessionId) ||
      executionTracker.hasActiveSessionUuidExecutions(sessionId) ||
      executionTracker.hasActiveAutolockSessionExecutions(sessionId),
    async (sessionId, reason) => {
      reaps.push({ reason, at: clock.now() });
      await daemonCancelAndRelease(second, sessionId, reason);
    },
    clock,
  );
  monitor.start();
  cleanups.push(() => monitor.stop());

  expect(second.manager.getSession(SESSION)).toMatchObject({
    ownership: "awaiting-owner",
    awaitingOwnerSince: restartedAt,
    livenessOwnerToken: OWNER_TOKEN,
    sessionTimeoutMs: SESSION_TIMEOUT_MS,
    heartbeatTimeoutMs: OWNER_TIMEOUT_MS,
  });
  expect(second.pool.getDevice(DEVICE.deviceId)).toMatchObject({
    status: "busy",
    sessionId: SESSION,
  });
  return {
    clock,
    daemon: { ...second, monitor, reaps, restartedAt, forgiveDaemonStall },
  };
}

/**
 * One monitor period: `lateMs` of wall-clock time the schedule does not see, then the monotonic
 * clock reaches the next 10 s slot and the REAL interval fires the tick. `tick()` joins that
 * in-flight tick (SingleFlightInterval.run shares it) so the reap it starts has settled.
 */
async function monitorPeriod(clock: HostClock, daemon: RestartedDaemon, lateMs: number) {
  clock.loseWallClock(lateMs);
  clock.monotonic.advanceTime(CHECK_INTERVAL_MS);
  await daemon.monitor.tick();
}

function heldBy(daemon: RestartedDaemon): void {
  expect(daemon.reaps).toEqual([]);
  expect(daemon.manager.getSession(SESSION)?.ownership).toBe("awaiting-owner");
  expect(daemon.pool.getDevice(DEVICE.deviceId)).toMatchObject({
    status: "busy",
    sessionId: SESSION,
  });
}

describe("H8: stall forgiveness resets the awaiting-owner clock of a rehydrated session", () => {
  test("control: on-time ticks reap an abandoned rehydration and free the device within 20s", async () => {
    const { clock, daemon } = await restartWithOwnerGone();

    for (let period = 0; period < 3 && daemon.reaps.length === 0; period++) {
      await monitorPeriod(clock, daemon, 0);
    }

    expect(daemon.reaps).toEqual([
      { reason: "rehydration-owner-timeout", at: daemon.restartedAt + 2 * CHECK_INTERVAL_MS },
    ]);
    expect(daemon.forgiveDaemonStall).not.toHaveBeenCalled();
    expect(clock.intervalFires.get(CHECK_INTERVAL_MS)).toBe(2);
    expect(daemon.manager.getSession(SESSION)).toBeNull();
    expect(daemon.pool.getDevice(DEVICE.deviceId)).toMatchObject({
      status: "idle",
      sessionId: null,
    });
  });

  test("one 2.5s-late tick moves awaitingOwnerSince by the whole 22.5s the owner was gone, not by 2.5s", async () => {
    const { clock, daemon } = await restartWithOwnerGone();

    await monitorPeriod(clock, daemon, 0); // restart + 10 s: owner missing 10 s, not yet > 10 s
    await monitorPeriod(clock, daemon, LATE_MS); // restart + 22.5 s, of which 2.5 s was the stall

    expect(clock.now() - daemon.restartedAt).toBe(2 * CHECK_INTERVAL_MS + LATE_MS);
    expect(daemon.forgiveDaemonStall).toHaveBeenCalledTimes(1);
    expect(daemon.forgiveDaemonStall).toHaveBeenCalledWith(clock.now(), LATE_MS);
    // CURRENT (bug): the owner has been absent 22.5 s, only 2.5 s of it the daemon's own stall,
    // yet the clock restarts at the resume point and the tick that should reap holds instead.
    expect(daemon.manager.getSession(SESSION)?.awaitingOwnerSince).toBe(clock.now());
    expect(daemon.manager.getSession(SESSION)?.expiresAt).toBe(clock.now() + SESSION_TIMEOUT_MS);
    heldBy(daemon);
    // AFTER FIX (shift by lostMs, as the doc comment promises): awaitingOwnerSince is
    // restartedAt + LATE_MS, so the owner-awaiting age is 20 s > 10 s and this same tick reaps:
    //   expect(daemon.reaps).toEqual([{ reason: "rehydration-owner-timeout", at: clock.now() }]);
    //   expect(daemon.pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  });

  test("ticks that each fire 2.5s late hold the device for an hour, past the 30-minute idle backstop", async () => {
    const { clock, daemon } = await restartWithOwnerGone();

    let periods = 0;
    while (clock.now() - daemon.restartedAt < ONE_HOUR_MS) {
      await monitorPeriod(clock, daemon, LATE_MS);
      periods++;
    }

    // Every tick came from the real 10 s interval, every one of them was judged a daemon stall.
    expect(periods).toBe(Math.ceil(ONE_HOUR_MS / (CHECK_INTERVAL_MS + LATE_MS)));
    expect(clock.intervalFires.get(CHECK_INTERVAL_MS)).toBe(periods);
    expect(daemon.forgiveDaemonStall).toHaveBeenCalledTimes(periods);
    // CURRENT (bug): an hour with no owner, no heartbeat and no tool call, and nothing reaps it.
    heldBy(daemon);
    expect(daemon.manager.getSession(SESSION)?.awaitingOwnerSince).toBe(clock.now());
    // The 30-minute idle expiry that would otherwise release it is pushed out on every tick too.
    expect(clock.now() - daemon.restartedAt).toBeGreaterThan(SESSION_TIMEOUT_MS);
    expect(daemon.manager.getSession(SESSION)?.expiresAt).toBe(clock.now() + SESSION_TIMEOUT_MS);
    // AFTER FIX: each 12.5 s period forgives only its 2.5 s, so the owner-awaiting age still grows
    // 10 s per period and the session is reaped within the first few periods:
    //   expect(daemon.reaps).toEqual([{ reason: "rehydration-owner-timeout", at: expect.any(Number) }]);
    //   expect(daemon.reaps[0].at - daemon.restartedAt).toBeLessThanOrEqual(3 * (CHECK_INTERVAL_MS + LATE_MS));
    //   expect(daemon.pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  });

  test("alternating late and on-time ticks also hold the device for an hour", async () => {
    const { clock, daemon } = await restartWithOwnerGone();

    let periods = 0;
    while (clock.now() - daemon.restartedAt < ONE_HOUR_MS) {
      await monitorPeriod(clock, daemon, periods % 2 === 0 ? LATE_MS : 0);
      periods++;
    }

    expect(clock.intervalFires.get(CHECK_INTERVAL_MS)).toBe(periods);
    expect(daemon.forgiveDaemonStall).toHaveBeenCalledTimes(Math.ceil(periods / 2));
    // CURRENT (bug): half the ticks are on time, but one on-time tick after a reset sees an age of
    // exactly 10 s (not > 10 s), so the age never exceeds the owner timeout.
    heldBy(daemon);
    expect(daemon.manager.getSession(SESSION)?.expiresAt).toBeGreaterThan(clock.now());
    // AFTER FIX: reaped by the second period (age 22.5 s - 2.5 s forgiven = 20 s > 10 s):
    //   expect(daemon.reaps).toEqual([
    //     { reason: "rehydration-owner-timeout", at: daemon.restartedAt + 2 * CHECK_INTERVAL_MS + LATE_MS },
    //   ]);
  });
});
