import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import {
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_BOUND_SESSION_REPLAY_TTL_MS,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  SessionManager,
  getDefaultSessionHeartbeatTimeoutMs,
} from "../../src/daemon/sessionManager";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// Hypothesis H1: the liveness heartbeat renews the idle expiry.
//
// Since v0.0.82 the stdio MCP proxy is the authoritative liveness owner of the
// sessions it acquires. Its keeper heartbeats every 5 s (the stdio entry point
// passes a 10 s lease, and the keeper runs at half of it) with no tool-recency
// condition (daemonMcpProxy.ts startBoundSessionHeartbeat). Each owner tick reaches
// SessionManager.recordHeartbeat, which writes `lastUsedAt = now` and
// `expiresAt = now + sessionTimeoutMs` (30 min), so the ping counts as device
// activity. An agent that calls getAndroid and then goes quiet, with its MCP host
// still open, holds the device for as long as the proxy process lives. The
// daemon's 30 min idle expiry never fires. Nor does the proxy's own 30 min replay
// TTL, because every heartbeat ack also refreshes `boundSessionUuidAt`.
//
// Driven for real:
// - DaemonMcpProxy, configured as src/index.ts configures the stdio proxy: the
//   keeper at its 5 s cadence against the 10 s lease, the owner-token claim, and
//   the replay-TTL gate.
// - handleDaemonRequest: daemon/heartbeat, daemon/sessionInfo and
//   daemon/availableDevices.
// - SessionManager: recordHeartbeat, isSessionExpired, and its own 5 min cleanup
//   sweep on the injected timer.
// - SessionHeartbeatMonitor: the 10 s reaper scan, wired as in daemon.ts.
// - DevicePool: bindOrReuseDeviceSession and the release-on-expiry hook.
// - releaseSessionAndDevice: the daemon's reap path.
//
// Faked:
// - The socket transport. FakeDaemonClient hands each daemon/heartbeat straight to
//   handleDaemonRequest.
// - The getAndroid tool body. It binds the pool session the way
//   deviceToolsStartDevice does, then returns the minted UUID.
// - Device discovery (FakeDeviceUtils), persistence (FakeDeviceSessionPersistence,
//   FakeDbWriteBarrier) and the clock (FakeTimer).

const SESSION = "idle-agent-session";
const OWNER_TOKEN = "claude-code-proxy-owner";
const DEVICE = { deviceId: "emulator-5554", name: "Pixel_8_API_35", platform: "android" as const };
/** The lease src/index.ts passes to the stdio proxy, which is also the daemon session's lease. */
const LEASE_MS = getDefaultSessionHeartbeatTimeoutMs();
/** daemonMcpProxy.ts heartbeatIntervalMs(): half the configured lease, so 5 s in production. */
const KEEPER_INTERVAL_MS = Math.floor(LEASE_MS / 2);
/** SessionManager.SESSION_TIMEOUT_MS. It is private, and it is the only idle bound for a heartbeat session. */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
/** SessionManager.CLEANUP_INTERVAL_MS. */
const CLEANUP_SWEEP_MS = 5 * 60_000;
/**
 * 35 min. This crosses the idle deadline and its suspect grace, 210 reaper scans
 * (each of which also runs cleanupExpiredSessions), and the first 5 min sweep
 * after the deadline. The test steps every keeper tick at production cadence, so
 * its cost grows with this period. "Hours" follows from the steady-state
 * assertion below rather than from a longer loop.
 */
const IDLE_PERIOD_MS = SESSION_IDLE_TIMEOUT_MS + CLEANUP_SWEEP_MS;
/**
 * Microtask turns given to each fake-timer event so that a keeper round trip
 * settles before the next tick. With a 10-turn drain, single-flight dropped
 * about half the ticks (14 was the measured minimum). The exact heartbeat-count
 * assertion catches a drain that is too short.
 */
const TURNS_PER_EVENT = 32;

interface HeartbeatReply {
  claim: boolean;
  token: unknown;
  success: boolean;
}

interface ForwardedCall {
  tool: string;
  sessionUuid: unknown;
  boundSession: unknown;
}

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

function deviceStartResult(sessionUuid: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) }],
  };
}

