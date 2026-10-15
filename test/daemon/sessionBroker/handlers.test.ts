import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  openSqliteSlotRegistry,
  type SqliteSlotRegistry,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import type { SlotProcessIdentity } from "../../../src/daemon/managedSlots/slotRegistry";
import type {
  DaemonMethodResult,
  DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { ManagedConnectionScopes } from "../../../src/daemon/managedSlots/managedConnectionScope";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import {
  bindBrokerRegistration,
  handleAbandonBrokerSessionRequest,
  handleBrokerSessionStatus,
  handlePrepareBrokerSession,
  handleReleaseBrokerSession,
} from "../../../src/daemon/sessionBroker/handlers";
import { SessionBrokerService } from "../../../src/daemon/sessionBroker/service";
import type { SqliteSessionBrokerStore } from "../../../src/daemon/sessionBroker/sqliteStore";
import type { BrokerRequestRecord } from "../../../src/daemon/sessionBroker/store";
import { ActionableError } from "../../../src/models/ActionableError";
import type { SessionBrokerResult } from "../../../src/models/sessionBrokerResult";
import type { SessionConfig } from "../../../src/models/sessionConfig";
import type { DaemonRequest } from "../../../src/daemon/types";
import { FakeTimer } from "../../fakes/FakeTimer";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";

const OWNER: SlotProcessIdentity = {
  daemonId: "broker-daemon",
  pid: 101,
  processGenerationToken: "process-a",
};
const SCOPE = "private-broker-scope";
const TOKEN = "liveness-owner";
const SESSION = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION = "00000000-0000-4000-8000-000000000002";

const unusedNativeCall = async (): Promise<never> => {
  throw new Error("native work must not run in handler tests");
};

function sessionConfig(requestId = "request-1"): SessionConfig {
  return {
    contractVersion: 1,
    requestId,
    device: {
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "omitted" },
      os: { kind: "omitted" },
    },
  };
}

function result(
  requestId: string,
  outcome: SessionBrokerResult["outcome"],
  sessionUuid: string | null = null,
): SessionBrokerResult {
  return {
    contractVersion: 1,
    requestId,
    outcome,
    sessionUuid,
    profile: null,
    cleanupPending: false,
  };
}

function request(params: unknown): DaemonRequest {
  return {
    id: "daemon-request",
    type: "daemon_request",
    method: "unused",
    params,
  };
}

class HandlerBroker extends SessionBroker {
  prepareResult = result("request-1", "failed");
  ownedStatusError: Error | undefined;
  readonly statuses = new Map<string, SessionBrokerResult>();
  readonly sessionOwners = new Map<string, string>();
  readonly prepareCalls: Array<{
    config: SessionConfig;
    token: string;
    signal?: AbortSignal;
  }> = [];
  readonly statusCalls: Array<{ requestId: string; token: string }> = [];
  readonly abandonCalls: Array<{ requestId: string; token: string }> = [];
  readonly sessionCalls: Array<{ sessionId: string; token: string }> = [];
  readonly releaseCalls: string[] = [];

  constructor(store: SqliteSessionBrokerStore) {
    super({
      store,
      devices: {
        prepare: unusedNativeCall,
        release: unusedNativeCall,
        destroy: unusedNativeCall,
      },
      owner: OWNER,
      limits: {},
      catalog: async () => iosCatalog(),
      defaults: () => iosDefaults(),
    });
  }

  override prepare(
    config: SessionConfig,
    token: string,
    signal?: AbortSignal,
  ): Promise<SessionBrokerResult> {
    this.prepareCalls.push({ config, token, signal });
    return Promise.resolve(this.prepareResult);
  }

  override async ownedStatus(
    requestId: string,
    token: string,
  ): Promise<SessionBrokerResult | undefined> {
    this.statusCalls.push({ requestId, token });
    if (this.ownedStatusError) {
      throw this.ownedStatusError;
    }
    return this.statuses.get(`${requestId}:${token}`);
  }

