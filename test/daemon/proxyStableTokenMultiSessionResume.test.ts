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
  DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #10990: a proxy restarted with its stable `--liveness-owner-token` resumes EVERY session the
// token owned, not just one, and another token still cannot take them (#10664).

const FIRST = "stable-token-session-a";
const SECOND = "stable-token-session-b";
const TOKEN = "harness-stable-token";
const HEARTBEAT_INTERVAL_MS = 5_000;

describe("proxy restarted with a stable owner token", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let state: DaemonStateAccess;
  let proxies: DaemonMcpProxy[];

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(FIRST, "emulator-5554", "android", 60_000);
    await sessionManager.createSession(SECOND, "emulator-5556", "android", 60_000);
    state = {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 2, idle: 0, assigned: 2, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    proxies = [];
    // The proxy that died owned both sessions under the harness's stable token.
    for (const sessionId of [FIRST, SECOND]) {
      expect(
        await daemonCall(DAEMON_HEARTBEAT_METHOD, {
          sessionId,
          livenessOwnerToken: TOKEN,
          claimLivenessOwnership: true,
        }),
      ).toMatchObject({ success: true });
    }
  });

  afterEach(async () => {
    await Promise.all(proxies.map((proxy) => proxy.close()));
    isAvailableSpy.mockRestore();
    sessionManager.stopCleanupTimer();
  });

  async function daemonCall(method: string, params: Record<string, unknown>) {
    return await handleDaemonRequest({ id: "r", type: "daemon_request", method, params }, state);
  }

  function restartedProxy(
    clients: FakeDaemonClient[],
    options: { livenessOwnerToken: string; initialSessionUuid?: string },
  ): DaemonMcpProxy {
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    const proxy = new DaemonMcpProxy({
      ...options,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      clientFactory: () => {
        const client = new FakeDaemonClient({
          onCallDaemonMethod: async (method, params) => {
            const response = await daemonCall(method, params);
            if (!response.success) {
              throw Object.assign(new Error(response.error), { code: response.code });
            }
            return response.result;
          },
        });
        clients.push(client);
        return client;
      },
      daemonManager: manager,
      autoStartDaemon: false,
      timer,
    });
    proxies.push(proxy);
    return proxy;
  }

  function heartbeatsFor(clients: FakeDaemonClient[], sessionId: string, token = TOKEN) {
    return clients
      .flatMap((client) => client.callDaemonMethodCalls)
      .filter(
        (call) =>
          call.method === DAEMON_HEARTBEAT_METHOD &&
          call.params.sessionId === sessionId &&
          call.params.livenessOwnerToken === token,
      );
  }

  test("resumes and heartbeats both sessions, and calls on both succeed", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = restartedProxy(clients, { livenessOwnerToken: TOKEN });

    await proxy.claimInitialSession();

    for (const sessionId of [FIRST, SECOND]) {
      expect(heartbeatsFor(clients, sessionId)[0]?.params).toMatchObject({
        claimLivenessOwnership: true,
      });
    }
    const ownerHeartbeatAt = (sessionId: string) =>
      sessionManager.getSession(sessionId)!.lastOwnerHeartbeat!;
    const resumedAt = [ownerHeartbeatAt(FIRST), ownerHeartbeatAt(SECOND)];

    // The keeper heartbeats both without any tool call.
    await timer.advanceTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(heartbeatsFor(clients, FIRST)).toHaveLength(2);
    expect(heartbeatsFor(clients, SECOND)).toHaveLength(2);
    expect(ownerHeartbeatAt(FIRST)).toBeGreaterThan(resumedAt[0]);
    expect(ownerHeartbeatAt(SECOND)).toBeGreaterThan(resumedAt[1]);

    for (const sessionId of [FIRST, SECOND]) {
      const result = await proxy.callTool("observe", { sessionUuid: sessionId });
      expect(result.isError).toBeFalsy();
      expect(clients.at(-1)!.callToolCalls.at(-1)).toMatchObject({
        toolName: "observe",
        params: { sessionUuid: sessionId },
      });
    }

    // Both stay owned by the stable token and keep being heartbeated after the calls.
    const before = [heartbeatsFor(clients, FIRST).length, heartbeatsFor(clients, SECOND).length];
    await timer.advanceTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(heartbeatsFor(clients, FIRST).length).toBeGreaterThan(before[0]);
    expect(heartbeatsFor(clients, SECOND).length).toBeGreaterThan(before[1]);
    expect(sessionManager.getSession(FIRST)?.livenessOwnerToken).toBe(TOKEN);
    expect(sessionManager.getSession(SECOND)?.livenessOwnerToken).toBe(TOKEN);
  });

  test("with --initial-session-uuid, the other owned session is routable and stays heartbeated", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = restartedProxy(clients, { livenessOwnerToken: TOKEN, initialSessionUuid: FIRST });

    await proxy.claimInitialSession();
    expect(heartbeatsFor(clients, FIRST)).toHaveLength(1);
    expect(heartbeatsFor(clients, SECOND)).toHaveLength(1);

    const second = await proxy.callTool("observe", { sessionUuid: SECOND });
    expect(second.isError).toBeFalsy();
    expect(clients.at(-1)!.callToolCalls.at(-1)?.params).toMatchObject({ sessionUuid: SECOND });

    // The startup binding stays authoritative for sessionless calls.
    await proxy.callTool("observe", {});
    expect(clients.at(-1)!.callToolCalls.at(-1)?.params).toMatchObject({ sessionUuid: FIRST });

    await timer.advanceTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(heartbeatsFor(clients, FIRST).length).toBeGreaterThanOrEqual(2);
    expect(heartbeatsFor(clients, SECOND).length).toBeGreaterThanOrEqual(2);
  });

  test("the startup-bound session keeps the daemon-reported deviceId for its loss reports (#11028)", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = restartedProxy(clients, { livenessOwnerToken: TOKEN, initialSessionUuid: FIRST });

    await proxy.claimInitialSession();

    // Handover and stall payloads name a session's device from this map; calls naming the
    // startup-bound session carry no deviceId, so the token resume is its only source.
    const devices = (proxy as unknown as { sessionDeviceIds: Map<string, string> })
      .sessionDeviceIds;
    expect(devices.get(FIRST)).toBe("emulator-5554");
    expect(devices.get(SECOND)).toBe("emulator-5556");
  });

  test("a different token cannot resume them", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = restartedProxy(clients, { livenessOwnerToken: "another-harness-token" });

    await proxy.claimInitialSession();
    await proxy.callTool("observe", { sessionUuid: FIRST });
    await timer.advanceTimeAsync(HEARTBEAT_INTERVAL_MS * 3);

    expect(
      clients
        .flatMap((client) => client.callDaemonMethodCalls)
        .filter((call) => call.method === DAEMON_HEARTBEAT_METHOD),
    ).toEqual([]);
    expect(sessionManager.getSession(FIRST)?.livenessOwnerToken).toBe(TOKEN);
    expect(sessionManager.getSession(SECOND)?.livenessOwnerToken).toBe(TOKEN);
  });

  test("sessions released before the restart (grace window over) are not resumed", async () => {
    await sessionManager.releaseSession(FIRST);
    await sessionManager.releaseSession(SECOND);
    const clients: FakeDaemonClient[] = [];
    const proxy = restartedProxy(clients, { livenessOwnerToken: TOKEN });

    await proxy.claimInitialSession();
    await timer.advanceTimeAsync(HEARTBEAT_INTERVAL_MS * 2);

    expect(clients[0].callDaemonMethodCalls.map((call) => call.method)).toEqual([
      DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
    ]);
    expect(sessionManager.getSession(FIRST)).toBeNull();
    expect(sessionManager.getSession(SECOND)).toBeNull();
  });

  test("the daemon lists a token's sessions only to that token", async () => {
    expect(
      await daemonCall(DAEMON_TOKEN_OWNED_SESSIONS_METHOD, { livenessOwnerToken: TOKEN }),
    ).toMatchObject({
      success: true,
      result: {
        sessions: [
          { sessionId: FIRST, deviceId: "emulator-5554", platform: "android" },
          { sessionId: SECOND, deviceId: "emulator-5556", platform: "android" },
        ],
      },
    });
    expect(
      await daemonCall(DAEMON_TOKEN_OWNED_SESSIONS_METHOD, { livenessOwnerToken: "other" }),
    ).toMatchObject({ success: true, result: { sessions: [] } });
    expect(await daemonCall(DAEMON_TOKEN_OWNED_SESSIONS_METHOD, {})).toMatchObject({
      success: false,
    });
  });
});
