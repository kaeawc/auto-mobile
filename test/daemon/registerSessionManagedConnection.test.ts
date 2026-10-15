import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DAEMON_REGISTER_SESSION_METHOD } from "../../src/daemon/constants";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { BrokerConnectionScopes } from "../../src/daemon/sessionBroker/connectionScope";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #11178: `daemon/registerSession` enforces the managed connection. A bound socket registers only
// its own slot sessions, and a reconnected managed proxy re-binds its new socket only to sessions
// it proves it holds (managed-execution policy, claimed for its owner token).

const SLOT_SESSION = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION = "00000000-0000-4000-8000-000000000002";
const PLAIN_SESSION = "00000000-0000-4000-8000-000000000003";
const TOKEN = "managed-proxy-token";
const SCOPE = "scope-a";

describe("daemon/registerSession on managed connections", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let scopes: BrokerConnectionScopes;
  let state: DaemonStateAccess;
  let reowned: string[][];
  let persistence: FakeDeviceSessionPersistence;

  async function managedSession(sessionId: string, deviceId: string, token: string) {
    await sessionManager.createSession(sessionId, deviceId, "android");
    await sessionManager.claimLivenessOwnership(sessionId, token);
    await sessionManager.adoptManagedExecutionLivenessPolicy(sessionId, {});
  }

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    persistence = new FakeDeviceSessionPersistence();
    sessionManager = new SessionManager(timer, persistence);
    scopes = new BrokerConnectionScopes();
    reowned = [];
    state = {
      getBrokerExecutionReowner: () => ({
        reown: async (sessionUuids) => {
          reowned.push([...sessionUuids]);
          return [];
        },
      }),
      isInitialized: () => true,
      getBrokerConnectionScopes: () => scopes,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    await managedSession(SLOT_SESSION, "emulator-5554", TOKEN);
    await managedSession(OTHER_SESSION, "emulator-5556", "another-proxy-token");
    await sessionManager.createSession(PLAIN_SESSION, "emulator-5558", "android");
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  function register(params: Record<string, unknown>, socketSessionId: string | undefined) {
    return handleDaemonRequest(
      { id: "r", type: "daemon_request", method: DAEMON_REGISTER_SESSION_METHOD, params },
      state,
      undefined,
      undefined,
      { socketSessionId },
    );
  }

  test("a bound connection registers its own binding session but no other session", async () => {
    scopes.bind("socket-1", { scopeKey: SCOPE, sessionUuids: [SLOT_SESSION] });

    const own = await register({ sessionId: SLOT_SESSION, clientName: "c" }, "socket-1");
    const other = await register({ sessionId: OTHER_SESSION, clientName: "c" }, "socket-1");

    expect(own).toMatchObject({ success: true, result: { accepted: true } });
    expect(other).toMatchObject({
      success: false,
      code: "device_outside_broker_grant",
      retryable: false,
    });
  });

  test("a generic connection is not confined", async () => {
    const response = await register({ sessionId: OTHER_SESSION, clientName: "c" }, "socket-1");

    expect(response).toMatchObject({ success: true });
    expect(scopes.get("socket-1")).toBeUndefined();
  });
});
