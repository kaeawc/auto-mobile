import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DaemonClient } from "../../src/daemon/client";
import {
  DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
  DAEMON_RELEASE_EXECUTION_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../src/daemon/sessionBroker/provisioning/executionLiveness";
import {
  BrokerExecutionRelease,
  managedExecutionSessionsFrom,
} from "../../src/daemon/sessionBroker/provisioning/executionRelease";
import { ManagedConnectionScopes } from "../../src/daemon/managedSlots/managedConnectionScope";
import { BrokerDeviceAcquisition } from "../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import {
  DefaultManagedSpecResolver,
  BindingReconciler,
  type BindingProvisionRequest,
  type BindingProvisionedDevice,
} from "../../src/daemon/sessionBroker/provisioning/reconciler";
import { computeBindingScopeKey } from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  MANAGED_SLOTS_EXPERIMENTAL_CAPABILITY,
  parseBindingConfig,
} from "../../src/models/managedSlotConfig";
import { type BrokerProvisionRequest } from "../../src/daemon/sessionBroker/provisioning/provisionRequest";
import { MANAGED_SLOTS_RESOURCE_URI } from "../../src/models/managedSlotsResult";
import { type BindingsResult } from "../../src/daemon/sessionBroker/provisioning/acquisitionResult";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./sessionBroker/registry/fixtures/reconcilerFakes";

// #11173 part b: a managed slot proxy acquires through `daemon/acquireManagedSlots` before it
// serves initialize, holds the fresh session, and exposes the typed result in initialize and the
// `automobile:managed-slots` resource; a failure serves no tools. Proxy and daemon handler are
// real; the device side is the reconciler's in-memory fakes.

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IOS_17 = "com.apple.CoreSimulator.SimRuntime.iOS-17-5";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const TOKEN = "managed-proxy-token";

function configFor(runtime = IOS_18): BrokerProvisionRequest {
  return parseBindingConfig({
    contractVersion: 1,
    managedHostScope: "host-a",
    runnerNamespace: "ns",
    runnerIncarnation: "inc-1",
    localBindingCapacity: 1,
    preparationTimeoutMs: 120_000,
    idleTimeoutMs: 10 * 60_000,
    requests: [
      {
        bindingIndex: 0,
        role: "app",
        platform: "ios",
        requestedSpec: { runtime, deviceType: IPHONE_16 },
      },
    ],
  });
}

/** The fake provisioner, also creating the daemon session it hands out (as the bind path does). */
class SessionMintingProvisioner extends FakeProvisioner {
  /** Mint UUID session ids, as production does (registerSession validates UUIDs). */
  uuidSessions = false;

  constructor(
    inventory: FakeInventory,
    private readonly sessions: SessionManager,
  ) {
    super(inventory);
  }

  override async provision(request: BindingProvisionRequest): Promise<BindingProvisionedDevice> {
    const minted = await super.provision(request);
    const provisioned = this.uuidSessions
      ? {
          ...minted,
          sessionUuid: `00000000-0000-4000-8000-${minted.sessionUuid.replace(/\D/g, "").padStart(12, "0")}`,
        }
      : minted;
    await this.sessions.createSession(
      provisioned.sessionUuid,
      provisioned.device.transportId ?? provisioned.device.stableId,
      request.platform,
    );
    return provisioned;
  }
}

