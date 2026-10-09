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
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  SessionManager,
  getDefaultSessionHeartbeatTimeoutMs,
} from "../../src/daemon/sessionManager";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { withRoutedSessionMeta } from "../../src/server/routedSessionMeta";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// #10656 (H1 of #10655): a liveness heartbeat must not count as device use.
//
// The stdio MCP proxy is the authoritative liveness owner of the sessions it
// acquires. Its keeper heartbeats every 2 s (half the 4 s lease) whether or not
// the agent calls a tool. Those ticks renew the owner lease and its grace window,
// but they must not renew the 2 min idle deadline (`lastUsedAt` / `expiresAt`) or
// the proxy's own
// replay lease (`boundSessionUuidAt`). Only tool calls do. Before the fix an agent
// that called getAndroid and then went quiet, with its MCP host still open, held
// the device for as long as the proxy process lived.
//
// Driven for real:
// - DaemonMcpProxy, configured with the default lease: the keeper at its 2 s
//   cadence against the 4 s lease, the owner-token claim, and the replay-TTL gate.
// - handleDaemonRequest: daemon/heartbeat, daemon/sessionInfo and
//   daemon/availableDevices.
// - SessionManager: recordHeartbeat, getOrCreateSession (the tool-call refresh),
//   isSessionExpired, and its own 5 min cleanup sweep on the injected timer.
// - SessionHeartbeatMonitor: the 2 s reaper scan, wired as in daemon.ts.
// - DevicePool: bindOrReuseDeviceSession and the release-on-expiry hook.
// - releaseSessionAndDevice: the daemon's reap path.
//
// Faked:
// - The socket transport. FakeDaemonClient hands each daemon/heartbeat straight to
//   handleDaemonRequest, and resolves each forwarded device tool call's session
//   through SessionManager.getOrCreateSession the way ToolExecutionContext does.
// - The getAndroid tool body. It binds the pool session the way
//   deviceToolsStartDevice does, then returns the minted UUID.
// - Device discovery (FakeDeviceUtils), persistence (FakeDeviceSessionPersistence,
//   FakeDbWriteBarrier) and the clock (FakeTimer).

const SESSION = "idle-agent-session";
const OWNER_TOKEN = "claude-code-proxy-owner";
const DEVICE = { deviceId: "emulator-5554", name: "Pixel_8_API_35", platform: "android" as const };
/** The lease src/index.ts passes to the stdio proxy, which is also the daemon session's lease. */
const LEASE_MS = getDefaultSessionHeartbeatTimeoutMs();
/** daemonMcpProxy.ts heartbeatIntervalMs(): half the configured lease. */
const KEEPER_INTERVAL_MS = Math.floor(LEASE_MS / 2);
/** The session idle window, the only idle bound for a heartbeat session. */
const SESSION_IDLE_TIMEOUT_MS = DEFAULT_SESSION_IDLE_TIMEOUT_MS;
/** SessionHeartbeatMonitor's default scan interval; each scan also sweeps expired sessions. */
const REAPER_SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
/** The latest the idle release may land after the deadline: suspect grace, one scan, one keeper tick. */
const RELEASE_SLACK_MS = SUSPECT_GRACE_MS + REAPER_SCAN_MS + KEEPER_INTERVAL_MS;
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

