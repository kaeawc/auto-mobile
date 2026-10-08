import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { OWNER_DISCONNECTED_RELEASE_REASON } from "../../src/daemon/ownerDisconnectRelease";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
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
import { drainUntil } from "../helpers/fakeTimerStepping";

// H9 (#10050 follow-up): a proxy whose LATEST binding names a session another live
// proxy owns keeps re-sending its ownership claim on every keeper tick with no give-up
// leash (`absorbOwnershipRefusal`), unlike a held session (`handleHeldSessionOwnerConflict`,
// bounded by `ownershipConflictLeashMs`). The moment the real owner goes silent the retried
// claim inherits the session, and the inheritor's keeper then renews it for the inheritor's
// whole lifetime although it never touches the device again.
//
// Real production code driven here: two `DaemonMcpProxy` instances (their keepers, the
// sessionUuid-arg binding, the claim/conflict absorption), the daemon's
// `handleDaemonRequest` heartbeat handler, `SessionManager` (claims, lease, idle expiry),
// `DevicePool` (device assignment, owner-disconnect release), and `SessionHeartbeatMonitor`
// (the reaper), all with production default intervals and leases. Faked: the socket
// transport (FakeDaemonClient routes calls straight into the handlers above), the device
// runtime (FakeDeviceUtils), persistence, and the clock (FakeTimer).

const SESSION = "agent-a-session";
const DEVICE = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const OWNER_TOKEN = "agent-a-token";
const CHALLENGER_TOKEN = "agent-b-token";
const KEEPER_INTERVAL_MS = 2_000; // DaemonMcpProxy default cadence
// 30x the 20 s lease-plus-grace that should have released the device. The hold is a steady
// state (each tick renews identically), so a longer window only costs test time.
const IDLE_HOLD_MS = 10 * 60 * 1_000;

interface HeartbeatReply {
  at: number;
  token: unknown;
  claim: boolean;
  success: boolean;
  code?: string;
}

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