  override async ownedSessionRequest(
    sessionId: string,
    token: string,
  ): Promise<BrokerRequestRecord | undefined> {
    this.sessionCalls.push({ sessionId, token });
    const owner = this.sessionOwners.get(sessionId);
    if (!owner) {
      return undefined;
    }
    if (owner !== token) {
      throw new ActionableError("Session request belongs to another liveness owner");
    }
    return {
      requestId: "request-1",
      fingerprint: "owned",
      parameters: sessionConfig(),
      owner: OWNER,
      state: "active",
      resourceId: "resource-1",
      sessionId,
      error: null,
      errorCode: null,
      retryable: false,
    };
  }

  override async abandon(requestId: string, token: string): Promise<SessionBrokerResult> {
    this.abandonCalls.push({ requestId, token });
    return result(requestId, "failed");
  }

  override async release(sessionId: string) {
    this.releaseCalls.push(sessionId);
    return { sessionUuid: sessionId, outcome: "cleanup_pending" as const };
  }
}

describe("session broker daemon handlers", () => {
  let registry: SqliteSlotRegistry;
  let broker: HandlerBroker;
  let scopes: ManagedConnectionScopes;
  let tokens: Map<string, string>;
  let state: DaemonStateAccess;

  beforeEach(async () => {
    registry = await openSqliteSlotRegistry({
      dbPath: ":memory:",
      isExecOwnerLive: () => true,
    });
    broker = new HandlerBroker(registry.sessionBrokerStore(SCOPE));
    scopes = new ManagedConnectionScopes();
    tokens = new Map();
    const service = new SessionBrokerService(
      broker,
      SCOPE,
      { acquire: () => {}, release: () => {} },
      new FakeTimer(),
    );
    state = {
      isInitialized: () => true,
      getSessionBrokerService: () => service,
      getManagedConnectionScopes: () => scopes,
      getSessionManager: () => ({
        hasSession: () => false,
        getSession: () => null,
        getSessionLivenessOwnerToken: (sessionId) => tokens.get(sessionId),
        getDeviceLabels: () => undefined,
        releaseSession: async () => null,
      }),
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
        releaseDevice: async () => {},
        isPooledIdentityUnresolved: () => false,
      }),
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    };
  });

  afterEach(async () => {
    await registry.close();
  });

  test("prepare and request status preserve the same typed transient failure", async () => {
    const receipt = {
      ...result("request-1", "failed"),
      failure: { code: "timeout", message: "runner-setup timed out", retryable: true },
    };
    broker.prepareResult = receipt;
    broker.statuses.set(`request-1:${TOKEN}`, receipt);
    expect(
      await handlePrepareBrokerSession(
        request({ config: sessionConfig(), livenessOwnerToken: TOKEN }),
        state,
      ),
    ).toEqual({ success: true, result: receipt });
    expect(
      await handleBrokerSessionStatus(
        request({ requestId: "request-1", livenessOwnerToken: TOKEN }),
        state,
      ),
    ).toEqual({ success: true, result: receipt });
  });

  test("malformed prepare and status requests replace any previous binding", async () => {
    scopes.bind("malformed-prepare", {
      scopeKey: "stale-scope",
      sessionUuids: [SESSION],
    });
    const malformed = await handlePrepareBrokerSession(
      request({ config: sessionConfig(), livenessOwnerToken: "" }),
      state,
      undefined,
      "malformed-prepare",
    );
    expect(malformed).toMatchObject({
      success: false,
      code: "session_config_invalid",
    });
    expect(scopes.get("malformed-prepare")).toEqual({
      scopeKey: SCOPE,
      sessionUuids: new Set(),
    });

    scopes.bind("config-socket", {
      scopeKey: "stale-scope",
      sessionUuids: [SESSION],
    });
    const invalidConfig = await handlePrepareBrokerSession(
      request({ config: {}, livenessOwnerToken: TOKEN }),
      state,
      undefined,
      "config-socket",
    );
    expect(invalidConfig).toMatchObject({
      success: false,
      code: "session_config_invalid",
    });
    expect(scopes.get("config-socket")).toEqual({
      scopeKey: SCOPE,
      sessionUuids: new Set(),
    });
    expect(broker.prepareCalls).toEqual([]);

    scopes.bind("malformed-status", {
      scopeKey: "stale-scope",
      sessionUuids: [SESSION],
    });
    const invalidStatus = await handleBrokerSessionStatus(
      request({ requestId: "", livenessOwnerToken: TOKEN }),
      state,
      "malformed-status",
    );
    expect(invalidStatus).toEqual({
      success: false,
      error: "requestId and livenessOwnerToken are required",
    });
    expect(scopes.get("malformed-status")).toEqual({
      scopeKey: SCOPE,
      sessionUuids: new Set(),
    });
    expect(broker.statusCalls).toEqual([]);
  });

  test("prepare forwards ownership and binds only the returned ready session", async () => {
    broker.prepareResult = result("request-1", "ready", SESSION);
    const controller = new AbortController();

    const response = await handlePrepareBrokerSession(
      request({ config: sessionConfig(), livenessOwnerToken: TOKEN }),
      state,
      controller.signal,
      "prepare-socket",
    );

    expect(response).toEqual({
      success: true,
      result: result("request-1", "ready", SESSION),
    });
    expect(broker.prepareCalls).toEqual([
      { config: sessionConfig(), token: TOKEN, signal: controller.signal },
    ]);
    expect(scopes.get("prepare-socket")?.scopeKey).toBe(SCOPE);
    expect([...scopes.get("prepare-socket")!.sessionUuids]).toEqual([SESSION]);
  });

  test("an aborted prepare cannot grant a ready session to its socket", async () => {
    broker.prepareResult = result("request-1", "ready", SESSION);
    const controller = new AbortController();
    controller.abort();

    const response = await handlePrepareBrokerSession(
      request({ config: sessionConfig(), livenessOwnerToken: TOKEN }),
      state,
      controller.signal,
      "aborted-socket",
    );

    expect(response).toMatchObject({
      success: true,
      result: { outcome: "ready", sessionUuid: SESSION },
    });
    expect(scopes.get("aborted-socket")).toEqual({
      scopeKey: SCOPE,
      sessionUuids: new Set(),
    });
  });

  test("status recovers a lost prepare reply and clears a stale binding on a miss", async () => {
    broker.statuses.set(`request-lost:${TOKEN}`, result("request-lost", "ready", SESSION));

    const recovered = await handleBrokerSessionStatus(
      request({ requestId: "request-lost", livenessOwnerToken: TOKEN }),
      state,
      "status-socket",
    );
    expect(recovered).toMatchObject({
      success: true,
      result: { outcome: "ready", sessionUuid: SESSION },
    });
    expect([...scopes.get("status-socket")!.sessionUuids]).toEqual([SESSION]);

    const missing = await handleBrokerSessionStatus(
      request({ requestId: "missing", livenessOwnerToken: TOKEN }),
      state,
      "status-socket",
    );
    expect(missing).toEqual({
      success: false,
      code: "session_request_not_found",
      error: "No committed session request has that identity",
    });
    expect(scopes.get("status-socket")?.sessionUuids.size).toBe(0);
    expect(broker.statusCalls).toEqual([
      { requestId: "request-lost", token: TOKEN },
      { requestId: "missing", token: TOKEN },
    ]);
  });

  test("status stays fail-closed when ownership validation throws", async () => {
    broker.ownedStatusError = new ActionableError(
      "Session request belongs to another liveness owner",
    );
    scopes.bind("wrong-owner-status", {
      scopeKey: "stale-scope",
      sessionUuids: [SESSION],
    });

    await expect(
      handleBrokerSessionStatus(
        request({ requestId: "request-1", livenessOwnerToken: "wrong-owner" }),
        state,
        "wrong-owner-status",
      ),
    ).rejects.toThrow("another liveness owner");

    expect(scopes.get("wrong-owner-status")).toEqual({
      scopeKey: SCOPE,
      sessionUuids: new Set(),
    });
    expect(broker.statusCalls).toEqual([{ requestId: "request-1", token: "wrong-owner" }]);
  });

  test("abandon validates and forwards the original request identity and owner", async () => {
    expect(
      await handleAbandonBrokerSessionRequest(
        request({ requestId: "request-1", livenessOwnerToken: TOKEN }),
        state,
      ),
    ).toEqual({
      success: true,
      result: result("request-1", "failed"),
    });
    expect(broker.abandonCalls).toEqual([{ requestId: "request-1", token: TOKEN }]);

    expect(
      await handleAbandonBrokerSessionRequest(
        request({ requestId: "", livenessOwnerToken: TOKEN }),
        state,
      ),
    ).toEqual({
      success: false,
      error: "requestId and livenessOwnerToken are required",
    });
    expect(broker.abandonCalls).toHaveLength(1);
  });

  test("release requires a token-owned receipt and never releases an unknown session", async () => {
    const unknown = await handleReleaseBrokerSession(
      request({ sessionId: OTHER_SESSION, livenessOwnerToken: TOKEN }),
      state,
    );
    expect(unknown).toEqual({
      success: true,
      result: { sessionUuid: OTHER_SESSION, outcome: "unknown_session" },
    });
    expect(broker.releaseCalls).toEqual([]);

    broker.sessionOwners.set(SESSION, TOKEN);
    await expect(
      handleReleaseBrokerSession(
        request({ sessionId: SESSION, livenessOwnerToken: "wrong-owner" }),
        state,
      ),
    ).rejects.toThrow("another liveness owner");
    expect(broker.releaseCalls).toEqual([]);

    const owned = await handleReleaseBrokerSession(
      request({ sessionId: SESSION, livenessOwnerToken: TOKEN }),
      state,
    );
    expect(owned).toEqual({
      success: true,
      result: { sessionUuid: SESSION, outcome: "cleanup_pending" },
    });
    expect(broker.releaseCalls).toEqual([SESSION]);
    expect(broker.sessionCalls).toEqual([
      { sessionId: OTHER_SESSION, token: TOKEN },
      { sessionId: SESSION, token: "wrong-owner" },
      { sessionId: SESSION, token: TOKEN },
    ]);
  });

  test("registration binds only when receipt, session, and live owner token agree", async () => {
    broker.statuses.set(`request-1:${TOKEN}`, result("request-1", "ready", SESSION));
    tokens.set(SESSION, TOKEN);

    expect(
      await bindBrokerRegistration(
        state,
        SESSION,
        { requestId: "request-1", livenessOwnerToken: TOKEN },
        "registration-socket",
      ),
    ).toBeUndefined();
    expect([...scopes.get("registration-socket")!.sessionUuids]).toEqual([SESSION]);

    const failures: Array<{
      name: string;
      receipt?: SessionBrokerResult;
      sessionId: string;
      liveToken?: string;
    }> = [
      { name: "missing receipt", sessionId: SESSION, liveToken: TOKEN },
      {
        name: "failed receipt",
        receipt: result("failed", "failed"),
        sessionId: SESSION,
        liveToken: TOKEN,
      },
      {
        name: "different session",
        receipt: result("different", "ready", OTHER_SESSION),
        sessionId: SESSION,
        liveToken: TOKEN,
      },
      {
        name: "superseded live owner",
        receipt: result("superseded", "ready", SESSION),
        sessionId: SESSION,
        liveToken: "new-owner",
      },
    ];
    for (const failure of failures) {
      const requestId = failure.receipt?.requestId ?? failure.name;
      if (failure.receipt) {
        broker.statuses.set(`${requestId}:${TOKEN}`, failure.receipt);
      }
      if (failure.liveToken) {
        tokens.set(SESSION, failure.liveToken);
      }
      const socket = `socket:${failure.name}`;
      const response: DaemonMethodResult | undefined = await bindBrokerRegistration(
        state,
        failure.sessionId,
        { requestId, livenessOwnerToken: TOKEN },
        socket,
      );
      expect(response).toMatchObject({
        success: false,
        code: "session_ownership_lost",
      });
      expect(scopes.get(socket)).toEqual({
        scopeKey: SCOPE,
        sessionUuids: new Set(),
      });
    }
  });
});
