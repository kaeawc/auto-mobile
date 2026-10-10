import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DAEMON_REGISTER_SESSION_METHOD } from "../../../src/daemon/constants";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import {
  ManagedConnectionScopes,
  managedConnectionPlainToolRefusal,
} from "../../../src/daemon/managedSlots/managedConnectionScope";
import { DeviceOutsideManagedSlotsError } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Hunt (managed slots, 2026-10-10): a managed connection's slot set is fixed for its lifetime, and
 * it may never acquire, start or provision devices (`device_outside_managed_slots`, reason `tool`).
 * The confinement lives in the daemon's per-socket binding, which ends with the socket. When the
 * managed proxy's socket reconnects after its slot session ended (idle release is terminal; the
 * proxy keeps serving MCP), its `daemon/registerSession` re-bind is refused and binds nothing, so
 * the new socket is a generic connection: `getAndroid`, `startDevice` and `provisionDevice` pass
 * the managed-connection gate.
 */
describe("hunt: managed proxy re-bind after its slot session ended", () => {
  const SLOT_SESSION = "00000000-0000-4000-8000-000000000001";
  const TOKEN = "managed-proxy-token";
  const SCOPE = "scope-a";
  const OLD_SOCKET = "socket-1";
  const NEW_SOCKET = "socket-2";

  let sessionManager: SessionManager;
  let scopes: ManagedConnectionScopes;
  let state: DaemonStateAccess;

  beforeEach(async () => {
    const timer = new FakeTimer();
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
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  const acquisitionRefusal = (socketSessionId: string, toolName: string) =>
    managedConnectionPlainToolRefusal({
      binding: scopes.get(socketSessionId),
      toolName,
      args: {},
      slotDeviceOf: (sessionUuid) => sessionManager.getSession(sessionUuid)?.assignedDevice,
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
