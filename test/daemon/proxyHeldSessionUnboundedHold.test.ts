import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DAEMON_HEARTBEAT_METHOD, DAEMON_VERSION } from "../../src/daemon/constants";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError } from "../../src/models/ActionableError";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// H2 reproduction: "a proxy holds every session it ever bound" (since 5147bbad / #10115).
//
// When a later acquisition or an args-named `sessionUuid` rebinds the proxy,
// `DaemonMcpProxy.holdPreviousBinding` moves the previous binding into `otherHeldSessions`. Every
// keeper tick then heartbeats all of those sessions with the proxy's owner token. A held session
// leaves the set only on a release notification, not-found, expiry, a stall handover or a conflict
// leash. There is no idle eviction and no cap. On the daemon, each owner heartbeat goes through
// `handleHeartbeat` and then `SessionManager.recordHeartbeat`, which re-stamps
// `expiresAt = now + sessionTimeoutMs`. So the session's own 30-minute idle expiry never fires
// either. A device the agent has moved away from stays `busy` for as long as the MCP proxy process
// lives.
//
// Driven for real:
// - DaemonMcpProxy: keeper, result-minted binding, holdPreviousBinding, held-session heartbeats,
//   args-named rebinding, and adoptCliSessionLiveness for the one-shot CLI.
// - handleDaemonRequest: daemon/heartbeat, including the ownership claim and
//   restoreHeartbeatLivenessPolicy.
// - SessionManager: session creation via the pool, recordHeartbeat, expiry, and its own 5-minute
//   cleanup interval.
// - DevicePool: bindOrReuseDeviceSession and busy/idle state.
// - SessionHeartbeatMonitor: the production reaper, started on the fake timer.
// - releaseSessionAndDevice: the reap path that daemon.cancelAndReleaseSession uses.
//
// Faked:
// - The socket transport. FakeDaemonClient forwards daemon/* methods straight into
//   handleDaemonRequest and re-throws failures the way DaemonClient.daemonResponseError does.
// - The daemon's MCP tool layer. getAndroid binds through the real pool but skips boot and
//   readiness, and observe is a no-op.
// - Device discovery (FakeDeviceUtils), persistence, and the DB write barrier.

const DEVICE_A = { deviceId: "emulator-5554", name: "Pixel_A", platform: "android" as const };
const DEVICE_B = { deviceId: "emulator-5556", name: "Pixel_B", platform: "android" as const };
/** DAEMON_MCP_HEARTBEAT_INTERVAL_MS: the production keeper cadence with no lease override. */
const DEFAULT_PROXY_INTERVAL_MS = 2_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** SessionManager.SESSION_TIMEOUT_MS: the idle expiry a getAndroid-minted session is created with. */
const SESSION_IDLE_TIMEOUT_MS = 30 * MINUTE_MS;

const LIVENESS_ENV_KEYS = [
  "AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
  "AUTOMOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
  "AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
  "AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
  "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
  "AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
  "AUTO_MOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
] as const;

interface HeartbeatReply {
  client: string;
  sessionId: string;
  at: number;
  success: boolean;
  claim: boolean;
  policy: unknown;
}

function acquisitionResult(sessionUuid: string, deviceId: string) {
  return {
    content: [
      { type: "text", text: JSON.stringify({ runtime: { deviceId, session: { sessionUuid } } }) },
    ],
  };
}