describe("#10656: an idle proxy's liveness heartbeats do not extend the idle deadline", () => {
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
          return;
        }
        // A device tool call resolves its session as ToolExecutionContext does. This is the
        // tool activity that, unlike a heartbeat, moves the idle deadline.
        if (typeof params.sessionUuid === "string") {
          await manager.getOrCreateSession(params.sessionUuid);
        } else if (params.platform === DEVICE.platform || params.deviceId === DEVICE.deviceId) {
          // A selector-routed call (#10692) resolves to the session holding the selected device.
          const sessionId = pool.getDevice(DEVICE.deviceId)?.sessionId;
          if (sessionId) {
            await manager.getOrCreateSession(sessionId);
          }
        }
      },
      toolResultFor: (tool, params) => {
        if (tool === "getAndroid") {
          return deviceStartResult(SESSION);
        }
        // The daemon echoes the session it routed an admitted control call to (#10974); a read
        // (observe) is watching and carries no echo.
        const routed =
          tool === "observe"
            ? undefined
            : typeof params.sessionUuid === "string"
              ? params.sessionUuid
              : (pool.getDevice(DEVICE.deviceId)?.sessionId ?? undefined);
        return withRoutedSessionMeta({ content: [{ type: "text", text: "ok" }] }, routed);
      },
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

    // The default lease and no explicit interval, so the keeper runs at half the lease.
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

  /** The monotonic release point for SESSION, or undefined while it is still held. */
  function isReleased(): boolean {
    return manager.getSession(SESSION) === null;
  }

  /** Advance in keeper-sized steps until SESSION is released or `limitMs` passes; returns the release time. */
  async function idleUntilReleased(limitMs: number): Promise<number | undefined> {
    const deadline = timer.now() + limitMs;
    while (timer.now() < deadline) {
      await idleFor(KEEPER_INTERVAL_MS);
      if (isReleased()) {
        return timer.now();
      }
    }
    return undefined;
  }

  test("an idle owner's heartbeats do not extend the idle deadline: the device is freed after the idle window while the proxy stays open", async () => {
    expect(LEASE_MS).toBe(SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS);
    expect(KEEPER_INTERVAL_MS).toBe(PROXY_HEARTBEAT_INTERVAL_MS);
    const acquiredAt = timer.now();
    expect(manager.getSession(SESSION)!.expiresAt).toBe(acquiredAt + SESSION_IDLE_TIMEOUT_MS);

    // Just before the deadline: a tick every keeper interval, none of them counted as use.
    await idleFor(SESSION_IDLE_TIMEOUT_MS - KEEPER_INTERVAL_MS);
    expect(heartbeats.length).toBeGreaterThan(SESSION_IDLE_TIMEOUT_MS / KEEPER_INTERVAL_MS - 5);
    expect(heartbeats.every((reply) => reply.success && reply.token === OWNER_TOKEN)).toBe(true);
    const held = manager.getSession(SESSION);
    expect(held).not.toBeNull();
    expect(held!.lastUsedAt).toBe(acquiredAt);
    expect(held!.expiresAt).toBe(acquiredAt + SESSION_IDLE_TIMEOUT_MS);
    // The heartbeats still prove liveness: the owner lease is current.
    expect(held!.lastOwnerHeartbeat).toBeGreaterThan(timer.now() - LEASE_MS);
    const info = await daemonMethod("daemon/sessionInfo", { sessionId: SESSION });
    expect(info.result).toMatchObject({
      lastUsedAt: acquiredAt,
      expiresAt: acquiredAt + SESSION_IDLE_TIMEOUT_MS,
      liveness: { state: "live" },
    });
    expect(await persistence.getSession?.(SESSION)).toMatchObject({
      status: "active",
      last_used_at_ms: acquiredAt,
      expires_at_ms: acquiredAt + SESSION_IDLE_TIMEOUT_MS,
    });

    const releasedAt = await idleUntilReleased(RELEASE_SLACK_MS * 2);
    expect(releasedAt).toBeDefined();
    expect(releasedAt!).toBeGreaterThan(acquiredAt + SESSION_IDLE_TIMEOUT_MS);
    expect(releasedAt!).toBeLessThanOrEqual(
      acquiredAt + SESSION_IDLE_TIMEOUT_MS + RELEASE_SLACK_MS,
    );

    // Released as idle, not as a dead owner: the heartbeat reaper never fired.
    expect(reaped).toEqual([]);
    expect(forwarded.map((call) => call.tool)).toEqual(["getAndroid"]);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
    const available = await daemonMethod("daemon/availableDevices");
    expect(available.result).toMatchObject({ availableDevices: 1, assignedDevices: 0 });
    // Whichever idle path wins — the scan's sweep or the next tick's lookup — the
    // reason is an idle expiry, never "heartbeat-timeout".
    const releasedRow = await persistence.getSession?.(SESSION);
    expect(releasedRow).toMatchObject({ status: "expired" });
    expect(["cleanup-expired", "lazy-expiry"]).toContain(releasedRow!.release_reason!);
  });

  test("a tool call a minute before the deadline moves the release a full window later; heartbeats alone never move it", async () => {
    const acquiredAt = timer.now();
    await idleFor(SESSION_IDLE_TIMEOUT_MS - 60_000);
    const usedAt = timer.now();
    await proxy.callTool("observe", {});
    expect(forwarded.at(-1)).toEqual({
      tool: "observe",
      sessionUuid: SESSION,
      boundSession: SESSION,
    });
    expect(manager.getSession(SESSION)!.lastUsedAt).toBe(usedAt);
    expect(manager.getSession(SESSION)!.expiresAt).toBe(usedAt + SESSION_IDLE_TIMEOUT_MS);

    // Past the original deadline the session is still held, on the tool call's clock.
    await idleFor(acquiredAt + SESSION_IDLE_TIMEOUT_MS + RELEASE_SLACK_MS - timer.now());
    expect(isReleased()).toBe(false);
    expect(manager.getSession(SESSION)!.expiresAt).toBe(usedAt + SESSION_IDLE_TIMEOUT_MS);

    await idleFor(usedAt + SESSION_IDLE_TIMEOUT_MS - KEEPER_INTERVAL_MS - timer.now());
    expect(isReleased()).toBe(false);
    const releasedAt = await idleUntilReleased(RELEASE_SLACK_MS * 2);
    expect(releasedAt).toBeDefined();
    expect(releasedAt!).toBeGreaterThan(usedAt + SESSION_IDLE_TIMEOUT_MS);
    expect(releasedAt!).toBeLessThanOrEqual(usedAt + SESSION_IDLE_TIMEOUT_MS + RELEASE_SLACK_MS);
    expect(reaped).toEqual([]);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  });

  test("#10692: an agent driving the device through a platform selector keeps it, and it is released one window after its last call", async () => {
    const until = timer.now() + SESSION_IDLE_TIMEOUT_MS * 3;
    while (timer.now() < until) {
      await idleFor(SESSION_IDLE_TIMEOUT_MS / 2);
      await proxy.callTool("pressButton", { platform: "android", button: "back" });
    }
    const lastCallAt = timer.now();
    expect(forwarded.at(-1)).toMatchObject({ tool: "pressButton", sessionUuid: undefined });
    expect(isReleased()).toBe(false);
    expect(manager.getSession(SESSION)!.lastUsedAt).toBe(lastCallAt);

    const releasedAt = await idleUntilReleased(SESSION_IDLE_TIMEOUT_MS + RELEASE_SLACK_MS * 2);
    expect(releasedAt).toBeDefined();
    expect(releasedAt!).toBeGreaterThan(lastCallAt + SESSION_IDLE_TIMEOUT_MS);
    expect(releasedAt!).toBeLessThanOrEqual(
      lastCallAt + SESSION_IDLE_TIMEOUT_MS + RELEASE_SLACK_MS,
    );
    // Released as idle, never as an owner that stopped heartbeating.
    expect(reaped).toEqual([]);
  });

  test("past the replay TTL the proxy no longer replays the idle binding: heartbeat acks do not refresh it", async () => {
    await idleFor(DAEMON_BOUND_SESSION_REPLAY_TTL_MS + RELEASE_SLACK_MS);

    // A sessionless call from the long-idle agent is not rewritten onto the
    // released session; it is told to acquire a new device instead.
    await expect(proxy.callTool("observe", {})).rejects.toThrow(/released|getAndroid/i);
    expect(forwarded.map((call) => call.tool)).toEqual(["getAndroid"]);
  });

  test("control: once the proxy keeper stops, the same harness frees the device within lease, grace and one scan", async () => {
    await idleFor(60_000);
    expect(reaped).toEqual([]);

    // stdin EOF: the proxy closes and stops its keeper. Nothing else changes.
    await proxy.close();
    // Lease, then suspect grace, then one reaper scan.
    await idleFor(LEASE_MS + SUSPECT_GRACE_MS + REAPER_SCAN_MS + KEEPER_INTERVAL_MS);

    // Owner gone is still reported as a heartbeat timeout, distinct from idle expiry.
    expect(reaped).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
    expect(manager.getSession(SESSION)).toBeNull();
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  });
});
