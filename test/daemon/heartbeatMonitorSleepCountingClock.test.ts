import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../src/daemon/sessionLivenessWindows";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #10699 follow-up: on Windows (QueryPerformanceCounter) and Linux under Bun 1.3 (CLOCK_BOOTTIME)
// the monotonic clock keeps running while the host sleeps, so a laptop sleep looks exactly like a
// daemon stall. Without a fallback it would be forgiven in full and the device held for as long as
// the host slept. The monitor instead treats lateness past the longest credible stall as sleep.

const SESSION = "sleep-counting-session";
const DEVICE = "emulator-5554";
const OWNER = "owner";
const SESSION_IDLE_MS = 60_000;
const MAX_CREDIBLE_STALL_MS = 120_000;
const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;

const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
};

describe("heartbeat monitor on a monotonic clock that runs through host sleep", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let reaped: string[];
  let monitor: SessionHeartbeatMonitor;

  function heartbeat() {
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
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

  async function setUp(sleepCountingClock: boolean): Promise<void> {
    timer = new FakeTimer();
    if (sleepCountingClock) {
      timer.simulateSleepCountingMonotonicClock();
    }
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    reaped = [];
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        reaped.push(reason);
        await sessionManager.releaseSession(sessionId, reason);
      },
      timer,
      { maxCredibleStallMs: MAX_CREDIBLE_STALL_MS },
    );
    await sessionManager.createSession(SESSION, DEVICE, "android", SESSION_IDLE_MS);
    expect((await heartbeat()).success).toBe(true);
    monitor.start();
  }

  beforeEach(async () => {
    await setUp(true);
  });

  afterEach(async () => {
    await monitor.stop();
    sessionManager.stopCleanupTimer();
  });

  test("the fake clock models it: sleep advances both clocks alike", () => {
    const before = timer.monotonicNow();
    timer.simulateHostSleep(30_000);
    expect(timer.monotonicIncludesHostSleep).toBe(true);
    expect(timer.monotonicNow() - before).toBe(30_000);
  });

  test("a sleep longer than the longest credible stall counts toward idle and releases on wake", async () => {
    timer.simulateHostSleep(MAX_CREDIBLE_STALL_MS + 60_000);

    await monitor.tick();

    expect(sessionManager.getSession(SESSION)).toBeNull();
  });

  test("an owner heartbeat that wins the race after that sleep gets the same verdict", async () => {
    timer.simulateHostSleep(MAX_CREDIBLE_STALL_MS + 60_000);

    expect((await heartbeat()).success).toBe(false);
    await monitor.tick();
    expect(sessionManager.getSession(SESSION)).toBeNull();
  });

  test("the lease is still excused for the sleep: no owner on a sleeping host could heartbeat", async () => {
    const session = sessionManager.getSession(SESSION)!;
    const sleepMs = MAX_CREDIBLE_STALL_MS + 60_000;
    timer.simulateHostSleep(sleepMs);

    sessionManager.getSession(SESSION);

    // The lease moved with the whole gap; only the idle deadline was not moved.
    expect(session.stallForgivenAt).toBe(timer.now() - SCAN_MS);
  });

  test("a gap within the longest credible stall is still forgiven as a stall (documented limit)", async () => {
    const session = sessionManager.getSession(SESSION)!;
    const expiresAt = session.expiresAt;
    timer.simulateHostSleep(63_000);

    expect((await heartbeat()).success).toBe(true);
    await monitor.tick();

    expect(reaped).toEqual([]);
    expect(sessionManager.getSession(SESSION)).toBe(session);
    expect(session.expiresAt).toBe(expiresAt + 63_000 - SCAN_MS);
  });

  test("a clock that pauses during sleep keeps forgiving a long awake stall in full", async () => {
    await monitor.stop();
    sessionManager.stopCleanupTimer();
    await setUp(false);
    const session = sessionManager.getSession(SESSION)!;
    const expiresAt = session.expiresAt;
    // Both clocks ran: the daemon's event loop was blocked, the host was awake.
    timer.setCurrentTime(timer.now() + MAX_CREDIBLE_STALL_MS + 60_000);

    expect((await heartbeat()).success).toBe(true);
    await monitor.tick();

    expect(reaped).toEqual([]);
    expect(session.expiresAt).toBe(expiresAt + MAX_CREDIBLE_STALL_MS + 60_000 - SCAN_MS);
  });
});
