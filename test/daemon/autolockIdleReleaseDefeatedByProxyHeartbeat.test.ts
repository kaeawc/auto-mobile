import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
} from "../../src/daemon/ownerDisconnectRelease";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError } from "../../src/models";
import { executionTracker } from "../../src/server/executionTracker";
import {
  SESSION_RELEASED_NOTIFICATION_METHOD,
  SessionReleaseBroadcaster,
} from "../../src/server/sessionReleaseBroadcast";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, drainUntilQuiescent } from "../helpers/fakeTimerStepping";

// Hypothesis H3 (autolock idle release defeated by the proxy keeper).
//
// With AUTOMOBILE_DEVICE_POOL_AUTOLOCK=1 the documented contract is "a device is
// freed if no interaction occurs within AUTOMOBILE_DEVICE_POOL_TIMEOUT"
// (src/daemon/poolConfig.ts:153-157; docs/using/environment-variables.md
// AUTOMOBILE_DEVICE_POOL_AUTOLOCK row: "auto-release on idle", 60 s default).
// autolockDevice builds that contract on the premise "Autolock clients
// (CLI/agents) do not send heartbeats" (src/daemon/deviceAutolockManager.ts:251-256)
// and sets sessionTimeoutMs = heartbeatTimeoutMs = 60 s.
//
// The stdio proxy breaks that premise: an acquisition tool's RESULT carries the
// autolock session UUID (src/server/deviceToolsStartDevice.ts:621-640 returns the
// autolock id, src/server/deviceDescription.ts:214-219 publishes it as
// runtime.session.sessionUuid), the proxy binds it
// (bindResultMintedDeviceSession, src/daemon/daemonMcpProxy.ts:4976-5030) and its
// keeper heartbeats it every 2 s. Each heartbeat runs SessionManager.recordHeartbeat,
// which moves `expiresAt = now + sessionTimeoutMs` (src/daemon/sessionManager.ts:5464-5468),
// so neither the expiry sweep nor the heartbeat reaper ever fires while the proxy lives.
//
// What is REAL here: DaemonMcpProxy (keeper, claim, binding), handleDaemonRequest's
// daemon/heartbeat handler, SessionManager, DevicePool.autolockDevice, the daemon's
// SessionHeartbeatMonitor (production default 10 s scan) with the daemon's reap path
// (releaseSessionAndDevice), and the SessionReleaseBroadcaster -> proxy release fan-out.
// What is FAKED: the socket transport (BridgeDaemonClient hands daemon/* requests to
// the real handler in-process and maps success:false to a coded error as
// DaemonClient.daemonResponseError does), the getAndroid tool body (it performs the
// exact pool.autolockDevice call bindBootedDeviceSession makes and returns the
// runtime.session.sessionUuid envelope describeBooted produces, but skips boot and
// CtrlProxy readiness), device discovery (FakeDeviceUtils), persistence, the DB write
// barrier, and time (FakeTimer).

const DEVICE = { deviceId: "emulator-5554", name: "Pixel 7", platform: "android" as const };
const MCP_SOCKET_SESSION = "mcp-socket-1";
const AUTOLOCK_IDLE_TIMEOUT_MS = 60_000;
const MONITOR_SCAN_MS = 10_000; // SessionHeartbeatMonitor production default.
const ONE_HOUR_MS = 60 * 60 * 1_000;
const KEEPER_INTERVAL_MS = 2_000; // DAEMON_MCP_HEARTBEAT_INTERVAL_MS production default.

const ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTOMOBILE_DEVICE_POOL_TIMEOUT",
  "AUTO_MOBILE_DEVICE_POOL_TIMEOUT",
  "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
  "AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
  "AUTOMOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
] as const;

/**
 * Hands every daemon/* request to the REAL handleDaemonRequest in-process, the way
 * socketServer.ts:1876-1882 answers daemon/heartbeat out-of-band, and runs the
 * acquisition tool against the REAL DevicePool.
 */
class BridgeDaemonClient extends FakeDaemonClient {
  constructor(
    private readonly state: DaemonStateAccess,
    private readonly pool: DevicePool,
  ) {
    super();
  }

