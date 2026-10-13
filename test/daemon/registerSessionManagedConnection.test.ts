import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DAEMON_REGISTER_SESSION_METHOD } from "../../src/daemon/constants";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  managedConnectionControlRefusal,
  ManagedConnectionScopes,
} from "../../src/daemon/managedSlots/managedConnectionScope";
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
  let scopes: ManagedConnectionScopes;
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
    scopes = new ManagedConnectionScopes();
    reowned = [];
    state = {
      getManagedExecutionReowner: () => ({
        reown: async (sessionUuids) => {
          reowned.push([...sessionUuids]);
          return [];
        },
      }),
      isInitialized: () => true,
      getManagedConnectionScopes: () => scopes,
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

  function rebind(sessionUuids: string[], token = TOKEN) {
    return {
      sessionId: sessionUuids[0],
      clientName: "managed-proxy",
      managedSlots: { scopeKey: SCOPE, sessionUuids, livenessOwnerToken: token },
    };
  }

  test("a bound connection registers its own slot session but no other session", async () => {
    scopes.bind("socket-1", { scopeKey: SCOPE, sessionUuids: [SLOT_SESSION] });

    const own = await register({ sessionId: SLOT_SESSION, clientName: "c" }, "socket-1");
    const other = await register({ sessionId: OTHER_SESSION, clientName: "c" }, "socket-1");

    expect(own).toMatchObject({ success: true, result: { accepted: true } });
    expect(other).toMatchObject({
      success: false,
      code: "device_outside_managed_slots",
      retryable: false,
    });
  });

  test("a generic connection is not confined", async () => {
    const response = await register({ sessionId: OTHER_SESSION, clientName: "c" }, "socket-1");

    expect(response).toMatchObject({ success: true });
    expect(scopes.get("socket-1")).toBeUndefined();
  });

  test("a reconnected managed proxy re-binds its socket to the slot sessions its token holds", async () => {
    const response = await register(rebind([SLOT_SESSION]), "socket-2");

    expect(response).toMatchObject({ success: true });
    expect(scopes.get("socket-2")?.scopeKey).toBe(SCOPE);
    expect([...scopes.get("socket-2")!.sessionUuids]).toEqual([SLOT_SESSION]);
    // After a daemon restart the slot still names the previous daemon: re-own it (#11275).
    expect(reowned).toEqual([[SLOT_SESSION]]);
  });

  test("a re-bind naming another execution's session, or a non-managed one, binds nothing", async () => {
    const foreign = await register(rebind([SLOT_SESSION, OTHER_SESSION]), "socket-2");
    const plain = await register(rebind([PLAIN_SESSION]), "socket-3");
    const wrongToken = await register(rebind([SLOT_SESSION], "guessed-token"), "socket-4");

    for (const response of [foreign, plain, wrongToken]) {
      expect(response).toMatchObject({
        success: false,
        code: "managed_slot_registration_refused",
        retryable: false,
      });
    }
    // A refused re-bind binds fail-closed with zero sessions (#11399), never a generic socket.
    for (const socket of ["socket-2", "socket-3", "socket-4"]) {
      expect(scopes.get(socket)?.scopeKey).toBe(SCOPE);
      expect(scopes.get(socket)?.sessionUuids.size).toBe(0);
    }
    expect(reowned).toEqual([]);
  });

  test("a re-bind must register one of its slot sessions, from a known socket, in its own scope", async () => {
    const outside = await register(
      { ...rebind([SLOT_SESSION]), sessionId: OTHER_SESSION },
      "socket-2",
    );
    const noSocket = await register(rebind([SLOT_SESSION]), undefined);
    scopes.bind("socket-3", { scopeKey: "scope-b", sessionUuids: [SLOT_SESSION] });
    const otherScope = await register(rebind([SLOT_SESSION]), "socket-3");

    for (const response of [outside, noSocket, otherScope]) {
      expect(response).toMatchObject({
        success: false,
        code: "managed_slot_registration_refused",
        retryable: false,
      });
    }
    expect(scopes.get("socket-3")?.scopeKey).toBe("scope-b");
  });
  test("an unknown session retries on the same fail-closed socket after it appears", async () => {
    const late = "00000000-0000-4000-8000-000000000004";
    const refused = await register(rebind([late]), "late-socket");
    expect(refused).toMatchObject({
      success: false,
      code: "managed_slot_registration_refused",
      retryable: true,
      retryAfterMs: 500,
    });
    expect(scopes.get("late-socket")?.sessionUuids.size).toBe(0);
    const control = () =>
      managedConnectionControlRefusal({
        binding: scopes.get("late-socket"),
        action: "tapOn",
        deviceId: "emulator-5560",
        requesterSessionUuid: late,
        slotDeviceOf: (uuid) => sessionManager.getSession(uuid)?.assignedDevice,
      });
    expect(control()?.code).toBe("device_outside_managed_slots");
    await managedSession(late, "emulator-5560", TOKEN);
    expect(await register(rebind([late]), "late-socket")).toMatchObject({ success: true });
    expect([...scopes.get("late-socket")!.sessionUuids]).toEqual([late]);
    expect(control()).toBeUndefined();
  });

  test("a present tokenless managed session retries confined until the claim supplies its token", async () => {
    const late = "00000000-0000-4000-8000-000000000004";
    await sessionManager.createSession(late, "emulator-5560", "android");
    await sessionManager.adoptManagedExecutionLivenessPolicy(late, {});
    expect(sessionManager.getSession(late)?.livenessOwnerToken).toBeUndefined();
    expect(await register(rebind([late]), "tokenless")).toMatchObject({
      success: false,
      code: "managed_slot_registration_refused",
      retryable: true,
      retryAfterMs: 500,
    });
    expect(scopes.get("tokenless")?.sessionUuids.size).toBe(0);
    expect(reowned).toEqual([]);
    await sessionManager.claimLivenessOwnership(late, TOKEN);
    expect(await register(rebind([late]), "tokenless")).toMatchObject({ success: true });
    expect([...scopes.get("tokenless")!.sessionUuids]).toEqual([late]);
  });

  test("a placeholder cannot register without managedSlots or change its scope", async () => {
    scopes.bind("placeholder", { scopeKey: SCOPE, sessionUuids: [] });
    expect(
      await register({ sessionId: SLOT_SESSION, clientName: "plain" }, "placeholder"),
    ).toMatchObject({ success: false, code: "device_outside_managed_slots" });
    expect(
      await register(
        {
          ...rebind([SLOT_SESSION]),
          managedSlots: {
            scopeKey: "other-scope",
            sessionUuids: [SLOT_SESSION],
            livenessOwnerToken: TOKEN,
          },
        },
        "placeholder",
      ),
    ).toMatchObject({ success: false });
    expect(scopes.get("placeholder")?.scopeKey).toBe(SCOPE);
    expect(scopes.get("placeholder")?.sessionUuids.size).toBe(0);
  });

  test("a non-empty binding refuses a presented session held by another token unchanged", async () => {
    scopes.bind("bound", { scopeKey: SCOPE, sessionUuids: [SLOT_SESSION] });
    expect([...scopes.get("bound")!.sessionUuids]).toEqual([SLOT_SESSION]);
    // sessionId is already bound: every presented session must still prove this token's ownership.
    expect(await register(rebind([SLOT_SESSION, OTHER_SESSION]), "bound")).toMatchObject({
      success: false,
      code: "managed_slot_registration_refused",
      retryable: false,
    });
    expect([...scopes.get("bound")!.sessionUuids]).toEqual([SLOT_SESSION]);
    expect(reowned).toEqual([]);
  });

  test("a non-empty binding still replaces its set with all sessions the token holds", async () => {
    const extra = "00000000-0000-4000-8000-000000000004";
    await managedSession(extra, "emulator-5560", TOKEN);
    scopes.bind("bound", { scopeKey: SCOPE, sessionUuids: [SLOT_SESSION] });
    expect(await register(rebind([SLOT_SESSION, extra]), "bound")).toMatchObject({ success: true });
    expect([...scopes.get("bound")!.sessionUuids]).toEqual([SLOT_SESSION, extra]);
    expect(await register(rebind([extra]), "bound")).toMatchObject({ success: true });
    expect([...scopes.get("bound")!.sessionUuids]).toEqual([extra]);
  });

  test("a same-scope placeholder upgrades after all ownership proofs pass", async () => {
    scopes.bind("placeholder", { scopeKey: SCOPE, sessionUuids: [] });
    expect(await register(rebind([SLOT_SESSION]), "placeholder")).toMatchObject({ success: true });
    expect([...scopes.get("placeholder")!.sessionUuids]).toEqual([SLOT_SESSION]);
    expect(reowned).toEqual([[SLOT_SESSION]]);
  });

  test("terminally released or present foreign sessions are not retryable", async () => {
    await sessionManager.releaseSession(SLOT_SESSION, "cli-idle-timeout");
    for (const uuid of [SLOT_SESSION, OTHER_SESSION, PLAIN_SESSION]) {
      expect(await register(rebind([uuid]), `socket-${uuid}`)).toMatchObject({
        success: false,
        code: "managed_slot_registration_refused",
        retryable: false,
      });
    }
  });

  test.each(["cli-idle-timeout", "explicit-release"])(
    "a persisted terminal %s release without in-memory state stops re-binding",
    async (reason) => {
      await sessionManager.releaseSession(SLOT_SESSION, reason);
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(timer, persistence);
      expect(sessionManager.getSession(SLOT_SESSION)).toBeNull();
      expect(sessionManager.getTerminalReleaseSnapshot(SLOT_SESSION)).toBeUndefined();
      const response = await register(rebind([SLOT_SESSION]), "replacement");
      expect(response).toMatchObject({
        success: false,
        code: "managed_slot_registration_refused",
        retryable: false,
      });
      expect(response.retryAfterMs).toBeUndefined();
      expect(scopes.get("replacement")?.sessionUuids.size).toBe(0);
    },
  );

  const UNKNOWN_SESSION = "00000000-0000-4000-8000-000000000004";
  test.each(["unknown-first", "foreign-first"])(
    "%s mixed ownership proof refuses permanently",
    async (order) => {
      const ids = [UNKNOWN_SESSION, OTHER_SESSION];
      if (order === "foreign-first") {
        ids.reverse();
      }
      const response = await register(rebind(ids), "mixed");
      expect(response).toMatchObject({ success: false, retryable: false });
      expect(response.retryAfterMs).toBeUndefined();
      expect(scopes.get("mixed")?.sessionUuids.size).toBe(0);
    },
  );

  test("all unknown ownership proofs remain retryable", async () => {
    const second = "00000000-0000-4000-8000-000000000005";
    expect(await register(rebind([UNKNOWN_SESSION, second]), "unknowns")).toMatchObject({
      success: false,
      retryable: true,
      retryAfterMs: 500,
    });
  });

  test.each(["unknown-first", "released-first"])(
    "%s mixed proof cannot hide a persisted terminal release",
    async (order) => {
      await sessionManager.releaseSession(SLOT_SESSION, "cli-idle-timeout");
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(timer, persistence);
      const ids = [UNKNOWN_SESSION, SLOT_SESSION];
      if (order === "released-first") {
        ids.reverse();
      }
      const response = await register(rebind(ids), "mixed-restart");
      expect(response).toMatchObject({ success: false, retryable: false });
      expect(response.retryAfterMs).toBeUndefined();
    },
  );

  test("an unavailable persisted release lookup keeps an unknown proof retryable", async () => {
    sessionManager.getReleasedSessionReason = async () => {
      throw new Error("persistence unavailable");
    };
    expect(await register(rebind([UNKNOWN_SESSION]), "unavailable")).toMatchObject({
      success: false,
      retryable: true,
      retryAfterMs: 500,
    });
  });
});
