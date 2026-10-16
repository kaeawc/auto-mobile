import { exampleSessionBrokerDeviceName } from "../../src/daemon/sessionBroker/deviceNaming";
import "../../scripts/manual-test/harnessLogSink";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrokerDaemonClient } from "../../scripts/manual-test/brokerDaemonClient";
import type { BrokerScenarioFakeControls } from "../../scripts/manual-test/brokerScenarios";
import { openSqliteBindingRegistry } from "../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { BrokerConnectionScopes } from "../../src/daemon/sessionBroker/connectionScope";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { SessionBroker } from "../../src/daemon/sessionBroker/broker";
import type { SessionLiveness } from "../../src/daemon/sessionBroker/sessionDisposition";
import { bindBrokerRegistration } from "../../src/daemon/sessionBroker/handlers";
import { SessionBrokerService } from "../../src/daemon/sessionBroker/service";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { SessionConfig } from "../../src/devices/sessionConfig";
import type { SessionBrokerResult } from "../../src/devices/sessionBrokerResult";
import { assertSessionBrokerToolCall } from "../../src/server/sessionBrokerToolGate";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { iosCatalog, iosDefaults } from "../devices/sessionRequirements/fixtures";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import type { BindingProcessIdentity } from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import { FAKE_BROKER_OWNER, FakeNativePort } from "./fakeSessionBrokerDevicePort";