  override async callTool(
    toolName: string,
    params: Record<string, any>,
    progressToken?: string | number,
    onRequestId?: (requestId: string) => void,
    signal?: AbortSignal,
  ): Promise<any> {
    const fallback = await super.callTool(toolName, params, progressToken, onRequestId, signal);
    if (toolName !== "getAndroid") {
      return fallback;
    }
    // The call bindBootedDeviceSession makes when autolock is enabled
    // (deviceToolsStartDevice.ts:621-633); the socket server supplies __mcpSessionId.
    const sessionUuid = await this.pool.autolockDevice(
      DEVICE.deviceId,
      DEVICE.platform,
      MCP_SOCKET_SESSION,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            runtime: { deviceId: DEVICE.deviceId, session: { sessionUuid, ownership: "owned" } },
          }),
        },
      ],
    };
  }

  override async callDaemonMethod(method: string, params: Record<string, any>): Promise<any> {
    const fallback = await super.callDaemonMethod(method, params);
    if (!method.startsWith("daemon/")) {
      return fallback;
    }
    const response = await handleDaemonRequest(
      { id: `bridge-${method}`, type: "daemon_request", method, params },
      this.state,
    );
    if (response.success) {
      return response.result;
    }
    // Mirrors DaemonClient's daemonFallbackResponseError + top-level `code`.
    throw Object.assign(new ActionableError(response.error ?? "Unknown error from daemon"), {
      code: response.code,
    });
  }
}

