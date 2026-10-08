import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import type { LivenessHandover } from "../../src/daemon/proxyLivenessRecovery";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { logger } from "../../src/utils/logger";
import type { Timer } from "../../src/utils/SystemTimer";

// H19: host sleep (laptop lid closed) longer than the session's idle timeout releases a session
// whose owner is alive, depending only on which timer happens to fire first after wake.
//
// Model of a host sleep: Node/Bun timers run on a monotonic clock that does not advance while the
// host is suspended, while `SystemTimer.now()` is `Date.now()` (src/utils/SystemTimer.ts:86-87),
// which does. So after wake every interval resumes its old schedule, but every `now()` reading has
// jumped forward by the sleep. `SleepableTimer` below reproduces exactly that: a skew on `now()`
// with the underlying FakeTimer schedule untouched (same model as `StallableTimer` in
// test/daemon/proxyLivenessStalls.test.ts).
//
// Production code driven for real:
//   - DaemonMcpProxy keeper (2 s production interval, src/daemon/daemonMcpProxy.ts:141) acquiring
//     the device and claiming / renewing liveness with its owner token,
//   - handleDaemonRequest → handleHeartbeat (src/daemon/daemonRequestHandlers.ts:329-451),
//   - SessionManager with PRODUCTION default timeouts (sessionTimeoutMs 30 min,
//     sessionManager.ts:1149; heartbeat lease 10 s), including getSessionInternal lazy expiry
//     (sessionManager.ts:1641-1688) and forgiveDaemonStall (sessionManager.ts:5653-5668),
//   - SessionHeartbeatMonitor with production defaults (10 s scan, forgiveOwnStall before
//     cleanupExpiredSessions, SessionHeartbeatMonitor.ts:172-197).
// Faked: the socket (FakeDaemonClient forwards daemon/heartbeat straight into the real handler),
// persistence (FakeDeviceSessionPersistence), the monitor's reap callback (calls
// SessionManager.releaseSession directly instead of Daemon.cancelAndReleaseSession, daemon.ts:2441),
// the device pool (stats stub), and the device-acquisition tool result (the session is created
// directly on the SessionManager; the proxy learns its UUID from the getAndroid result).

/** FakeTimer whose async advance drains the promise-only transport/persistence after each event. */
class DrainingTimer extends FakeTimer {
  override advanceTimeAsync(ms: number): Promise<void> {
    return super.advanceTimeAsync(ms, () => drainUntilQuiescent(this));
  }
}

/** Wall clock that can jump forward while no timer fires: a suspended host. */
class SleepableTimer implements Timer {
  private skewMs = 0;
  constructor(private readonly base: FakeTimer) {}
  sleepHost(ms: number): void {
    this.skewMs += ms;
  }
  now(): number {
    return this.base.now() + this.skewMs;
  }
  sleep(ms: number): Promise<void> {
    return this.base.sleep(ms);
  }
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    return this.base.setTimeout(callback, ms);
  }
  clearTimeout(handle: NodeJS.Timeout): void {
    this.base.clearTimeout(handle);
  }
  setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    return this.base.setInterval(callback, ms);
  }
  clearInterval(handle: NodeJS.Timeout): void {
    this.base.clearInterval(handle);
  }
}

const SESSION = "android-session";
const DEVICE = "emulator-5554";
const KEEPER_INTERVAL_MS = 2_000; // DAEMON_MCP_HEARTBEAT_INTERVAL_MS
const LEASE_MS = 10_000; // SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS
const PRODUCTION_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // SessionManager.SESSION_TIMEOUT_MS
const MINUTE = 60_000;

interface Release {
  sessionId: string;
  reason: string;
  expiryOrigin: string | undefined;
}