describe("H2: a proxy holds every session it ever bound, with no bound", () => {
  let savedEnv: Map<string, string | undefined>;
  let logSpies: Array<ReturnType<typeof spyOn>>;
  let timer: FakeTimer;
  let manager: SessionManager | undefined;
  let pool: DevicePool;
  let monitor: SessionHeartbeatMonitor | undefined;
  let daemonState: DaemonStateAccess;
  let reaped: Array<{ sessionId: string; reason: string; at: number }>;
  let replies: HeartbeatReply[];
  let sessionIds: FakeIdGenerator;
  let proxies: DaemonMcpProxy[];
  let clients: Map<string, FakeDaemonClient>;
  /** Lease shared by the daemon (env) and the proxy (config); undefined = production defaults. */
  let leaseMs: number | undefined;

  /**
   * Start the daemon side for real: SessionManager, DevicePool over two emulators, and the
   * production heartbeat reaper on the fake timer.
   *
   * `lease` applies one heartbeat lease consistently on both ends: the daemon reads
   * AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS, and the proxy gets `heartbeatTimeoutMs`, from which it
   * derives a lease/2 cadence. Without it, both ends run their production defaults: a 10 s lease and
   * a 2 s keeper.
   */
  async function startDaemon(lease?: number): Promise<void> {
    leaseMs = lease;
    if (lease !== undefined) {
      process.env.AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS = String(lease);
    }
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [DEVICE_A, DEVICE_B]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "test-daemon", { timer, deviceManager: utils }),
    );
    await pool.initializeWithDevices([DEVICE_A, DEVICE_B]);
    const sessions = manager;
    daemonState = {
      isInitialized: () => true,
      getSessionManager: () => sessions,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(timer, new FakeIdGenerator()),
    };
    // Production fans every release out to subscribed proxies through SessionReleaseBroadcaster and
    // the socket server (daemon.ts:770, socketServer.ts:1122). Here the fan-out goes straight to each
    // connection, so a proxy drops a session the daemon released, as it would in production.
    sessions.onSessionRelease((sessionId, _deviceId, reason) => {
      for (const client of clients.values()) {
        client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, sessionId, reason);
      }
    });
    // Wired as daemon.startHeartbeatMonitor wires it, with no active executions.
    monitor = new SessionHeartbeatMonitor(
      sessions,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason, at: timer.now() });
        const deviceId =
          pool.getAllDevices().find((device) => device.sessionId === sessionId)?.id ?? null;
        await releaseSessionAndDevice(sessions, pool, deviceId, sessionId, reason);
      },
      timer,
    );
    monitor.start();
  }

  /**
   * One daemon connection. Tool calls go to a minimal stand-in for the daemon's MCP tool layer,
   * which binds through the REAL pool. Every daemon/* RPC goes through the REAL
   * handleDaemonRequest.
   */
  function daemonConnection(label: string): FakeDaemonClient {
    let lastAcquisition: { sessionUuid: string; deviceId: string } | undefined;
    const client = new FakeDaemonClient({
      onCallTool: async (toolName, params) => {
        if (toolName !== "getAndroid") {
          return;
        }
        // Production path: getAndroid calls prepareDevice, which calls bindBootedDeviceSession,
        // which calls pool.bindOrReuseDeviceSession(idGenerator.next(), deviceId, platform, ...).
        const sessionUuid = sessionIds.next();
        const deviceId = String(params.deviceId);
        await pool.bindOrReuseDeviceSession(sessionUuid, deviceId, "android");
        lastAcquisition = { sessionUuid, deviceId };
      },
      toolResultFor: (toolName) =>
        toolName === "getAndroid" && lastAcquisition
          ? acquisitionResult(lastAcquisition.sessionUuid, lastAcquisition.deviceId)
          : undefined,
      onCallDaemonMethod: async (method, params) => {
        const response = await handleDaemonRequest(
          { id: `${label}-rpc`, type: "daemon_request", method, params },
          daemonState,
        );
        if (method === DAEMON_HEARTBEAT_METHOD) {
          replies.push({
            client: label,
            sessionId: params.sessionId,
            at: timer.now(),
            success: response.success,
            claim: params.claimLivenessOwnership === true,
            policy: params.livenessPolicy,
          });
        }
        if (!response.success) {
          // Same shape DaemonClient.daemonResponseError produces for an envelope-less failure.
          throw Object.assign(new ActionableError(response.error ?? "Unknown error from daemon"), {
            code: response.code,
          });
        }
      },
    });
    clients.set(label, client);
    return client;
  }

  function createProxy(label: string, ownerToken: string): DaemonMcpProxy {
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const client = daemonConnection(label);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager,
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      livenessOwnerToken: ownerToken,
      ...(leaseMs !== undefined ? { heartbeatTimeoutMs: leaseMs } : {}),
    });
    proxies.push(proxy);
    return proxy;
  }

  function heartbeatsSince(sinceMs: number, sessionId: string): HeartbeatReply[] {
    return replies.filter((reply) => reply.sessionId === sessionId && reply.at > sinceMs);
  }

  /** Tool calls the agent (not the keeper) sent through `label` that named `sessionUuid`. */
  function toolCallsNaming(label: string, sessionUuid: string, fromIndex: number): number {
    return clients
      .get(label)!
      .callToolCalls.slice(fromIndex)
      .filter((call) => call.params.sessionUuid === sessionUuid).length;
  }

  /** The agent keeps working on its bound session only: one implicit call per `everyMs`. */
  async function workOnBoundSessionFor(
    proxy: DaemonMcpProxy,
    durationMs: number,
    everyMs: number,
  ): Promise<void> {
    for (let elapsed = 0; elapsed < durationMs; elapsed += everyMs) {
      await proxy.callTool("observe", {});
      await timer.advanceTimeAsync(Math.min(everyMs, durationMs - elapsed));
    }
  }

  function setUpWorld(): void {
    savedEnv = new Map(LIVENESS_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of LIVENESS_ENV_KEYS) {
      delete process.env[key];
    }
    logSpies = [
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];
    timer = new FakeTimer();
    manager = undefined;
    monitor = undefined;
    leaseMs = undefined;
    reaped = [];
    replies = [];
    proxies = [];
    clients = new Map();
    sessionIds = new FakeIdGenerator(["session-A", "session-B", "session-C"]);
  }

  async function tearDownWorld(): Promise<void> {
    for (const proxy of proxies) {
      await proxy.close();
    }
    await monitor?.stop();
    manager?.stopCleanupTimer();
    for (const spy of logSpies) {
      spy.mockRestore();
    }
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  beforeAll(async () => {
    // Pay the one-time cold start (module init and first JIT of the proxy keeper, the heartbeat
    // handler, the pool and the reaper) here, outside the 100 ms per-test budget. This is a
    // throwaway run of the same paths the tests drive, and nothing asserts on it.
    setUpWorld();
    try {
      await startDaemon();
      const cli = createProxy("cli", "warm-cli");
      await cli.callTool("getAndroid", { deviceId: DEVICE_A.deviceId });
      await cli.adoptCliSessionLiveness();
      await cli.close();
      const proxy = createProxy("stdio", "warm-stdio");
      await proxy.callTool("getAndroid", { deviceId: DEVICE_B.deviceId });
      await proxy.callTool("observe", { sessionUuid: "session-A" });
      await proxy.callTool("observe", { sessionUuid: "session-B" });
      await workOnBoundSessionFor(proxy, 2 * MINUTE_MS, MINUTE_MS);
      await proxy.close();
      await timer.advanceTimeAsync(40_000);
    } finally {
      await tearDownWorld();
    }
  });

  beforeEach(setUpWorld);
  afterEach(tearDownWorld);

  test("control: the reaper frees a device about 20 s after its proxy stops heartbeating", async () => {
    await startDaemon();
    const proxy = createProxy("stdio", "stdio-owner");
    await proxy.callTool("getAndroid", { deviceId: DEVICE_A.deviceId });
    expect(pool.getDevice(DEVICE_A.deviceId)).toMatchObject({
      status: "busy",
      sessionId: "session-A",
    });

    await proxy.close();
    // A 10 s lease, plus 10 s of suspect grace, plus one 10 s monitor sweep.
    await timer.advanceTimeAsync(40_000);

    expect(reaped.map(({ sessionId, reason }) => ({ sessionId, reason }))).toEqual([
      { sessionId: "session-A", reason: "heartbeat-timeout" },
    ]);
    expect(manager!.getSession("session-A")).toBeNull();
    expect(pool.getDevice(DEVICE_A.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  });

  test("(a) production cadence: device A stays busy after the agent moves to device B", async () => {
    await startDaemon();
    const proxy = createProxy("stdio", "stdio-owner");
    await proxy.callTool("getAndroid", { deviceId: DEVICE_A.deviceId });
    await proxy.callTool("getAndroid", { deviceId: DEVICE_B.deviceId });
    const movedAt = timer.now();
    const callsAfterMove = clients.get("stdio")!.callToolCalls.length;

    // Five minutes of work on device B only: 7.5x the 40 s in which the control reaps.
    await workOnBoundSessionFor(proxy, 5 * MINUTE_MS, MINUTE_MS);
    const end = timer.now();
    expect(toolCallsNaming("stdio", "session-B", callsAfterMove)).toBe(5);
    expect(toolCallsNaming("stdio", "session-A", callsAfterMove)).toBe(0);

    // CURRENT (gap) behaviour: no tool call names session-A, yet the proxy heartbeats it on every
    // 2 s tick with its owner token. The daemon accepts each heartbeat, the reaper never fires,
    // and device A stays allocated.
    const sinceMove = heartbeatsSince(movedAt, "session-A");
    expect(sinceMove.length).toBeGreaterThanOrEqual((end - movedAt) / DEFAULT_PROXY_INTERVAL_MS);
    expect(sinceMove.every((reply) => reply.success && reply.client === "stdio")).toBe(true);
    expect(reaped).toEqual([]);
    expect(manager!.getSession("session-A")).toMatchObject({
      livenessPolicy: "heartbeat",
      livenessOwnerToken: "stdio-owner",
      heartbeatTimeoutMs: 10_000,
    });
    expect(pool.getDevice(DEVICE_A.deviceId)).toMatchObject({
      status: "busy",
      sessionId: "session-A",
    });
    expect(pool.getStats().idle).toBe(0);

    // The proxy alone holds it: once it goes away, the reaper frees device A as in the control.
    await proxy.close();
    await timer.advanceTimeAsync(40_000);
    expect(reaped.map((entry) => entry.sessionId).sort()).toEqual(["session-A", "session-B"]);
    expect(pool.getDevice(DEVICE_A.deviceId)).toMatchObject({ status: "idle", sessionId: null });

    // AFTER A FIX that bounds held sessions, the hold section above should instead assert that
    // session-A is released, or at least no longer heartbeated, once no tool call has named it
    // for the bound:
    //   expect(heartbeatsSince(end - MINUTE_MS, "session-A")).toEqual([]);
    //   expect(reaped.map((r) => r.sessionId)).toContain("session-A");
    //   expect(pool.getDevice(DEVICE_A.deviceId)).toMatchObject({ status: "idle", sessionId: null });
    //   expect(pool.getDevice(DEVICE_B.deviceId)).toMatchObject({ status: "busy", sessionId: "session-B" });
    // (The bound could be the session's own sessionTimeoutMs; see the next test.)
  });

  test("(a) hours: device A outlives its own 30-minute idle expiry and is held for 2 hours", async () => {
    // One lease applied consistently on both ends (daemon env and proxy config), 60 s, so the keeper
    // ticks every 30 s and 2 hours stay within the unit-test budget. The held-session mechanism is
    // independent of cadence: every tick heartbeats every held session.
    await startDaemon(60_000);
    const proxy = createProxy("stdio", "stdio-owner");
    await proxy.callTool("getAndroid", { deviceId: DEVICE_A.deviceId });
    await proxy.callTool("getAndroid", { deviceId: DEVICE_B.deviceId });
    const movedAt = timer.now();
    const callsAfterMove = clients.get("stdio")!.callToolCalls.length;

    await workOnBoundSessionFor(proxy, 2 * HOUR_MS, 10 * MINUTE_MS);
    const end = timer.now();
    expect(toolCallsNaming("stdio", "session-B", callsAfterMove)).toBe(12);
    expect(toolCallsNaming("stdio", "session-A", callsAfterMove)).toBe(0);

    // CURRENT (gap) behaviour: every held-session heartbeat re-stamps
    // expiresAt = now + sessionTimeoutMs. So neither the heartbeat reaper nor the idle sweep
    // (the monitor's per-tick cleanupExpiredSessions, and SessionManager's own 5-minute cleanup)
    // ever releases session-A. Nothing has used it for 2 hours, four times its idle timeout.
    const sessionA = manager!.getSession("session-A");
    expect(sessionA).toMatchObject({
      livenessPolicy: "heartbeat",
      livenessOwnerToken: "stdio-owner",
      heartbeatTimeoutMs: 60_000,
      sessionTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
    });
    expect(end - movedAt).toBe(4 * SESSION_IDLE_TIMEOUT_MS);
    expect(sessionA!.expiresAt).toBeGreaterThan(end);
    // At least one heartbeat per 30 s keeper tick (a tool call's immediate keeper run can add one).
    expect(heartbeatsSince(end - 10 * MINUTE_MS, "session-A").length).toBeGreaterThanOrEqual(20);
    expect(heartbeatsSince(movedAt, "session-A").every((reply) => reply.success)).toBe(true);
    expect(reaped).toEqual([]);
    expect(pool.getDevice(DEVICE_A.deviceId)).toMatchObject({
      status: "busy",
      sessionId: "session-A",
    });
    expect(pool.getDevice(DEVICE_B.deviceId)).toMatchObject({
      status: "busy",
      sessionId: "session-B",
    });

    // AFTER A FIX, this should instead hold: by the time no tool call has named session-A for its
    // sessionTimeoutMs (30 minutes), the proxy stops heartbeating it and the daemon releases it.
    //   expect(manager!.getSession("session-A")).toBeNull();
    //   expect(reaped.map((r) => r.sessionId)).toEqual(["session-A"]);  // or an explicit release
    //   expect(pool.getDevice(DEVICE_A.deviceId)).toMatchObject({ status: "idle", sessionId: null });
    //   expect(heartbeatsSince(end - 10 * MINUTE_MS, "session-A")).toEqual([]);
    // while session-B, which the agent is using, keeps device B.
  });

  test("(b)+(c) naming a --cli session once adopts it and holds it past its 10-minute idle timeout", async () => {
    await startDaemon();
    // A one-shot `auto-mobile --cli getAndroid` invocation acquires device A, declares the CLI
    // liveness policy (a 10-minute idle window, under its own token), and exits.
    const cli = createProxy("cli", "cli-owner");
    await cli.callTool("getAndroid", { deviceId: DEVICE_A.deviceId });
    expect(await cli.adoptCliSessionLiveness()).toBe("session-A");
    await cli.close();
    expect(manager!.getSession("session-A")).toMatchObject({
      livenessPolicy: "cli-idle",
      livenessOwnerToken: "cli-owner",
      heartbeatTimeoutMs: 10 * MINUTE_MS,
    });

    // The long-lived stdio proxy acquires device B. The agent then passes the CLI session's UUID to
    // one tool call (for example, copied from the CLI output) and goes straight back to its own
    // session.
    const stdio = createProxy("stdio", "stdio-owner");
    await stdio.callTool("getAndroid", { deviceId: DEVICE_B.deviceId });
    const namedAt = timer.now();
    await stdio.callTool("observe", { sessionUuid: "session-A" });
    await stdio.callTool("observe", { sessionUuid: "session-B" });
    const callsAfterMoveBack = clients.get("stdio")!.callToolCalls.length;

    // 12 minutes of work on device B only, past the 10-minute CLI idle timeout.
    await workOnBoundSessionFor(stdio, 12 * MINUTE_MS, 2 * MINUTE_MS);
    const end = timer.now();
    expect(toolCallsNaming("stdio", "session-A", callsAfterMoveBack)).toBe(0);

    // CURRENT (gap) behaviour: the single args-named call made the stdio proxy claim session-A at
    // once, because a cli-idle owner never blocks a claim. The claim heartbeat moved the session
    // back to the strict heartbeat policy. The proxy's held-session ticks then keep it alive with
    // no bound, so cli-idle-timeout never fires and device A is never returned.
    // The first claim lands with the args-named call itself. If that call moved session-A into
    // `otherHeldSessions` before the claim was acknowledged, the held entry may resend the same
    // claim under the same token once. Every claim is accepted.
    const claimsForA = replies.filter(
      (reply) => reply.client === "stdio" && reply.sessionId === "session-A" && reply.claim,
    );
    expect(claimsForA.length).toBeGreaterThanOrEqual(1);
    expect(claimsForA[0]!.at).toBe(namedAt);
    expect(claimsForA.every((reply) => reply.success && reply.policy === "heartbeat")).toBe(true);
    const lastMinute = heartbeatsSince(end - MINUTE_MS, "session-A");
    expect(lastMinute.length).toBeGreaterThanOrEqual(MINUTE_MS / DEFAULT_PROXY_INTERVAL_MS);
    expect(lastMinute.every((reply) => reply.client === "stdio" && reply.success)).toBe(true);
    expect(reaped).toEqual([]);
    expect(manager!.getSession("session-A")).toMatchObject({
      livenessPolicy: "heartbeat",
      livenessOwnerToken: "stdio-owner",
      heartbeatTimeoutMs: 10_000,
    });
    expect(pool.getDevice(DEVICE_A.deviceId)).toMatchObject({
      status: "busy",
      sessionId: "session-A",
    });

    // AFTER A FIX, one of the following should hold instead. Either a session merely named in args
    // is not adopted, so it keeps cli-idle and is reaped as cli-idle-timeout at about 10 minutes:
    //   expect(reaped).toContainEqual(expect.objectContaining({ sessionId: "session-A", reason: "cli-idle-timeout" }));
    // or the bound on held sessions releases it once nothing names it. In both cases:
    //   expect(manager!.getSession("session-A")).toBeNull();
    //   expect(pool.getDevice(DEVICE_A.deviceId)).toMatchObject({ status: "idle", sessionId: null });
    // with session-B still busy, and no stdio heartbeat for session-A in the last minute.
  });
});