describe("H3: autolock idle release vs. the stdio proxy keeper", () => {
  let savedEnv: Record<string, string | undefined>;
  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let monitor: SessionHeartbeatMonitor;
  let client: BridgeDaemonClient;
  let proxy: DaemonMcpProxy | undefined;
  let releaseReasons: Array<{ sessionId: string; reason: string | undefined; at: number }>;
  let unsubscribeBroadcast: () => void;
  let spies: Array<ReturnType<typeof spyOn>>;

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "60";
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];

    timer = new FakeTimer();
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("android", [DEVICE]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "daemon-session-1", {
        timer,
        deviceManager: deviceUtils,
        idGenerator: new CountingIdGenerator("autolock"),
      }),
    );
    await pool.initializeWithDevices([DEVICE]);

    // daemon.ts:769-778 broadcasts every release; socketServer.ts:1122-1127 fans it
    // out to connected proxies.
    releaseReasons = [];
    manager.onSessionRelease((sessionId, _deviceId, reason, snapshot) => {
      SessionReleaseBroadcaster.emit(sessionId, reason, snapshot);
    });
    unsubscribeBroadcast = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      releaseReasons.push({ sessionId, reason, at: timer.now() });
      client?.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, sessionId, reason);
    });

    // daemon.ts:2440-2450 with the production default scan interval and grace.
    monitor = new SessionHeartbeatMonitor(
      manager,
      (sessionId) =>
        pool.isSessionRecoveryInFlight(sessionId) ||
        executionTracker.hasActiveSessionUuidExecutions(sessionId) ||
        executionTracker.hasActiveAutolockSessionExecutions(sessionId),
      async (sessionId, reason) => {
        const deviceId =
          pool.getAllDevices().find((device) => device.sessionId === sessionId)?.id ?? null;
        await releaseSessionAndDevice(manager, pool, deviceId, sessionId, reason);
      },
      timer,
    );
    monitor.start();

    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    };
    client = new BridgeDaemonClient(state, pool);
  });

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    await monitor.stop();
    manager.stopCleanupTimer();
    unsubscribeBroadcast();
    for (const spy of spies) {
      spy.mockRestore();
    }
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  function createProxy(): DaemonMcpProxy {
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    // Production cadence: no heartbeatTimeoutMs/heartbeatIntervalMs override (2 s keeper).
    return new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
    });
  }

  /** Advance fake time one due event at a time, letting each event's async work settle. */
  async function advance(ms: number): Promise<void> {
    await timer.advanceTimeAsync(ms, () => drainMicrotasks(60));
  }

  function heartbeatsFor(sessionId: string) {
    return client.callDaemonMethodCalls.filter(
      (call) => call.method === "daemon/heartbeat" && call.params.sessionId === sessionId,
    );
  }

  test("control: an autolock nobody heartbeats is freed ~60 s after acquisition", async () => {
    const sessionId = await pool.autolockDevice(
      DEVICE.deviceId,
      DEVICE.platform,
      MCP_SOCKET_SESSION,
    );
    expect(sessionId).toBe("autolock-1");
    const acquiredAt = timer.now();
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
      status: "busy",
      autolockSessionId: sessionId,
    });

    await advance(AUTOLOCK_IDLE_TIMEOUT_MS + MONITOR_SCAN_MS);
    await drainUntilQuiescent(timer);

    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
      status: "idle",
      sessionId: null,
      autolockSessionId: undefined,
    });
    expect(releaseReasons).toHaveLength(1);
    expect(releaseReasons[0]).toMatchObject({ sessionId, reason: "cleanup-expired" });
    expect(releaseReasons[0]!.at - acquiredAt).toBeLessThanOrEqual(
      AUTOLOCK_IDLE_TIMEOUT_MS + MONITOR_SCAN_MS,
    );
  });

  test("BUG: an autolock acquired through the stdio proxy is held for 1 h with zero tool calls", async () => {
    proxy = createProxy();
    await proxy.callTool("getAndroid", {});
    const sessionId = "autolock-1";
    const acquiredAt = timer.now();

    // The acquisition configured the documented 60 s idle contract...
    const session = manager.getSession(sessionId)!;
    expect(session.sessionTimeoutMs).toBe(AUTOLOCK_IDLE_TIMEOUT_MS);
    expect(session.heartbeatTimeoutMs).toBe(AUTOLOCK_IDLE_TIMEOUT_MS);
    // ...and the proxy claimed it through the real daemon/heartbeat handler.
    const [claim] = heartbeatsFor(sessionId);
    expect(claim?.params).toMatchObject({
      claimLivenessOwnership: true,
      livenessPolicy: "heartbeat",
    });
    expect(session.livenessOwnerToken).toBe(claim!.params.livenessOwnerToken);
    expect(session.livenessPolicy).toBe("heartbeat");
    const toolCallsAfterAcquire = client.callToolCalls.length;

    // The agent goes quiet. Nothing but the proxy keeper and the daemon's own
    // timers runs for an hour (60x the configured idle timeout).
    await advance(ONE_HOUR_MS);
    await drainUntilQuiescent(timer);

    // No interaction happened...
    expect(client.callToolCalls.length).toBe(toolCallsAfterAcquire);
    // ...yet the keeper renewed the session every 2 s (one heartbeat per tick) ...
    expect(heartbeatsFor(sessionId).length).toBeGreaterThanOrEqual(
      ONE_HOUR_MS / KEEPER_INTERVAL_MS,
    );
    // ... so the 60 s idle release never fired: still autolocked, still busy, nothing released.
    expect(releaseReasons).toEqual([]);
    expect(manager.getSession(sessionId)).not.toBeNull();
    expect(manager.getSession(sessionId)!.expiresAt).toBeGreaterThan(timer.now());
    expect(timer.now() - acquiredAt).toBeGreaterThanOrEqual(ONE_HOUR_MS);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
      status: "busy",
      sessionId,
      autolockSessionId: sessionId,
    });
    expect(pool.getStats().idle).toBe(0);

    // EXPECTED AFTER A FIX (contract in poolConfig.ts:153-157): the device is freed
    // about AUTOMOBILE_DEVICE_POOL_TIMEOUT after the last tool call even though the
    // keeper is still ticking — keeper heartbeats prove liveness, not interaction, so
    // they must not move an autolock session's `expiresAt`. With the owned session's
    // 10 s suspect grace (livenessOwnerLease.SUSPECT_GRACE_MS) and one 10 s monitor
    // scan, that is by acquiredAt + 80 s:
    //   expect(releaseReasons.map((r) => r.sessionId)).toEqual([sessionId]);
    //   expect(releaseReasons[0].at - acquiredAt).toBeLessThanOrEqual(80_000);
    //   expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
    //     status: "idle", sessionId: null, autolockSessionId: undefined });
  });

  test("the hold lasts exactly as long as the proxy connection: closing it frees the device", async () => {
    proxy = createProxy();
    await proxy.callTool("getAndroid", {});
    const sessionId = "autolock-1";

    await advance(30 * 60 * 1_000);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId });
    expect(releaseReasons).toEqual([]);

    // The agent process exits: the proxy stops its keeper and the daemon sees the
    // socket close (socketServer.ts releaseSocketSession -> releaseMcpSessionBindings).
    const closedAt = timer.now();
    await proxy.close();
    proxy = undefined;
    pool.releaseMcpSessionBindings(MCP_SOCKET_SESSION);

    await advance(OWNER_DISCONNECT_GRACE_MS + MONITOR_SCAN_MS);
    await drainUntilQuiescent(timer);

    // #10503's owner-disconnect release frees it within its 10 s grace, so the
    // H3 hold is bounded by the proxy's lifetime, not by the 60 s idle contract.
    expect(releaseReasons.map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect(releaseReasons[0]!.reason).toBe(OWNER_DISCONNECTED_RELEASE_REASON);
    expect(releaseReasons[0]!.at - closedAt).toBeLessThanOrEqual(
      OWNER_DISCONNECT_GRACE_MS + MONITOR_SCAN_MS,
    );
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
      status: "idle",
      sessionId: null,
      autolockSessionId: undefined,
    });
  });
});