describe("binding acquisition through the daemon handler and the stdio proxy", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let registry: FakeBindingRegistry;
  let inventory: FakeInventory;
  let provisioner: SessionMintingProvisioner;
  let deleter: FakeDeleter;
  let state: DaemonStateAccess;
  let connectionScopes: ManagedConnectionScopes;
  let socketCount: number;
  let advertiseManagedSlots: boolean;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  const proxies: DaemonMcpProxy[] = [];

  // beforeAll is outside the per-test budget: the first MCP server/client pair in the process pays
  // one-off schema and protocol initialization, which would otherwise land on the first test.
  beforeAll(async () => {
    const warmTimer = new FakeTimer();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => new FakeDaemonClient(),
      daemonManager: new FakeDaemonManager(),
      autoStartDaemon: false,
      timer: warmTimer,
    });
    const { server } = createProxyMcpServer({ proxy });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "warmup", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.close();
    await server.close();
    await proxy.close();
  });

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    registry = new FakeBindingRegistry(timer);
    inventory = new FakeInventory();
    provisioner = new SessionMintingProvisioner(inventory, sessionManager);
    deleter = new FakeDeleter(inventory);
    advertiseManagedSlots = true;
    const reconciler = new BindingReconciler({
      registry,
      inventory,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter,
      claims: new FakeClaims(),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => true,
    });
    const releaseSessions = managedExecutionSessionsFrom(sessionManager, {
      releaseDevice: async () => {},
    });
    const acquisition = new BrokerDeviceAcquisition({
      registry: async () => registry,
      reconcile: (_registry, request) => reconciler.reconcile(request),
      sessions: {
        claimLivenessOwnership: (sessionId, ownerToken) =>
          sessionManager.claimLivenessOwnership(sessionId, ownerToken),
        adoptManagedExecutionLivenessPolicy: (sessionId, options) =>
          sessionManager.adoptManagedExecutionLivenessPolicy(sessionId, options),
        releaseSession: async (sessionId) => {
          await releaseSessions.releaseSession(sessionId);
        },
      },
      owner: () => ({ daemonId: "daemon-1", pid: 4242 }),
      timer,
    });
    const drain = new BrokerExecutionRelease({
      registry: async () => registry,
      work: {
        cancelDeviceSessionExecutions: async () => 0,
        waitForDeviceSessionExecutionsToEnd: async () => true,
        hasActiveDeviceSessionExecutions: () => false,
      },
      sessions: releaseSessions,
      timer,
      settler: { daemonId: "daemon-1", pid: 4242 },
    });
    connectionScopes = new ManagedConnectionScopes();
    socketCount = 0;
    state = {
      isInitialized: () => true,
      getManagedConnectionScopes: () => connectionScopes,
      getManagedSlotAcquisition: () => acquisition,
      getManagedExecutionRelease: () => drain,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
    isAvailableSpy.mockRestore();
    warnSpy.mockRestore();
    sessionManager.stopCleanupTimer();
  });

  function newProxy(clients: FakeDaemonClient[] = []): DaemonMcpProxy {
    const proxy = new DaemonMcpProxy({
      livenessOwnerToken: TOKEN,
      heartbeatIntervalMs: 2_000,
      clientFactory: () => {
        // Each daemon client is one socket session, as the socket server stamps it.
        const socketSessionId = `socket-${++socketCount}`;
        const client = new FakeDaemonClient({
          daemonMethodResults: new Map<string, unknown>([
            ["resources/list", { resources: [] }],
            ["tools/list", { tools: [{ name: "observe", inputSchema: { type: "object" } }] }],
          ]),
          onCallDaemonMethod: async (method, params) => {
            if (!method.startsWith("daemon/")) {
              return undefined;
            }
            const response = await handleDaemonRequest(
              { id: "r", type: "daemon_request", method, params },
              state,
              undefined,
              undefined,
              { socketSessionId },
            );
            if (!response.success) {
              throw Object.assign(new Error(response.error), { code: response.code });
            }
            const result = response.result as { capabilities?: string[] } | undefined;
            if (method === "daemon/capabilities" && !advertiseManagedSlots) {
              return {
                capabilities: (result?.capabilities ?? []).filter((c) => !c.includes("managed")),
              };
            }
            return result;
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
    proxies.push(proxy);
    return proxy;
  }

  async function serve(proxy: DaemonMcpProxy, bindings: BindingsResult) {
    const { server } = createProxyMcpServer({ proxy, bindings });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "managed-slot-client", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  test("ready: initialize carries the result, the resource serves it, the session is held", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = newProxy(clients);

    const result = await proxy.acquireBindings(configFor());

    expect(result).toMatchObject({
      outcome: "ready",
      scope: { scopeKey: computeBindingScopeKey(configFor()) },
      bindings: [{ disposition: "created", sessionUuid: "session-1", assignmentGeneration: 1 }],
    });
    const acquire = clients[0]!.callDaemonMethodCalls.find(
      (call) => call.method === DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
    );
    expect(acquire?.params).toMatchObject({ livenessOwnerToken: TOKEN });
    // The daemon's deadline is the preparation budget left after connecting, less a reply grace.
    expect(acquire?.params.config.preparationTimeoutMs).toBeLessThan(120_000);
    const session = sessionManager.getSession("session-1")!;
    expect(session.livenessOwnerToken).toBe(TOKEN);
    expect(session.livenessPolicy).toBe(MANAGED_EXECUTION_LIVENESS_POLICY);
    expect(session.sessionTimeoutMs).toBe(10 * 60_000);
    expect(proxy.getManagedExecutionSessions()).toEqual(["session-1"]);

    const mcp = await serve(proxy, result);
    try {
      expect(
        mcp.client.getServerCapabilities()?.experimental?.[MANAGED_SLOTS_EXPERIMENTAL_CAPABILITY],
      ).toEqual(JSON.parse(JSON.stringify(result)));
      const resources = await mcp.client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain(
        MANAGED_SLOTS_RESOURCE_URI,
      );
      const read = await mcp.client.readResource({ uri: MANAGED_SLOTS_RESOURCE_URI });
      expect(JSON.parse(String(read.contents[0]!.text))).toEqual(
        JSON.parse(JSON.stringify(result)),
      );
      expect((await mcp.client.listTools()).tools.map((tool) => tool.name)).toContain("observe");
    } finally {
      await mcp.close();
    }
  });

  test("the acquiring socket session is bound to exactly its binding sessions", async () => {
    const proxy = newProxy();

    const result = await proxy.acquireBindings(configFor());

    const binding = connectionScopes.get("socket-1");
    expect(binding?.scopeKey).toBe(computeBindingScopeKey(configFor()));
    expect([...(binding?.sessionUuids ?? [])]).toEqual([result.bindings[0]!.sessionUuid!]);
  });

  test("a failed acquisition binds its socket session to no binding session (fail closed)", async () => {
    provisioner.failWith = () => new Error("simctl create failed");
    const proxy = newProxy();

    await proxy.acquireBindings(configFor());

    const binding = connectionScopes.get("socket-1");
    expect(binding?.scopeKey).toBe(computeBindingScopeKey(configFor()));
    expect(binding?.sessionUuids.size).toBe(0);
  });

  test("a reconnected managed proxy re-binds its new socket to its binding sessions", async () => {
    provisioner.uuidSessions = true;
    const clients: FakeDaemonClient[] = [];
    const proxy = newProxy(clients);
    const result = await proxy.acquireBindings(configFor());
    const sessionUuid = result.bindings[0]!.sessionUuid!;
    expect([...connectionScopes.get("socket-1")!.sessionUuids]).toEqual([sessionUuid]);

    // The daemon socket drops; the daemon unbinds the closed socket session.
    clients[0]!.emitConnectionClosed();
    connectionScopes.unbind("socket-1");
    await proxy.ensureConnected();

    const binding = connectionScopes.get("socket-2");
    expect(binding?.scopeKey).toBe(computeBindingScopeKey(configFor()));
    expect([...(binding?.sessionUuids ?? [])]).toEqual([sessionUuid]);
  });

  test("a later execution reuses the binding after the first one's release, then a spec change replaces it", async () => {
    const first = newProxy();
    const created = await first.acquireBindings(configFor());
    await first.close();
    expect(sessionManager.hasSession(created.bindings[0]!.sessionUuid!)).toBe(false);

    const second = newProxy();
    const reused = await second.acquireBindings(configFor());
    expect(reused.bindings[0]).toMatchObject({ disposition: "reused", sessionUuid: "session-2" });
    expect(reused.bindings[0]!.device).toEqual(created.bindings[0]!.device);
    await second.close();

    const third = newProxy();
    const replaced = await third.acquireBindings(configFor(IOS_17));
    expect(replaced.bindings[0]).toMatchObject({ disposition: "replaced" });
    expect(deleter.calls.map((call) => call.stableId)).toEqual([
      created.bindings[0]!.device!.stableId,
    ]);
    expect(provisioner.created()).toHaveLength(2);
  });

  test("closing the proxy ends the execution through releaseExecution with its owner token", async () => {
    const clients: FakeDaemonClient[] = [];
    const proxy = newProxy(clients);
    await proxy.acquireBindings(configFor());

    await proxy.close();

    const release = clients[0]!.callDaemonMethodCalls.find(
      (call) => call.method === DAEMON_RELEASE_EXECUTION_METHOD,
    );
    expect(release?.params).toEqual({ sessionId: "session-1", livenessOwnerToken: TOKEN });
    expect(
      await registry.getAssignment({
        scopeKey: computeBindingScopeKey(configFor()),
        bindingIndex: 0,
      }),
    ).toMatchObject({ execOwner: null, state: "ready" });
  });

  test("failed: initialize carries the typed failure, no tools are served and calls are refused", async () => {
    provisioner.failWith = () => new Error("simctl create failed");
    const proxy = newProxy();

    const result = await proxy.acquireBindings(configFor());

    expect(result.outcome).toBe("failed");
    expect(result.failure).toMatchObject({ code: "provision_failed" });
    expect(proxy.getManagedExecutionSessions()).toEqual([]);
    const mcp = await serve(proxy, result);
    try {
      expect(
        mcp.client.getServerCapabilities()?.experimental?.[MANAGED_SLOTS_EXPERIMENTAL_CAPABILITY],
      ).toMatchObject({ outcome: "failed", failure: { code: "provision_failed" } });
      expect((await mcp.client.listTools()).tools).toEqual([]);
      const call = await mcp.client.callTool({ name: "observe", arguments: {} });
      expect(call.isError).toBe(true);
      const payload = JSON.parse(String((call.content as Array<{ text: string }>)[0]!.text));
      expect(payload.error).toMatchObject({
        code: "binding_acquisition_failed",
        acquisitionFailure: { code: "provision_failed" },
      });
      const read = await mcp.client.readResource({ uri: MANAGED_SLOTS_RESOURCE_URI });
      expect(JSON.parse(String(read.contents[0]!.text))).toMatchObject({ outcome: "failed" });
    } finally {
      await mcp.close();
    }
  });

  test("a daemon without managed-slots/v1 fails contract_unsupported before any mutation", async () => {
    advertiseManagedSlots = false;
    const clients: FakeDaemonClient[] = [];
    const proxy = newProxy(clients);

    const result = await proxy.acquireBindings(configFor());

    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "contract_unsupported", retryable: false },
    });
    expect(
      clients[0]!.callDaemonMethodCalls.some(
        (call) => call.method === DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
      ),
    ).toBe(false);
    expect(provisioner.calls).toEqual([]);
  });

  test("an invalid config crossing the socket fails with its typed config code", async () => {
    const response = await handleDaemonRequest(
      {
        id: "r",
        type: "daemon_request",
        method: DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
        params: { config: { contractVersion: 2 }, livenessOwnerToken: TOKEN },
      },
      state,
    );

    expect(response).toMatchObject({ success: false, code: "contract_unsupported" });
    expect(provisioner.calls).toEqual([]);
  });

  test("a multi-device group crossing the socket fails binding_group_unsupported before any mutation", async () => {
    const config = configFor();
    const response = await handleDaemonRequest(
      {
        id: "r",
        type: "daemon_request",
        method: DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
        params: {
          config: {
            ...config,
            localBindingCapacity: 2,
            requests: [config.requests[0], { ...config.requests[0], bindingIndex: 1 }],
          },
          livenessOwnerToken: TOKEN,
        },
      },
      state,
    );

    expect(response).toMatchObject({ success: false, code: "binding_group_unsupported" });
    expect(provisioner.calls).toEqual([]);
    const scopeKey = computeBindingScopeKey(config);
    expect(await registry.getScope(scopeKey)).toBeNull();
    expect(await registry.listAssignments(scopeKey)).toEqual([]);
  });
});