describe("H1: an idle proxy's liveness heartbeats renew the 30 min idle expiry", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let manager: SessionManager;
  let pool: DevicePool;
  let state: DaemonStateAccess;
  let monitor: SessionHeartbeatMonitor;
  let proxy: DaemonMcpProxy;
  let heartbeats: HeartbeatReply[];
  let forwarded: ForwardedCall[];
  let reaped: Array<{ sessionId: string; reason: string }>;
  const spies: Array<ReturnType<typeof spyOn>> = [];

  /** Advance fake time, letting each due event's async work (a keeper round trip) settle. */
  async function idleFor(ms: number): Promise<void> {
    await timer.advanceTimeAsync(ms, () => drainMicrotasks(TURNS_PER_EVENT));
  }

  async function daemonMethod(method: string, params: Record<string, unknown> = {}) {
    return await handleDaemonRequest({ id: method, type: "daemon_request", method, params }, state);
  }

  beforeEach(async () => {
    spies.push(
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
    );
    timer = new FakeTimer();
    heartbeats = [];
    forwarded = [];
    reaped = [];

    // Daemon side. SessionManager arms its real 5 min cleanup sweep on `timer`.
    persistence = new FakeDeviceSessionPersistence();
    manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [DEVICE]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "test-daemon", { timer, deviceManager: discovery }),
    );
    await pool.initializeWithDevices([DEVICE]);
    const registry = new DeviceSessionRegistry(timer);
    state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => registry,
    };
    // Wired as in daemon.ts startHeartbeatMonitor: a reap releases the session and its device.
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason });
        const deviceId = manager.getSession(sessionId)?.assignedDevice ?? null;
        await releaseSessionAndDevice(manager, pool, deviceId, sessionId, reason);
      },
      timer,
    );
    monitor.start();

    // Transport: every daemon/heartbeat the proxy sends lands in the real handler.
    const client = new FakeDaemonClient({
      onCallTool: async (tool, params) => {
        forwarded.push({
          tool,
          sessionUuid: params.sessionUuid,
          boundSession: params[DAEMON_BOUND_SESSION_PARAM],
        });
        if (tool === "getAndroid") {
          await pool.bindOrReuseDeviceSession(SESSION, DEVICE.deviceId, "android");
        }
      },
      toolResultFor: (tool) => (tool === "getAndroid" ? deviceStartResult(SESSION) : undefined),
      onCallDaemonMethod: async (method, params) => {
        if (method !== "daemon/heartbeat") {
          return;
        }
        const response = await daemonMethod(method, params);
        heartbeats.push({
          claim: params.claimLivenessOwnership === true,
          token: params.livenessOwnerToken,
          success: response.success,
        });
        if (!response.success) {
          throw Object.assign(new Error(response.error), { code: response.code });
        }
      },
    });

    // Configured as src/index.ts configures the stdio proxy: a 10 s lease and no
    // explicit interval, so the keeper runs every 5 s.
    proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      livenessOwnerToken: OWNER_TOKEN,
      heartbeatTimeoutMs: getDefaultSessionHeartbeatTimeoutMs(),
    });

    // The agent's only device interaction: it acquires a device, then goes quiet.
    await proxy.callTool("getAndroid", {});
    await drainMicrotasks(TURNS_PER_EVENT);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId: SESSION });
    expect(manager.getSession(SESSION)?.livenessOwnerToken).toBe(OWNER_TOKEN);
  });

  afterEach(async () => {
    await proxy.close();
    await monitor.stop();
    manager.stopCleanupTimer();
    for (const spy of spies.splice(0)) {
      spy.mockRestore();
    }
  });

  test("a session with no tool call past the 30 min idle window is never released while the proxy keeper runs", async () => {
    expect(LEASE_MS).toBe(SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS);
    expect(KEEPER_INTERVAL_MS).toBe(5_000);
    const acquiredAt = timer.now();
    expect(manager.getSession(SESSION)!.expiresAt).toBe(acquiredAt + SESSION_IDLE_TIMEOUT_MS);

    await idleFor(IDLE_PERIOD_MS);
    const now = timer.now();
    expect(now - acquiredAt).toBe(SESSION_IDLE_TIMEOUT_MS + CLEANUP_SWEEP_MS);
    expect(now - acquiredAt).toBeGreaterThan(SESSION_IDLE_TIMEOUT_MS + SUSPECT_GRACE_MS);

    // Only the proxy keeper talked to the daemon: one claim, then one owner tick
    // every 5 s, and the daemon accepted every one. No tool call was forwarded
    // after getAndroid.
    expect(forwarded.map((call) => call.tool)).toEqual(["getAndroid"]);
    expect(heartbeats.filter((reply) => reply.claim)).toHaveLength(1);
    expect(heartbeats.every((reply) => reply.success && reply.token === OWNER_TOKEN)).toBe(true);
    expect(heartbeats.length).toBe(IDLE_PERIOD_MS / KEEPER_INTERVAL_MS + 1);

    // CURRENT (gap): neither the 10 s reaper scans nor the 5 min cleanup sweeps
    // released it, and a second agent or the desktop finds no device.
    expect(reaped).toEqual([]);
    const session = manager.getSession(SESSION);
    expect(session).not.toBeNull();
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId: SESSION });
    const available = await daemonMethod("daemon/availableDevices");
    expect(available.result).toMatchObject({ availableDevices: 0, assignedDevices: 1 });

    // CURRENT (gap): the ping is booked as device activity. The state after 35
    // idle minutes is the state at acquisition shifted in time: lastUsedAt is
    // now and the idle deadline is a full 30 min ahead. The cycle repeats every
    // keeper tick, so the hold has no bound while the proxy lives. That is minutes
    // to hours, as reported.
    expect(session!.lastUsedAt).toBe(now);
    expect(session!.expiresAt).toBe(now + SESSION_IDLE_TIMEOUT_MS);

    // Outcome C: session-info and the persisted row report a session idle for
    // 35 min as used just now.
    const info = await daemonMethod("daemon/sessionInfo", { sessionId: SESSION });
    expect(info.result).toMatchObject({
      lastUsedAt: now,
      expiresAt: now + SESSION_IDLE_TIMEOUT_MS,
    });
    expect(await persistence.getSession?.(SESSION)).toMatchObject({
      status: "active",
      last_used_at_ms: now,
    });

    // AFTER A FIX: idle time should be measured from the last tool call, not the
    // last ping. Either recordHeartbeat stops writing lastUsedAt and expiresAt, or
    // the proxy stops heartbeating a binding whose replay TTL has expired. Then,
    // with no forwarded tool call, the session should be released at about
    // acquiredAt + 30 min + SUSPECT_GRACE_MS + one 10 s scan, while the proxy
    // stays open:
    //   expect(reaped or the release reason).toEqual one entry for SESSION:
    //     "idle-timeout" (a new daemon reason) or "heartbeat-timeout" (proxy-side fix);
    //   expect(manager.getSession(SESSION)).toBeNull();
    //   expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
    //   expect(available.result).toMatchObject({ availableDevices: 1 });
    // Before that release, session-info should report lastUsedAt === acquiredAt.
  });

  test("past the 30 min replay TTL the proxy still replays the idle binding, because heartbeat acks refresh it", async () => {
    await idleFor(IDLE_PERIOD_MS);
    expect(IDLE_PERIOD_MS).toBeGreaterThan(DAEMON_BOUND_SESSION_REPLAY_TTL_MS);

    // A sessionless call from the long-idle agent.
    await proxy.callTool("observe", {});

    // CURRENT (gap): constants.ts documents the TTL as refreshed only by forwarded
    // calls. The call is still rewritten onto the 35 min old binding, because
    // recordBoundSessionHeartbeatSuccess sets boundSessionUuidAt on every ack.
    expect(forwarded.at(-1)).toEqual({
      tool: "observe",
      sessionUuid: SESSION,
      boundSession: SESSION,
    });

    // AFTER A FIX: once 30 min pass with no forwarded call, the binding should be
    // fenced with "replay-lease-expired". The call should reject, or go out
    // sessionless, instead of being replayed onto the idle session:
    //   await expect(proxy.callTool("observe", {})).rejects.toThrow(/expired|released/i);
    //   expect(forwarded.map((call) => call.tool)).toEqual(["getAndroid"]);
  });

  test("control: once the proxy keeper stops, the same harness frees the device within lease, grace and one scan", async () => {
    await idleFor(60_000);
    expect(reaped).toEqual([]);

    // stdin EOF: the proxy closes and stops its keeper. Nothing else changes.
    await proxy.close();
    // Lease, then suspect grace, then one 10 s reaper scan.
    await idleFor(LEASE_MS + SUSPECT_GRACE_MS + 10_000 + KEEPER_INTERVAL_MS);

    // The keeper's heartbeats were the only thing holding the device.
    expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
    expect(manager.getSession(SESSION)).toBeNull();
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  });
});