/** Real durable broker semantics; all storage is :memory: and native I/O is fake. */
export async function createFakeBrokerDaemon(
  options: {
    capacity?: number;
    timer?: FakeTimer;
    ids?: FakeIdGenerator;
    /** A file path makes the registry durable so a second host can model a daemon restart. */
    dbPath?: string;
    /** The broker process identity; a restarted daemon differs from its predecessor. */
    owner?: BindingProcessIdentity;
    /** First fake session UUID ordinal, so a restarted host never reissues a predecessor's UUID. */
    sessionIdBase?: number;
    /** Wire the daemon's real disposition: a grant whose session left the SessionManager is gone. */
    liveDisposition?: boolean;
    /** Whether a predecessor broker process still runs; defaults to live (no takeover). */
    isOwnerLive?: (owner: BindingProcessIdentity) => boolean;
  } = {},
) {
  const timer = options.timer ?? new FakeTimer();
  const ids = options.ids ?? new FakeIdGenerator();
  const registry = await openSqliteBindingRegistry({
    dbPath: options.dbPath ?? ":memory:",
    timer,
    isExecOwnerLive: options.isOwnerLive ?? (() => true),
  });
  const scope = await registry.ensureScope({
    managedHostScope: "scenario",
    runnerNamespace: "fake",
    runnerIncarnation: "memory",
  });
  if (scope.kind !== "ready") {
    await registry.close();
    throw new Error("Missing fake broker scope");
  }
  // Session UUIDs must pass the real handler's UUID validation; no random generator is used.
  const sessionIds = new FakeIdGenerator(
    Array.from(
      { length: 32 },
      (_, i) =>
        `00000000-0000-4000-8000-${String(i + 1 + (options.sessionIdBase ?? 0)).padStart(12, "0")}`,
    ),
  );
  const owner = options.owner ?? FAKE_BROKER_OWNER;
  const devices = new FakeNativePort(registry, sessionIds, owner);
  const store = registry.sessionBrokerStore(scope.scope.scopeKey, ids);
  let unavailable = false;
  let disposition: SessionLiveness = "live";
  const broker = new SessionBroker({
    store,
    devices,
    owner,
    sessionDisposition: options.liveDisposition
      ? (sessionUuid) => (sessions.peekSession(sessionUuid) ? "live" : "gone")
      : () => disposition,
    limits: {
      totalDeviceCap: options.capacity ?? 1,
      sessionCap: options.capacity ?? 1,
      idlePoolCap: 0,
    },
    reuseCleanDevices: false,
    catalog: async () =>
      iosCatalog(
        unavailable
          ? {
              provenance: {
                source: "fake",
                revision: "1",
                state: "unavailable",
                message: "Fake catalog unavailable",
              },
            }
          : {},
      ),
    defaults: () => iosDefaults(),
  });
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  sessions.stopCleanupTimer();
  const scopes = new BrokerConnectionScopes();
  const service = new SessionBrokerService(
    broker,
    scope.scope.scopeKey,
    { acquire: () => {}, release: () => {} },
    timer,
  );
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionBrokerService: () => service,
    getBrokerConnectionScopes: () => scopes,
    getSessionManager: () => sessions,
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      isPooledIdentityUnresolved: () => false,
    }),
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  };
  const prepare = async (config: SessionConfig, token: string) => {
    const result = await broker.prepare(config, token);
    if (result.outcome === "ready" && result.sessionUuid) {
      const resource = devices.sessions.get(result.sessionUuid);
      if (!resource) {
        throw new Error("Ready broker session has no fake device");
      }
      await sessions.createSession(
        result.sessionUuid,
        `device-${resource.resourceId}`,
        result.profile!.platform,
      );
      sessions.bindAcquiredLivenessOwnerToken(result.sessionUuid, token);
    }
    return result;
  };
  const client: BrokerDaemonClient = {
    status: (requestId, token) => broker.ownedStatus(requestId, token),
    abandon: (requestId, token) => broker.abandon(requestId, token),
    release: async (sessionUuid, token) => {
      // The real release handler uses this same ownership check before release().
      const owned = await broker.ownedSessionRequest(sessionUuid, token);
      return owned ? broker.release(sessionUuid) : { sessionUuid, outcome: "unknown_session" };
    },
    info: async (sessionId) => {
      const resource = devices.sessions.get(sessionId);
      if (!resource) {
        throw new Error("Unknown fake session");
      }
      return {
        sessionId,
        nativeDevice: {
          name: exampleSessionBrokerDeviceName(resource.resourceId),
          deviceId: `device-${resource.resourceId}`,
          platform: (await broker.status(resource.requestId!))!.profile!.platform,
        },
      };
    },
    capabilities: async () => ["session-broker/v1"],
  };
  const controls: BrokerScenarioFakeControls = {
    prepared: () => devices.prepared,
    inventory: async () => {
      const inventory = [];
      for (const resource of await store.listResources()) {
        const assignment = await registry.getAssignment({
          scopeKey: resource.scopeKey,
          bindingIndex: resource.allocationIndex,
        });
        if (assignment?.stableDeviceId && assignment.deviceName) {
          inventory.push({
            name: assignment.deviceName,
            deviceId: assignment.stableDeviceId,
            platform: assignment.platform,
          });
        }
      }
      return { devices: inventory, daemons: [{ alive: true }] };
    },
    pausePreparation: () => {
      let entered!: () => void;
      let joined = false;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      devices.prepareHook = async ({ signal }) => {
        if (!signal) {
          throw new Error("Real broker preparation must supply a cancellation signal");
        }
        devices.prepareHook = undefined;
        entered();
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            if (signal.aborted) {
              reject(signal.reason);
            }
          });
        } finally {
          joined = true;
        }
      };
      return { entered: enteredPromise, joined: () => joined };
    },
    catalogUnavailable: (value) => {
      unavailable = value;
    },
    tool: (name, sessionUuid) =>
      assertSessionBrokerToolCall(
        name,
        name === "observe",
        { sessionUuid },
        {
          isSessionBrokerMode: () => true,
          isInitialized: () => true,
          getSessionBrokerService: () => ({ broker }),
          getSessionManager: () => sessions,
        },
      ),
    rebind: (sessionUuid, requestId, token) =>
      bindBrokerRegistration(
        state,
        sessionUuid,
        { requestId, livenessOwnerToken: token },
        "fake-connection",
      ),
    tools: async (result: SessionBrokerResult) => {
      // Exercise the real MCP advertisement with SDK memory transports, never sockets.
      const { server, proxy } = createProxyMcpServer({
        session: result,
        proxyConfig: {
          timer,
          clientFactory: () => new FakeDaemonClient(),
          daemonManager: Object.assign(new FakeDaemonManager(), {
            restartAdmitted: async () => {
              throw new Error("Fake scenario must not restart a daemon");
            },
          }),
          autoStartDaemon: false,
          daemonAvailabilityProbe: async () => true,
        },
      });
      const sdk = new Client({ name: "fake-scenario", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(a);
        await sdk.connect(b);
        return (await sdk.listTools()).tools.map((tool) => tool.name);
      } finally {
        await sdk.close();
        await server.close();
        await proxy.close();
      }
    },
    setSessionDisposition: (value) => {
      disposition = value;
    },
    recover: () => broker.recover(),
    cleanup: () => broker.close(),
  };
  return {
    broker,
    client,
    prepare,
    controls,
    store,
    devices,
    scopes,
    sessions,
    state,
    timer,
    ids,
    /** Process death: no broker shutdown release runs, only the storage handle goes away. */
    crash: async () => {
      sessions.stopCleanupTimer();
      await registry.close();
    },
    close: async () => {
      try {
        await broker.close();
      } finally {
        sessions.stopCleanupTimer();
        await registry.close();
      }
    },
  };
}
