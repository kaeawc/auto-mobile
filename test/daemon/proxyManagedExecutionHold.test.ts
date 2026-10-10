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
  DAEMON_RELEASE_EXECUTION_METHOD,
  DAEMON_RELEASE_SESSION_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import {
  ManagedExecutionRelease,
  managedExecutionSessionsFrom,
} from "../../src/daemon/managedSlots/managedExecutionRelease";
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../src/daemon/managedExecutionLiveness";
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS } from "../../src/daemon/sessionLivenessWindows";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #11176: the proxy holds a managed execution's session from launch (not from its first tool
// call) and releases it promptly when the execution ends (stdin EOF / owner loss close it).
// #11177: that release is `daemon/releaseExecution`, which keeps the slot's device assignment.

const SESSION = "managed-slot-session";
const OTHER = "other-session";
const TOKEN = "managed-proxy-token";
const HEARTBEAT_INTERVAL_MS = 2_000;

describe("proxy managed-execution session hold", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let state: DaemonStateAccess;
  let releaseFails: boolean;
  let registry: FakeSlotRegistry;
  let slotKey: { scopeKey: string; slotIndex: number };

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SESSION, "emulator-5554", "android");
    await sessionManager.adoptManagedExecutionLivenessPolicy(SESSION, {
      idleTimeoutMs: 10 * 60_000,
    });
    releaseFails = false;
    registry = new FakeSlotRegistry(timer);
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "ns",
      runnerIncarnation: "boot-1",
    });
    if (scope.kind !== "ready") {
      throw new Error(`scope not ready: ${scope.kind}`);
    }
    slotKey = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
    await registry.initSlot(slotKey, { role: "primary", platform: "android", requestedSpec: {} });
    await registry.commitBinding(
      slotKey,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: "Pixel_8_API_35",
        deviceName: "amslot-test-0-g1",
        resolvedSpec: {},
        specFingerprint: "fp",
        state: "ready",
      },
    );
    await registry.claimExecution(
      slotKey,
      { generation: 1, stableDeviceId: "Pixel_8_API_35" },
      { daemonId: "daemon", pid: 1, sessionUuid: SESSION },
    );
    const drain = new ManagedExecutionRelease({
      registry: async () => registry,
      work: {
        cancelDeviceSessionExecutions: async () => 0,
        waitForDeviceSessionExecutionsToEnd: async () => true,
        hasActiveDeviceSessionExecutions: () => false,
      },
      sessions: managedExecutionSessionsFrom(sessionManager, { releaseDevice: async () => {} }),
      timer,
    });
    state = {
      isInitialized: () => true,
      getManagedExecutionRelease: () => drain,
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

  function proxyWith(clients: FakeDaemonClient[]): DaemonMcpProxy {
    return new DaemonMcpProxy({
      livenessOwnerToken: TOKEN,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      clientFactory: () => {
        const client = new FakeDaemonClient({
          onCallDaemonMethod: async (method, params) => {
            if (method === DAEMON_RELEASE_EXECUTION_METHOD && releaseFails) {
              throw new Error("daemon stalled");
            }
            const response = await handleDaemonRequest(
              { id: "r", type: "daemon_request", method, params },
              state,
            );
            if (!response.success) {
              throw Object.assign(new Error(response.error), { code: response.code });
            }
            return response.result;
          },
        });
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

  const heartbeats = (client: FakeDaemonClient) =>
    client.callDaemonMethodCalls.filter((call) => call.method === DAEMON_HEARTBEAT_METHOD);

  test("claims and heartbeats from the hold, with no tool call", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = proxyWith(clients);
    try {
      await proxy.holdManagedExecutionSession(SESSION);

      expect(clients[0]!.callToolCalls).toEqual([]);
      expect(heartbeats(clients[0]!)[0]?.params).toMatchObject({
        sessionId: SESSION,
        livenessOwnerToken: TOKEN,
        claimLivenessOwnership: true,
      });
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe(TOKEN);
      expect(proxy.getManagedExecutionSessions()).toEqual([SESSION]);

      // The keeper renews the lease with no tool call, and the session's own 10-minute managed
      // window (not the ordinary 2 minutes) bounds tool-free reasoning.
      const beatsBefore = heartbeats(clients[0]!).length;
      await timer.advanceTimeAsync(3 * HEARTBEAT_INTERVAL_MS);
      expect(heartbeats(clients[0]!).length).toBeGreaterThan(beatsBefore);
      const session = sessionManager.getSession(SESSION)!;
      expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("live");
      expect(session.livenessPolicy).toBe(MANAGED_EXECUTION_LIVENESS_POLICY);
      expect(session.expiresAt - session.lastUsedAt).toBe(10 * 60_000);
      expect(session.expiresAt - session.lastUsedAt).toBeGreaterThan(
        DEFAULT_SESSION_IDLE_TIMEOUT_MS,
      );
    } finally {
      await proxy.close();
    }
  });

  test("an already-connected proxy claims the held session immediately", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = proxyWith(clients);
    try {
      await proxy.ensureConnected();
      expect(heartbeats(clients[0]!)).toEqual([]);

      await proxy.holdManagedExecutionSession(SESSION);

      expect(clients).toHaveLength(1);
      expect(heartbeats(clients[0]!).length).toBeGreaterThanOrEqual(1);
      expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBe(TOKEN);
    } finally {
      await proxy.close();
    }
  });

  test("close (stdin EOF / owner loss) releases the session at once, not after 10 s", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = proxyWith(clients);
    await proxy.holdManagedExecutionSession(SESSION);
    const closedAt = timer.now();

    await proxy.close();

    expect(timer.now()).toBe(closedAt);
    expect(sessionManager.hasSession(SESSION)).toBe(false);
    const release = clients[0]!.callDaemonMethodCalls.find(
      (call) => call.method === DAEMON_RELEASE_EXECUTION_METHOD,
    );
    expect(release?.params).toEqual({ sessionId: SESSION });
    expect(proxy.getManagedExecutionSessions()).toEqual([]);
  });

  test("close drains through daemon/releaseExecution and keeps the slot's device (#11177)", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = proxyWith(clients);
    await proxy.holdManagedExecutionSession(SESSION);

    await proxy.close();

    // Never the device-freeing release: the slot keeps its device, only the owner is cleared.
    expect(
      clients[0]!.callDaemonMethodCalls.some(
        (call) => call.method === DAEMON_RELEASE_SESSION_METHOD,
      ),
    ).toBe(false);
    expect(await registry.getAssignment(slotKey)).toMatchObject({
      stableDeviceId: "Pixel_8_API_35",
      generation: 1,
      state: "ready",
      execOwner: null,
    });
    expect(await registry.isDeviceAssignedToValidSlot("android", "Pixel_8_API_35")).toBe(true);
  });

  test("a failed release still closes the proxy and leaves the no-heartbeat release", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const clients: FakeDaemonClient[] = [];
    const proxy = proxyWith(clients);
    try {
      await proxy.holdManagedExecutionSession(SESSION);
      releaseFails = true;

      await proxy.close();

      expect(sessionManager.hasSession(SESSION)).toBe(true);
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes("Releasing managed execution")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("refuses a second, different managed session on a bound proxy", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = proxyWith(clients);
    try {
      await proxy.holdManagedExecutionSession(SESSION);
      await expect(proxy.holdManagedExecutionSession(OTHER)).rejects.toThrow("already bound");
    } finally {
      await proxy.close();
    }
  });

  test("an ordinary proxy close releases nothing explicitly", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = proxyWith(clients);
    await proxy.ensureConnected();
    await proxy.close();
    expect(
      clients[0]!.callDaemonMethodCalls.some(
        (call) =>
          call.method === DAEMON_RELEASE_SESSION_METHOD ||
          call.method === DAEMON_RELEASE_EXECUTION_METHOD,
      ),
    ).toBe(false);
    expect(sessionManager.hasSession(SESSION)).toBe(true);
  });
});
