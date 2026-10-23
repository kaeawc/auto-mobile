import { InMemoryMutationRecordingGaps } from "../../../src/daemon/sessionBroker/mutations/recordingGaps";
import { afterEach, beforeEach, describe, expect, spyOn, test, mock } from "bun:test";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { BindingProcessIdentity } from "../../../src/daemon/sessionBroker/registry/bindingRegistry";
import type {
  DaemonMethodResult,
  DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { BrokerConnectionScopes } from "../../helpers/brokerHandlerFixtures";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import {
  BROKER_DAEMON_METHOD_HANDLERS,
  bindBrokerRegistration,
  handleAbandonBrokerSessionRequest,
  handleBrokerSessionStatus,
  handleGetSessionExport,
  handleAcknowledgeSessionExport,
  handlePrepareBrokerSession,
  handleReleaseBrokerSession,
} from "../../../src/daemon/sessionBroker/handlers";
import {
  SessionRequestOwnerMismatchError,
  SESSION_BROKER_RETRY_AFTER_MS,
} from "../../../src/daemon/sessionBroker/SessionRequestOwnerMismatchError";
import { SessionBrokerService } from "../../../src/daemon/sessionBroker/service";
import type { SqliteSessionBrokerStore } from "../../../src/daemon/sessionBroker/sqliteStore";
import {
  SessionExportIdentityMismatchError,
  type BrokerExportIdentity,
  type BrokerRequestRecord,
} from "../../../src/daemon/sessionBroker/store";
import { sessionRequestFingerprint } from "../../../src/daemon/sessionBroker/requestIdentity";
import { handleDaemonRequest } from "../../../src/daemon/daemonRequestHandlers";
import { ActionableError } from "../../../src/models/ActionableError";
import type { SessionBrokerResult } from "../../../src/devices/sessionBrokerResult";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import type { DaemonRequest } from "../../../src/daemon/types";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";

afterEach(() => {
  mock.restore();
});

const OWNER: BindingProcessIdentity = {
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
  prepareError: Error | undefined;
  mutationError: Error | undefined;
  prepareResult = result("request-1", "failed");
  ownedStatusError: Error | undefined;
  readonly statuses = new Map<string, SessionBrokerResult>();
  readonly sessionOwners = new Map<string, string>();
  readonly prepareCalls: Array<{
    config: SessionConfig;
    token: string;
    signal?: AbortSignal;
    export?: BrokerExportIdentity;
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
    exportIdentity?: BrokerExportIdentity,
  ): Promise<SessionBrokerResult> {
    this.prepareCalls.push({
      config,
      token,
      signal,
      ...(exportIdentity ? { export: exportIdentity } : {}),
    });
    if (this.prepareError) {
      return Promise.reject(this.prepareError);
    }
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
    if (this.mutationError) {
      throw this.mutationError;
    }
    return result(requestId, "failed");
  }

  override async release(sessionId: string) {
    this.releaseCalls.push(sessionId);
    if (this.mutationError) {
      throw this.mutationError;
    }
    return { sessionUuid: sessionId, outcome: "cleanup_pending" as const };
  }
}

describe("session broker daemon handlers", () => {
  let registry: SqliteBindingRegistry;
  let broker: HandlerBroker;
  let scopes: BrokerConnectionScopes;
  let tokens: Map<string, string>;
  let state: DaemonStateAccess;

  beforeEach(async () => {
    registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      isExecOwnerLive: () => true,
    });
    broker = new HandlerBroker(registry.sessionBrokerStore(SCOPE));
    scopes = new BrokerConnectionScopes();
    tokens = new Map();
    const service = new SessionBrokerService(
      broker,
      SCOPE,
      { acquire: () => {}, release: () => {} },
      new FakeTimer(),
      new InMemoryMutationRecordingGaps(),
    );
    state = {
      isInitialized: () => true,
      getSessionBrokerService: () => service,
      getBrokerConnectionScopes: () => scopes,
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

  const exportIdentity = { prepareId: "prepare-id", requestDigest: "digest" };
  test("stats socket read validates bounds and forwards a read-only request", async () => {
    const handler = BROKER_DAEMON_METHOD_HANDLERS.find(
      ([method]) => method === "daemon/sessionBrokerStats",
    )![1];
    const stats = { sinceMs: 1, untilMs: 2, limit: 10, truncated: false, groups: [] };
    const statsSpy = spyOn(broker, "stats").mockResolvedValue(stats);
    expect(
      await handler(request({ windowMs: 100, limit: 10 }), state, undefined, undefined, {}),
    ).toEqual({ success: true, result: stats });
    expect(statsSpy).toHaveBeenCalledWith(100, 10);
    expect(await handler(request({ limit: 10001 }), state, undefined, undefined, {})).toMatchObject(
      { success: false, code: "session_config_invalid" },
    );
    statsSpy.mockRestore();
    expect(broker.prepareCalls).toEqual([]);
  });
  const exportParams = { ...exportIdentity, livenessOwnerToken: TOKEN };

  async function seedExport() {
    const config = sessionConfig();
    await registry.sessionBrokerStore(SCOPE).recordPreAdmissionFailure(
      {
        requestId: config.requestId,
        parameters: config,
        fingerprint: sessionRequestFingerprint(config, TOKEN),
        owner: OWNER,
        export: exportIdentity,
      },
      { code: "catalog_failure", message: "catalog unavailable", retryable: false },
    );
  }

  test("prepare accepts and forwards a strict bounded export identity; mismatch is an RPC rejection", async () => {
    expect(
      await handlePrepareBrokerSession(
        request({ config: sessionConfig(), livenessOwnerToken: TOKEN, export: exportIdentity }),
        state,
      ),
    ).toMatchObject({ success: true });
    expect(broker.prepareCalls[0].export).toEqual(exportIdentity);
    broker.prepareError = new SessionExportIdentityMismatchError();
    expect(
      await handlePrepareBrokerSession(
        request({ config: sessionConfig(), livenessOwnerToken: TOKEN, export: exportIdentity }),
        state,
        undefined,
        "export-mismatch",
      ),
    ).toMatchObject({ success: false, code: "session_export_identity_mismatch" });
    expect(scopes.get("export-mismatch")?.sessionUuids.size).toBe(0);
    for (const identity of [
      { ...exportIdentity, extra: true },
      { ...exportIdentity, prepareId: "" },
      { ...exportIdentity, requestDigest: "" },
      { ...exportIdentity, prepareId: "x".repeat(257) },
      { ...exportIdentity, requestDigest: "x".repeat(257) },
    ]) {
      expect(
        await handlePrepareBrokerSession(
          request({ config: sessionConfig(), livenessOwnerToken: TOKEN, export: identity }),
          state,
        ),
      ).toMatchObject({ success: false, code: "session_config_invalid" });
    }
    expect(broker.prepareCalls).toHaveLength(2);
  });

  test("export socket methods dispatch proof and ack and leave the connection binding untouched", async () => {
    await seedExport();
    for (const method of ["daemon/getSessionExport", "daemon/acknowledgeSessionExport"]) {
      scopes.bind("export-socket", { scopeKey: SCOPE, sessionUuids: [SESSION] });
      const response = await handleDaemonRequest(
        { ...request(exportParams), method },
        state,
        undefined,
        undefined,
        { socketSessionId: "export-socket" },
      );
      expect(response).toMatchObject({
        success: true,
        result:
          method === "daemon/getSessionExport"
            ? {
                contractVersion: 1,
                ...exportIdentity,
                acknowledged: false,
                result: { outcome: "failed", failure: { code: "catalog_failure" } },
              }
            : { prepareId: exportIdentity.prepareId, outcome: "acknowledged" },
      });
      // The connection keeps exactly the grant it already held.
      expect(scopes.get("export-socket")).toEqual({
        scopeKey: SCOPE,
        sessionUuids: new Set([SESSION]),
      });
    }
  });

  test("reading a ready export never binds its session to the socket", async () => {
    const proof = {
      contractVersion: 1 as const,
      ...exportIdentity,
      acknowledged: false,
      result: result("request-1", "ready", SESSION),
    };
    spyOn(broker, "getExport").mockResolvedValue(proof);
    const response = await handleGetSessionExport(request(exportParams), state);
    expect(response).toEqual({ success: true, result: proof });
    expect(scopes.get("proof-only")).toBeUndefined();
  });

  test("export handlers reject malformed or unauthorized queries and acknowledge unknown identities", async () => {
    await seedExport();
    for (const handler of [handleGetSessionExport, handleAcknowledgeSessionExport]) {
      for (const params of [
        { ...exportParams, extra: true },
        { ...exportParams, prepareId: "" },
        { ...exportParams, requestDigest: "" },
        { ...exportParams, prepareId: "x".repeat(257) },
        { ...exportParams, requestDigest: "x".repeat(257) },
        { ...exportParams, livenessOwnerToken: "" },
      ]) {
        scopes.bind("invalid-export", { scopeKey: SCOPE, sessionUuids: [SESSION] });
        expect(await handler(request(params), state)).toMatchObject({
          success: false,
          code: "session_config_invalid",
        });
        expect(scopes.get("invalid-export")?.sessionUuids.size).toBe(1);
      }
      for (const params of [
        { ...exportParams, requestDigest: "wrong" },
        { ...exportParams, livenessOwnerToken: "wrong" },
      ]) {
        expect(await handler(request(params), state)).toMatchObject({
          success: false,
          code: "session_export_identity_mismatch",
        });
      }
    }
    expect(
      await handleGetSessionExport(request({ ...exportParams, prepareId: "missing" }), state),
    ).toMatchObject({ success: false, code: "session_export_not_found" });
    expect(
      await handleAcknowledgeSessionExport(
        request({ ...exportParams, prepareId: "missing" }),
        state,
      ),
    ).toEqual({ success: true, result: { prepareId: "missing", outcome: "unknown_export" } });
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
      result: { ...result("request-1", "ready", SESSION) },
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

  for (const restartHandoff of [true, false]) {
    test(`release and abandon return typed generation refusals (restartHandoff=${restartHandoff})`, async () => {
      broker.sessionOwners.set(SESSION, TOKEN);
      broker.mutationError = new SessionRequestOwnerMismatchError(restartHandoff);
      const expected: DaemonMethodResult = {
        success: false,
        code: restartHandoff ? "session_restart_handoff_pending" : "session_owner_mismatch",
        error: "Session request belongs to another daemon process generation",
        retryable: restartHandoff,
        ...(restartHandoff ? { retryAfterMs: SESSION_BROKER_RETRY_AFTER_MS } : {}),
      };
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      const debug = spyOn(logger, "debug").mockImplementation(() => {});
      try {
        expect(
          await handleReleaseBrokerSession(
            request({ sessionId: SESSION, livenessOwnerToken: TOKEN }),
            state,
          ),
        ).toEqual(expected);
        expect(
          await handleAbandonBrokerSessionRequest(
            request({ requestId: "request-1", livenessOwnerToken: TOKEN }),
            state,
          ),
        ).toEqual(expected);
        expect(restartHandoff ? debug : warning).toHaveBeenCalledTimes(2);
        expect(restartHandoff ? warning : debug).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
        debug.mockRestore();
      }
    });
  }

  test("prepare and abandon return stopping refusals at debug without granting a session", async () => {
    await broker.markRestartHandoff();
    const prepare = spyOn(broker, "prepare").mockImplementation((...args) =>
      SessionBroker.prototype.prepare.call(broker, ...args),
    );
    const abandon = spyOn(broker, "abandon").mockImplementation((...args) =>
      SessionBroker.prototype.abandon.call(broker, ...args),
    );
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    scopes.bind("stopping-socket", { scopeKey: SCOPE, sessionUuids: [SESSION] });
    const expected: DaemonMethodResult = {
      success: false,
      code: "session_broker_stopping",
      error: "Session broker is stopping",
      retryable: true,
      retryAfterMs: 5_000,
    };
    try {
      expect(
        await handlePrepareBrokerSession(
          request({ config: sessionConfig(), livenessOwnerToken: TOKEN }),
          state,
          undefined,
          "stopping-socket",
        ),
      ).toEqual(expected);
      expect(
        await handleAbandonBrokerSessionRequest(
          request({ requestId: "request-1", livenessOwnerToken: TOKEN }),
          state,
        ),
      ).toEqual(expected);
      expect(scopes.get("stopping-socket")?.sessionUuids.size).toBe(0);
      expect(debug).toHaveBeenCalledTimes(2);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      abandon.mockRestore();
      warning.mockRestore();
      debug.mockRestore();
    }
  });

  test("export identity mismatch remains a warning", async () => {
    broker.prepareError = new SessionExportIdentityMismatchError();
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      expect(
        await handlePrepareBrokerSession(
          request({ config: sessionConfig(), livenessOwnerToken: TOKEN }),
          state,
        ),
      ).toMatchObject({ success: false, code: "session_export_identity_mismatch" });
      expect(warning).toHaveBeenCalledWith(
        `Session broker rejected export identity: ${broker.prepareError.message}`,
      );
      expect(debug).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      debug.mockRestore();
    }
  });

  test("release and abandon rethrow unknown failures", async () => {
    broker.sessionOwners.set(SESSION, TOKEN);
    const failure = new Error("unexpected storage failure");
    broker.mutationError = failure;
    broker.prepareError = failure;
    await expect(
      handlePrepareBrokerSession(
        request({ config: sessionConfig(), livenessOwnerToken: TOKEN }),
        state,
      ),
    ).rejects.toBe(failure);
    await expect(
      handleReleaseBrokerSession(request({ sessionId: SESSION, livenessOwnerToken: TOKEN }), state),
    ).rejects.toBe(failure);
    await expect(
      handleAbandonBrokerSessionRequest(
        request({ requestId: "request-1", livenessOwnerToken: TOKEN }),
        state,
      ),
    ).rejects.toBe(failure);
  });

  for (const configured of [true, false]) {
    test(`every missing-service handler reports retry hints (configured=${configured})`, async () => {
      const unavailableState: DaemonStateAccess = {
        ...state,
        isSessionBrokerMode: () => configured,
        getSessionBrokerService: () => undefined,
      };
      const expected: DaemonMethodResult = {
        success: false,
        code: "session_broker_unavailable",
        error: expect.any(String),
        retryable: configured,
        ...(configured ? { retryAfterMs: SESSION_BROKER_RETRY_AFTER_MS } : {}),
      };
      for (const [, handler] of BROKER_DAEMON_METHOD_HANDLERS) {
        expect(await handler(request({}), unavailableState, undefined, undefined, {})).toEqual(
          expected,
        );
      }
      expect(
        await bindBrokerRegistration(unavailableState, SESSION, {
          requestId: "request-1",
          livenessOwnerToken: TOKEN,
        }),
      ).toEqual(expected);
    });
  }

  test("abandon validates and forwards the original request identity and owner", async () => {
    expect(
      await handleAbandonBrokerSessionRequest(
        request({ requestId: "request-1", livenessOwnerToken: TOKEN }),
        state,
      ),
    ).toEqual({
      success: true,
      result: { ...result("request-1", "failed") },
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

  test.each([
    { input: undefined, expected: undefined },
    { input: null, expected: undefined },
    { input: 750, expected: 750 },
    { input: 0, expected: 0 },
    { input: -10, expected: 0 },
    { input: 40_000, expected: 30_000 },
    { input: Number.NaN, expected: undefined },
    { input: Number.POSITIVE_INFINITY, expected: undefined },
    { input: Number.NEGATIVE_INFINITY, expected: undefined },
  ])("release parses and clamps replyBudgetMs=$input to $expected", async ({ input, expected }) => {
    broker.sessionOwners.set(SESSION, TOKEN);
    const release = spyOn(broker, "release");
    try {
      expect(
        await handleReleaseBrokerSession(
          request({ sessionId: SESSION, livenessOwnerToken: TOKEN, replyBudgetMs: input }),
          state,
        ),
      ).toMatchObject({ success: true });
      expect(release).toHaveBeenCalledWith(SESSION, undefined, { replyBudgetMs: expected });
    } finally {
      release.mockRestore();
    }
  });

  test.each(["500", {}])("release rejects a non-number replyBudgetMs=%p", async (input) => {
    broker.sessionOwners.set(SESSION, TOKEN);
    expect(
      await handleReleaseBrokerSession(
        request({ sessionId: SESSION, livenessOwnerToken: TOKEN, replyBudgetMs: input }),
        state,
      ),
    ).toMatchObject({ success: false });
    expect(broker.releaseCalls).toEqual([]);
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
