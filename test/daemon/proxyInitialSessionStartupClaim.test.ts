import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_RELEASE_LIVENESS_OWNERSHIP_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// mt-0083 D6: a proxy started with `--initial-session-uuid` must adopt the session at
// startup, before any tool call, so a handoff survives the previous owner stopping first.

const SESSION = "handoff-session";
const HEARTBEAT_INTERVAL_MS = 5_000;

describe("proxy --initial-session-uuid startup claim", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let state: DaemonStateAccess;

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SESSION, "emulator-5554", "android", 60_000);
    state = {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  });

  afterEach(() => {
    isAvailableSpy.mockRestore();
    sessionManager.stopCleanupTimer();
  });

  async function daemonCall(method: string, params: Record<string, unknown>) {
    return await handleDaemonRequest({ id: "r", type: "daemon_request", method, params }, state);
  }

  function daemonBackedClient(): FakeDaemonClient {
    return new FakeDaemonClient({
      onCallDaemonMethod: async (method, params) => {
        const response = await daemonCall(method, params);
        if (!response.success) {
          throw Object.assign(new Error(response.error), { code: response.code });
        }
      },
    });
  }

  function handoffProxy(clients: FakeDaemonClient[]): DaemonMcpProxy {
    return new DaemonMcpProxy({
      initialSessionUuid: SESSION,
      livenessOwnerToken: "handoff-token",
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      clientFactory: () => {
        const client = daemonBackedClient();
        clients.push(client);
        return client;
      },
      daemonManager: (() => {
        const manager = new FakeDaemonManager();
        manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
        return manager;
      })(),
      autoStartDaemon: false,
      timer,
    });
  }

  test("claims and keeps heartbeating the handed-off session before any tool call", async () => {
    // The previous owner claims, hands off, and stops heartbeating.
    expect(
      await daemonCall(DAEMON_HEARTBEAT_METHOD, {
        sessionId: SESSION,
        livenessOwnerToken: "old-token",
        claimLivenessOwnership: true,
      }),
    ).toMatchObject({ success: true });
    expect(
      await daemonCall(DAEMON_RELEASE_LIVENESS_OWNERSHIP_METHOD, {
        sessionId: SESSION,
        livenessOwnerToken: "old-token",
      }),
    ).toMatchObject({ success: true });

    const clients: FakeDaemonClient[] = [];
    const proxy = handoffProxy(clients);
    try {
      await proxy.claimInitialSession();

      expect(clients).toHaveLength(1);
      expect(clients[0].callToolCalls).toEqual([]);
      const claims = clients[0].callDaemonMethodCalls.filter(
        (call) => call.method === DAEMON_HEARTBEAT_METHOD,
      );
      expect(claims).toHaveLength(1);
      expect(claims[0].params).toMatchObject({
        sessionId: SESSION,
        livenessOwnerToken: "handoff-token",
        claimLivenessOwnership: true,
      });
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe("handoff-token");

      // The keeper now owns liveness: the next tick heartbeats without a tool call.
      const ownerHeartbeatAfterClaim = sessionManager.getSession(SESSION)!.lastOwnerHeartbeat;
      await timer.advanceTimeAsync(HEARTBEAT_INTERVAL_MS);
      expect(
        clients[0].callDaemonMethodCalls.filter((call) => call.method === DAEMON_HEARTBEAT_METHOD),
      ).toHaveLength(2);
      expect(sessionManager.getSession(SESSION)!.lastOwnerHeartbeat).toBeGreaterThan(
        ownerHeartbeatAfterClaim!,
      );
    } finally {
      await proxy.close();
    }
  });

  test("is a no-op without --initial-session-uuid", async () => {
    let created = 0;
    const proxy = new DaemonMcpProxy({
      clientFactory: () => {
        created += 1;
        return new FakeDaemonClient();
      },
      daemonManager: new FakeDaemonManager(),
      autoStartDaemon: false,
      timer,
    });
    try {
      await proxy.claimInitialSession();
      expect(created).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  test("logs and resolves when the daemon is unreachable at startup", async () => {
    isAvailableSpy.mockResolvedValue(false);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const proxy = handoffProxy([]);
    try {
      await expect(proxy.claimInitialSession()).resolves.toBeUndefined();
      expect(
        warn.mock.calls.some(([message]) =>
          String(message).includes(`Startup claim of initial session ${SESSION} failed`),
        ),
      ).toBeTrue();
    } finally {
      warn.mockRestore();
      await proxy.close();
    }
  });
});