describe("H19: host sleep longer than sessionTimeoutMs vs a live proxy owner", () => {
  let baseTimer: DrainingTimer;
  let timer: SleepableTimer;
  let sessionManager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let proxy: DaemonMcpProxy;
  let releases: Release[];
  let handovers: LivenessHandover[];
  /** Heartbeats the daemon never sees (owner process gone / socket dead). */
  let dropHeartbeats: boolean;
  /** Heartbeat responses the real handler produced, in order. */
  let heartbeatOutcomes: Array<{ atBase: number; success: boolean; error?: string }>;
  const spies: Array<ReturnType<typeof spyOn>> = [];

  function daemonState(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
  }

  function daemonBackedClient(): FakeDaemonClient {
    return new FakeDaemonClient({
      toolResultFor: (name) =>
        name === "getAndroid"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    runtime: { deviceId: DEVICE, session: { sessionUuid: SESSION } },
                  }),
                },
              ],
            }
          : undefined,
      onCallDaemonMethod: async (method, params) => {
        if (method !== "daemon/heartbeat") {
          return;
        }
        if (dropHeartbeats) {
          return new Promise<void>(() => {});
        }
        const response = await handleDaemonRequest(
          { id: "hb", type: "daemon_request", method, params },
          daemonState(),
        );
        heartbeatOutcomes.push({
          atBase: baseTimer.now(),
          success: response.success,
          error: response.success ? undefined : response.error,
        });
        if (!response.success) {
          throw Object.assign(new Error(response.error), { code: response.code });
        }
      },
    });
  }

  /** Step the base (monotonic) clock to an absolute base time. */
  async function advanceBaseTo(target: number): Promise<void> {
    await baseTimer.advanceTimeAsync(target - baseTimer.now());
  }

  beforeEach(async () => {
    baseTimer = new DrainingTimer();
    timer = new SleepableTimer(baseTimer);
    releases = [];
    handovers = [];
    dropHeartbeats = false;
    heartbeatOutcomes = [];
    spies.push(
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    );

    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.onSessionRelease((sessionId, _deviceId, reason, _snapshot, options) => {
      releases.push({ sessionId, reason, expiryOrigin: options.expiryOrigin });
    });
    // Production defaults: no timeout overrides (devicePool.ts:6867-6874 passes undefined).
    await sessionManager.createSession(SESSION, DEVICE, "android");

    // Monitor started at base t=0: scans at 10 000, 20 000, ...
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        await sessionManager.releaseSession(sessionId, reason);
      },
      timer,
    );
    monitor.start();

    // Proxy acquires at base t=500, so its keeper ticks at 2 500, 4 500, ... — offset from the
    // monitor's scans so each test can choose which fires first after wake.
    await advanceBaseTo(500);
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    proxy = new DaemonMcpProxy({
      clientFactory: () => daemonBackedClient(),
      daemonManager,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(["proxy-token"]),
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatIntervalMs: KEEPER_INTERVAL_MS,
    });
    proxy.onLivenessHandover((handover) => handovers.push(handover));
    await proxy.callTool("getAndroid", {});
  });

  afterEach(async () => {
    await proxy.close();
    await monitor.stop();
    sessionManager.stopCleanupTimer();
    for (const spy of spies.splice(0)) {
      spy.mockRestore();
    }
  });

  /** Steady state: the proxy owns the session and its heartbeats are landing. */
  function expectHealthyOwnedSession(): void {
    const session = sessionManager.getSession(SESSION);
    expect(session?.livenessOwnerToken).toBe("proxy-token");
    expect(session?.hasReceivedHeartbeat).toBe(true);
    expect(session?.sessionTimeoutMs).toBe(PRODUCTION_SESSION_TIMEOUT_MS);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("live");
  }

  test("BUG: sleep > sessionTimeoutMs, keeper fires before the monitor → owner's own heartbeat lazily expires the session", async () => {
    // Base t=11 000: monitor scanned at 10 000 (next 20 000); keeper ticked at 10 500 (next 12 500).
    await advanceBaseTo(11_000);
    expectHealthyOwnedSession();
    heartbeatOutcomes = [];

    timer.sleepHost(40 * MINUTE); // lid closed for 40 min; no timer fires meanwhile

    // Wake: the keeper's next tick (12 500) comes before the monitor's (20 000).
    await advanceBaseTo(12_600);

    // CURRENT behavior: handleHeartbeat's manager.getSession() (daemonRequestHandlers.ts:351)
    // runs getSessionInternal's lazy expiry (sessionManager.ts:1667-1686) BEFORE any stall
    // forgiveness, so the live owner's first post-wake heartbeat releases its own session.
    expect(heartbeatOutcomes[0]).toMatchObject({
      atBase: 12_500,
      success: false,
      error: `Session not found: ${SESSION}`,
    });
    expect(releases).toEqual([
      // expiredSessionReleaseReason maps the lapsed lease to "heartbeat-timeout".
      { sessionId: SESSION, reason: "heartbeat-timeout", expiryOrigin: "lazy-expiry" },
    ]);
    expect(sessionManager.getSession(SESSION)).toBeNull();
    // The monitor never got to forgive: it has not scanned yet.
    expect(baseTimer.now()).toBeLessThan(20_000);
    // The live proxy is told to re-acquire.
    expect(handovers.map((h) => [h.code, h.action])).toEqual([
      ["proxy_stalled", "reacquire_lost_sessions"],
    ]);

    // AFTER A FIX (e.g. stall forgiveness applied on the lookup path / the sleep detected from the
    // owner's heartbeat before expiry is judged), the same steps should give:
    //   expect(heartbeatOutcomes[0]?.success).toBe(true);
    //   expect(releases).toEqual([]);
    //   expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("proxy-token");
    //   expect(handovers).toEqual([]);
  });

  test("CONTROL: identical sleep, but the monitor fires first → forgiveOwnStall keeps the session", async () => {
    // Base t=9 000: keeper ticked at 8 500 (next 10 500); monitor next scans at 10 000.
    await advanceBaseTo(9_000);
    expectHealthyOwnedSession();
    heartbeatOutcomes = [];

    timer.sleepHost(40 * MINUTE);

    await advanceBaseTo(10_000); // monitor: forgiveDaemonStall, then cleanup + reap scan
    const afterForgive = sessionManager.getSession(SESSION);
    expect(afterForgive).not.toBeNull();
    // forgiveDaemonStall (sessionManager.ts:5661) resets the idle deadline to a FULL window from
    // resume, not by the lost interval.
    expect(afterForgive?.expiresAt).toBe(timer.now() + PRODUCTION_SESSION_TIMEOUT_MS);

    await advanceBaseTo(10_600); // keeper's post-wake heartbeat
    expect(heartbeatOutcomes[0]).toMatchObject({ atBase: 10_500, success: true });
    expect(releases).toEqual([]);
    expect(handovers).toEqual([]);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("live");
  });

  test("boundary: a sleep shorter than sessionTimeoutMs + suspect grace survives even when the keeper fires first", async () => {
    await advanceBaseTo(11_000);
    expectHealthyOwnedSession();
    heartbeatOutcomes = [];

    // The idle deadline was last pushed at base 10 500; stay just inside expiresAt + grace.
    timer.sleepHost(PRODUCTION_SESSION_TIMEOUT_MS + SUSPECT_GRACE_MS - 2_500);

    await advanceBaseTo(12_600);
    expect(heartbeatOutcomes[0]).toMatchObject({ atBase: 12_500, success: true });
    expect(releases).toEqual([]);
    expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("proxy-token");
  });

  test("forgiveDaemonStall's full-window expiresAt is not a hold: an owner that is gone after wake is still reaped by the lease", async () => {
    await advanceBaseTo(9_000);
    expectHealthyOwnedSession();

    dropHeartbeats = true; // the owner never heartbeats again
    timer.sleepHost(40 * MINUTE);
    await advanceBaseTo(10_000); // monitor forgives first
    const resumedAt = timer.now();
    expect(sessionManager.getSession(SESSION)?.expiresAt).toBe(
      resumedAt + PRODUCTION_SESSION_TIMEOUT_MS,
    );

    // Lease (10 s) + suspect grace (10 s) from the forgiven lease start, then the next scan.
    await advanceBaseTo(40_000);
    expect(releases).toEqual([
      { sessionId: SESSION, reason: "heartbeat-timeout", expiryOrigin: undefined },
    ]);
    // Released ~20-30 s after wake, far from the 30 min idle window forgiveDaemonStall set.
    expect(timer.now() - resumedAt).toBeLessThanOrEqual(LEASE_MS + SUSPECT_GRACE_MS + 10_000);
  });
});