describe("H9: a latest-binding claim refused for a live owner retries forever and inherits the session", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let monitor: SessionHeartbeatMonitor;
  let replies: HeartbeatReply[];
  let released: Array<{ sessionId: string; reason: string | undefined }>;
  let clients: FakeDaemonClient[];
  let proxies: DaemonMcpProxy[];
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let logSpies: Array<ReturnType<typeof spyOn>>;

  function daemonState(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
  }

  /** A proxy's socket: heartbeats go to the real handler, tool calls to the real session admission. */
  function daemonBackedClient(): FakeDaemonClient {
    const client = new FakeDaemonClient({
      onCallTool: async (_name, params) => {
        // The daemon resolves a device tool's sessionUuid through getOrCreateSession
        // (issued sessions only). Tool admission has no owner-token gate.
        if (typeof params.sessionUuid === "string") {
          await sessionManager.getOrCreateSession(
            params.sessionUuid,
            pool,
            "android",
            undefined,
            true,
          );
        }
      },
      onCallDaemonMethod: async (method, params) => {
        if (method !== "daemon/heartbeat") {
          return;
        }
        const response = await handleDaemonRequest(
          { id: `hb-${replies.length}`, type: "daemon_request", method, params },
          daemonState(),
        );
        replies.push({
          at: timer.now(),
          token: params.livenessOwnerToken,
          claim: params.claimLivenessOwnership === true,
          success: response.success,
          code: response.code,
        });
        if (!response.success) {
          throw Object.assign(new Error(response.error), { code: response.code });
        }
      },
    });
    clients.push(client);
    return client;
  }

  function proxyFor(livenessOwnerToken: string, initialSessionUuid?: string): DaemonMcpProxy {
    const proxy = new DaemonMcpProxy({
      clientFactory: () => daemonBackedClient(),
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator([`${livenessOwnerToken}-unused-mint`]),
      livenessOwnerToken,
      ...(initialSessionUuid ? { initialSessionUuid } : {}),
    });
    proxies.push(proxy);
    return proxy;
  }

  function repliesFor(token: string): HeartbeatReply[] {
    return replies.filter((reply) => reply.token === token);
  }

  function ownerToken(): string | undefined {
    return sessionManager.getSession(SESSION)?.livenessOwnerToken;
  }

  /** Each due timer event gets a host turn, so every keeper tick settles before the next. */
  async function advance(ms: number): Promise<void> {
    await timer.advanceTimeAsync(ms);
  }

  /**
   * Both proxies alive for a minute: agent A owns SESSION and heartbeats it; agent B named it in
   * one `observe` call and has re-claimed it on every tick since. Returns A's last ack time.
   */
  async function runContendedMinute(
    owner: DaemonMcpProxy,
    challenger: DaemonMcpProxy,
  ): Promise<number> {
    await owner.ensureConnected();
    expect(ownerToken()).toBe(OWNER_TOKEN);

    // Agent B passes agent A's UUID to a sessionUuid-accepting tool (a sub-agent, a shared
    // --initial-session-uuid, or a UUID copied from listDevices). The daemon admits it, and
    // the proxy makes it B's latest binding and starts B's keeper.
    await challenger.callTool("observe", { sessionUuid: SESSION });
    await drainUntil(() => repliesFor(CHALLENGER_TOKEN).length > 0, {
      description: "agent B's first ownership claim",
    });

    await advance(60_000);

    const challengerReplies = repliesFor(CHALLENGER_TOKEN);
    // B's keeper re-sends the claim on every 2 s tick; every one is refused; none is given up.
    expect(challengerReplies.length).toBeGreaterThanOrEqual(60_000 / KEEPER_INTERVAL_MS);
    expect(challengerReplies.every((reply) => reply.claim)).toBe(true);
    expect(challengerReplies.every((reply) => reply.code === "liveness_owner_conflict")).toBe(true);
    expect(ownerToken()).toBe(OWNER_TOKEN);
    const ownerReplies = repliesFor(OWNER_TOKEN);
    expect(ownerReplies.every((reply) => reply.success)).toBe(true);
    return ownerReplies.at(-1)!.at;
  }

  beforeEach(async () => {
    timer = new FakeTimer();
    replies = [];
    released = [];
    clients = [];
    proxies = [];
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    logSpies = (["warn", "info", "debug", "error"] as const).map((level) =>
      spyOn(logger, level).mockImplementation(() => {}),
    );
    sessionManager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("android", [DEVICE]);
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "test-daemon", {
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices([DEVICE]);
    // Agent A's device session, created with production default lease and idle timeouts.
    await pool.bindOrReuseDeviceSession(SESSION, DEVICE.deviceId, "android");
    sessionManager.onSessionRelease((sessionId, _device, reason) => {
      released.push({ sessionId, reason });
      // The daemon broadcasts every release to all connected proxies.
      for (const client of clients) {
        client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, sessionId, reason);
      }
    });
    // The daemon's reaper, wired as Daemon.startHeartbeatMonitor wires it (minus execution
    // cancellation: nothing is executing), with its production defaults (10 s scans).
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        const deviceId =
          pool.getAllDevices().find((device) => device.sessionId === sessionId)?.id ?? null;
        await releaseSessionAndDevice(sessionManager, pool, deviceId, sessionId, reason);
      },
      timer,
    );
    monitor.start();
  });

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) {
      await proxy.close();
    }
    await monitor.stop();
    sessionManager.stopCleanupTimer();
    isAvailableSpy.mockRestore();
    for (const spy of logSpies) {
      spy.mockRestore();
    }
  });

  test("the challenger inherits the session when its owner goes silent, then holds the device with no device interaction", async () => {
    // Agent A was handed SESSION by UUID (harness --initial-session-uuid): its own daemon
    // connection never acquired SESSION, so owner-disconnect release has nothing to act on.
    const owner = proxyFor(OWNER_TOKEN, SESSION);
    const challenger = proxyFor(CHALLENGER_TOKEN);
    const ownerLastAckAt = await runContendedMinute(owner, challenger);

    // Agent A dies: its keeper stops and its socket closes (the daemon drops that
    // connection's bindings exactly as the socket server does on close).
    await owner.close();
    pool.releaseMcpSessionBindings("agent-a-socket");

    const leaseMs = sessionManager.getSession(SESSION)!.heartbeatTimeoutMs;
    let inheritedAt: number | undefined;
    for (let step = 0; step < 30 && inheritedAt === undefined; step++) {
      await advance(KEEPER_INTERVAL_MS);
      if (ownerToken() === CHALLENGER_TOKEN) {
        inheritedAt = timer.now();
      }
    }

    // CURRENT (gap): B's still-retrying claim wins the session one keeper tick after A's
    // lease plus its suspect grace lapses, before the reaper's 10 s scan releases it.
    expect(inheritedAt).toBeDefined();
    const inheritedAfterMs = inheritedAt! - ownerLastAckAt;
    expect(inheritedAfterMs).toBeGreaterThan(leaseMs + SUSPECT_GRACE_MS);
    expect(inheritedAfterMs).toBeLessThanOrEqual(leaseMs + SUSPECT_GRACE_MS + KEEPER_INTERVAL_MS);
    expect(released).toEqual([]);

    const toolCalls = () => clients.flatMap((client) => client.callToolCalls).length;
    const challengerAcks = () => repliesFor(CHALLENGER_TOKEN).filter((r) => r.success).length;
    const acksBeforeIdleHold = challengerAcks();
    await advance(IDLE_HOLD_MS);

    // CURRENT (gap): 10 minutes later, with no tool call since B's single observe, the session
    // is still live, owned by B, and the device is still reserved for it. B's keeper alone
    // renewed it on every tick, so nothing bounds the hold but B's own lifetime.
    expect(toolCalls()).toBe(1);
    expect(released).toEqual([]);
    expect(sessionManager.getSession(SESSION)).toMatchObject({
      livenessOwnerToken: CHALLENGER_TOKEN,
      assignedDevice: DEVICE.deviceId,
    });
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId: SESSION });
    expect(challengerAcks() - acksBeforeIdleHold).toBeGreaterThanOrEqual(
      IDLE_HOLD_MS / KEEPER_INTERVAL_MS,
    );

    // AFTER A FIX (bound the latest binding's conflict like a held session's
    // `ownershipConflictLeashMs`, or never claim a session this proxy did not mint), B stops
    // claiming long before A dies and the reaper frees the device about 20 s after A's last ack:
    //   expect(inheritedAt).toBeUndefined();
    //   expect(released).toEqual([{ sessionId: SESSION, reason: "heartbeat-timeout" }]);
    //   expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  });

  test("control: owner-disconnect release pre-empts inheritance when the dead owner's connection acquired the session", async () => {
    const owner = proxyFor(OWNER_TOKEN, SESSION);
    const challenger = proxyFor(CHALLENGER_TOKEN);
    // A's connection holds SESSION's acquisition marker, as after getAndroid on that socket
    // or the socket server's owned-session restore for it.
    await pool.restoreOwnedDeviceSessionsForMcpSession([SESSION], "agent-a-socket");
    await runContendedMinute(owner, challenger);

    await owner.close();
    pool.releaseMcpSessionBindings("agent-a-socket");
    await advance(30_000);

    // The 10 s owner-disconnect grace fires before A's lease plus suspect grace (20 s) lapses,
    // so B's retried claim never wins and the device returns to the pool.
    expect(released).toEqual([{ sessionId: SESSION, reason: OWNER_DISCONNECTED_RELEASE_REASON }]);
    expect(repliesFor(CHALLENGER_TOKEN).some((reply) => reply.success)).toBe(false);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  });
});
