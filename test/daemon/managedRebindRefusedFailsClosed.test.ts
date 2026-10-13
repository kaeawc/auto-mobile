import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DAEMON_REGISTER_SESSION_METHOD,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import { DaemonClient, daemonResponseError } from "../../src/daemon/client";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";
import { readyManagedSlotsResult } from "../helpers/refusalWireFixtures";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  ManagedConnectionScopes,
  managedConnectionPlainToolRefusal,
} from "../../src/daemon/managedSlots/managedConnectionScope";
import { DeviceOutsideManagedSlotsError } from "../../src/daemon/managedSlots/managedSlotRefusal";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * a managed connection's slot set is fixed for its lifetime, and
 * it may never acquire, start or provision devices (`device_outside_managed_slots`, reason `tool`).
 * The confinement lives in the daemon's per-socket binding, which ends with the socket. When the
 * managed proxy's socket reconnects after its slot session ended (idle release is terminal; the
 * proxy keeps serving MCP), its `daemon/registerSession` re-bind is refused and binds nothing, so
 * the new socket is a generic connection: `getAndroid`, `startDevice` and `provisionDevice` pass
 * the managed-connection gate.
 */
describe("managed proxy re-bind after its slot session ended (#11399)", () => {
  const SLOT_SESSION = "00000000-0000-4000-8000-000000000001";
  const TOKEN = "managed-proxy-token";
  const SCOPE = "scope-a";
  const OLD_SOCKET = "socket-1";
  const NEW_SOCKET = "socket-2";

  let timer: FakeTimer;
  let proxy: DaemonMcpProxy | undefined;
  let available: ReturnType<typeof spyOn> | undefined;
  let sessionManager: SessionManager;
  let scopes: ManagedConnectionScopes;
  let state: DaemonStateAccess;
  let reconnectFixturePending = false;

  async function initializeSessions() {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    scopes = new ManagedConnectionScopes();
    state = {
      getManagedExecutionReowner: () => ({ reown: async () => [] }),
      isInitialized: () => true,
      getManagedConnectionScopes: () => scopes,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    await sessionManager.createSession(SLOT_SESSION, "emulator-5554", "android");
    await sessionManager.claimLivenessOwnership(SLOT_SESSION, TOKEN);
    await sessionManager.adoptManagedExecutionLivenessPolicy(SLOT_SESSION, {});
    // What the acquisition bound for the proxy's first socket.
    scopes.bind(OLD_SOCKET, { scopeKey: SCOPE, sessionUuids: [SLOT_SESSION] });
  }

  beforeEach(async () => {
    if (!reconnectFixturePending) {
      await initializeSessions();
    }
  });

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    available?.mockRestore();
    available = undefined;
    sessionManager.stopCleanupTimer();
  });

  const acquisitionRefusal = (socketSessionId: string, toolName: string) =>
    managedConnectionPlainToolRefusal({
      binding: scopes.get(socketSessionId),
      toolName,
      args: {},
      slotDeviceOf: (sessionUuid) => sessionManager.getSession(sessionUuid)?.assignedDevice,
    });

  describe("tokenless reconnect", () => {
    const clients: FakeDaemonClient[] = [];
    const registrations: string[] = [];
    let allowClaim = true;
    let claimGate = Promise.withResolvers<void>();
    beforeAll(async () => {
      await initializeSessions();
      clients.length = 0;
      registrations.length = 0;
      allowClaim = true;
      claimGate = Promise.withResolvers<void>();
      available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const manager = new FakeDaemonManager();
      manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
      proxy = new DaemonMcpProxy({
        timer,
        livenessOwnerToken: TOKEN,
        daemonManager: manager,
        autoStartDaemon: false,
        heartbeatIntervalMs: 2_000,
        clientFactory: () => {
          const socketSessionId = `proxy-socket-${clients.length}`;
          const client = new FakeDaemonClient({
            daemonMethodResults: new Map<string, unknown>([
              ["tools/list", { tools: [] }],
              ["daemon/capabilities", { capabilities: ["managed-slots/v1"] }],
              [DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD, readyManagedSlotsResult(SLOT_SESSION)],
            ]),
            onCallDaemonMethod: async (method, params) => {
              if (method !== DAEMON_HEARTBEAT_METHOD && method !== DAEMON_REGISTER_SESSION_METHOD) {
                return undefined;
              }
              if (method === DAEMON_HEARTBEAT_METHOD && !allowClaim) {
                // The reconnect starts its coalesced keeper without waiting for this claim.
                await claimGate.promise;
              }
              if (method === DAEMON_REGISTER_SESSION_METHOD) {
                registrations.push(socketSessionId);
              }
              const response = await handleDaemonRequest(
                { id: "proxy", type: "daemon_request", method, params },
                state,
                undefined,
                undefined,
                { socketSessionId },
              );
              if (!response.success) {
                throw daemonResponseError({ id: "proxy", type: "daemon_response", ...response });
              }
              return response.result;
            },
          });
          clients.push(client);
          return client;
        },
      });
      await proxy.acquireManagedSlots({
        contractVersion: 1,
        managedHostScope: "host",
        runnerNamespace: "runner",
        runnerIncarnation: "boot",
        localSlotCapacity: 1,
        requests: [{ slotIndex: 1, role: "primary", platform: "android", requestedSpec: {} }],
      });
      reconnectFixturePending = true;
    });
    beforeEach(() => {
      if (!reconnectFixturePending) {
        throw new Error(
          "Reconnect fixture already consumed; another test needs its own proxy fixture",
        );
      }
      reconnectFixturePending = false;
    });
    test("a tokenless reconnect is claimed by the keeper and binds without another connection", async () => {
      // A successor can rehydrate a managed row without a persisted owner token.
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
      await sessionManager.createSession(SLOT_SESSION, "emulator-5554", "android");
      await sessionManager.adoptManagedExecutionLivenessPolicy(SLOT_SESSION, {});
      allowClaim = false;
      clients[0]!.emitConnectionClosed();
      await proxy!.ensureConnected();
      expect(sessionManager.getSession(SLOT_SESSION)?.livenessOwnerToken).toBeUndefined();
      expect(scopes.get("proxy-socket-1")?.sessionUuids.size).toBe(0);
      // Step one retry rather than replaying every backoff round trip through 500 ms.
      timer.advanceTime(500);
      await drainMicrotasks(40);
      expect(scopes.get("proxy-socket-1")?.sessionUuids.size).toBe(0);
      allowClaim = true;
      claimGate.resolve();
      await drainUntil(
        () => sessionManager.getSession(SLOT_SESSION)?.livenessOwnerToken === TOKEN,
        { description: "keeper claims tokenless session" },
      );
      timer.advanceTime(500);
      await drainUntil(
        () => scopes.get("proxy-socket-1")?.sessionUuids.has(SLOT_SESSION) === true,
        {
          description: "retry binds the keeper's claimed session",
        },
      );
      expect(sessionManager.getSession(SLOT_SESSION)?.livenessOwnerToken).toBe(TOKEN);
      expect([...scopes.get("proxy-socket-1")!.sessionUuids]).toEqual([SLOT_SESSION]);
      expect(clients).toHaveLength(2);
      expect(registrations.length).toBeGreaterThan(1);
      expect(new Set(registrations)).toEqual(new Set(["proxy-socket-1"]));
    });
  });

  test("the owner releases its live execution after a refused rebind, while other methods stay confined", async () => {
    const drained: string[] = [];
    state.getManagedExecutionRelease = () => ({
      releaseExecution: async (sessionId) => {
        drained.push(sessionId);
        return {
          sessionId,
          outcome: "reusable_for_this_slot",
          settlement: "confirmed",
          alreadyReleased: false,
          cancellationRequested: 0,
          releaseForced: false,
          device: null,
          slots: [],
          slotFailures: [],
        };
      },
    });
    scopes.unbind(OLD_SOCKET);
    const rebind = await handleDaemonRequest(
      {
        id: "rebind",
        type: "daemon_request",
        method: DAEMON_REGISTER_SESSION_METHOD,
        params: {
          sessionId: SLOT_SESSION,
          clientName: "managed-proxy",
          managedSlots: {
            scopeKey: SCOPE,
            sessionUuids: [SLOT_SESSION, "00000000-0000-4000-8000-000000000002"],
            livenessOwnerToken: TOKEN,
          },
        },
      },
      state,
      undefined,
      undefined,
      { socketSessionId: NEW_SOCKET },
    );
    expect(rebind).toMatchObject({ success: false, code: "managed_slot_registration_refused" });
    expect(scopes.get(NEW_SOCKET)?.sessionUuids.size).toBe(0);
    for (const tool of ["getAndroid", "getApple", "startDevice", "provisionDevice"]) {
      expect(acquisitionRefusal(NEW_SOCKET, tool)).toBeInstanceOf(DeviceOutsideManagedSlotsError);
    }
    const sessionRelease = await handleDaemonRequest(
      {
        id: "session",
        type: "daemon_request",
        method: "daemon/releaseSession",
        params: { sessionId: SLOT_SESSION },
      },
      state,
      undefined,
      undefined,
      { socketSessionId: NEW_SOCKET },
    );
    expect(sessionRelease).toMatchObject({ success: false, code: "device_outside_managed_slots" });
    const executionRelease = await handleDaemonRequest(
      {
        id: "execution",
        type: "daemon_request",
        method: "daemon/releaseExecution",
        params: { sessionId: SLOT_SESSION, livenessOwnerToken: TOKEN },
      },
      state,
      undefined,
      undefined,
      { socketSessionId: NEW_SOCKET },
    );
    expect(executionRelease).toMatchObject({ success: true });
    expect(drained).toEqual([SLOT_SESSION]);
  });

  test("the reconnected socket stays confined: device-acquiring tools are still refused", async () => {
    // The execution's session ends (idle release, heartbeat loss); the proxy keeps running.
    await sessionManager.releaseSession(SLOT_SESSION);
    expect(acquisitionRefusal(OLD_SOCKET, "getAndroid")).toBeInstanceOf(
      DeviceOutsideManagedSlotsError,
    );

    // The socket drops and reconnects: the daemon unbinds the old socket (socketServer
    // releaseSocketSession) and the proxy re-binds the new one with the sessions it held.
    scopes.unbind(OLD_SOCKET);
    const rebind = await handleDaemonRequest(
      {
        id: "r",
        type: "daemon_request",
        method: DAEMON_REGISTER_SESSION_METHOD,
        params: {
          sessionId: SLOT_SESSION,
          clientName: "managed-proxy",
          managedSlots: {
            scopeKey: SCOPE,
            sessionUuids: [SLOT_SESSION],
            livenessOwnerToken: TOKEN,
          },
        },
      },
      state,
      undefined,
      undefined,
      { socketSessionId: NEW_SOCKET },
    );
    expect(rebind).toMatchObject({ success: false, code: "managed_slot_registration_refused" });

    // A connection that declared itself managed must not fall back to generic acquisition.
    for (const tool of ["getAndroid", "getApple", "startDevice", "provisionDevice"]) {
      expect(acquisitionRefusal(NEW_SOCKET, tool)).toBeInstanceOf(DeviceOutsideManagedSlotsError);
    }
  });
});
