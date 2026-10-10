import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { foreignOwnedSessionUuidFromResult } from "../../src/server/routedSessionMeta";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { FakeFeatureFlagRepository } from "../fakes/FakeFeatureFlagRepository";
import { FakeFeatureFlagApplier } from "../fakes/FakeFeatureFlagApplier";
import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { Kysely } from "kysely";
import { z } from "zod/v4";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up } from "../../src/db/migrations/2026_04_02_000_device_sessions";
import { up as addStableDeviceIdentity } from "../../src/db/migrations/2026_09_14_000_device_session_stable_identity";
import { up as addStableDeviceIdentityWriterFence } from "../../src/db/migrations/2026_09_14_001_device_session_identity_writer_fence";
import { up as addLivenessOwner } from "../../src/db/migrations/2026_09_16_000_device_session_liveness_owner";
import { up as addLivenessContract } from "../../src/db/migrations/2026_09_16_001_device_session_liveness_contract";
import { up as addLivenessWriterFence } from "../../src/db/migrations/2026_09_17_000_device_session_liveness_writer_fence";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import type { BootedDevice } from "../../src/models";

/**
 * #11235: two daemon connections (proxy -> socket server -> loopback MCP server) over one
 * autolock pool. Naming another connection's autolock session must not bind the caller's
 * sessionless calls to it.
 */
const devices: BootedDevice[] = [
  { name: "Pixel", deviceId: "emulator-5554", platform: "android" },
  { name: "Pixel 2", deviceId: "emulator-5556", platform: "android" },
];
let db: Kysely<Database>;
let manager: SessionManager;
let pool: DevicePool;
let timer: FakeTimer;
let previousAutolock: string | undefined;
let originalRepository: unknown;
let restorePipelineOverrides: (() => void) | undefined;
const fixtures = new Map<string, McpTestFixture>();
const proxies: DaemonMcpProxy[] = [];
let received: string[];
let restoreSpies: Array<() => void> = [];

beforeEach(async () => {
  previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
  process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
  db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
  });
  for (const migrate of [
    up,
    addStableDeviceIdentity,
    addStableDeviceIdentityWriterFence,
    addLivenessOwner,
    addLivenessContract,
    addLivenessWriterFence,
  ]) {
    await migrate(db as Kysely<unknown>);
  }
  const repository = new DeviceSessionRepository(db);
  timer = new FakeTimer();
  manager = new SessionManager(timer, repository);
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", devices);
  utils.setBootedDevices("ios", []);
  PlatformDeviceManagerFactory.setInstance(utils);
  pool = new DevicePool(
    createDevicePoolDependencies(manager, "daemon", {
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager: utils,
      retryExecutor: new DefaultRetryExecutor(timer),
      deviceSessionRepository: repository,
    }),
  );
  await pool.initializeWithDevices(devices);
  DaemonState.getInstance().initialize(manager, pool);
  ToolRegistry.clearTools();
  restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
    displayInventory: new FakeDisplayInventoryProvider(),
  });
  originalRepository = registryInternals().toolCallRepository;
  registryInternals().toolCallRepository = { recordToolCall: async () => {} };
  received = [];
  const flags = spyOn(FeatureFlagService, "getInstance").mockReturnValue(
    new FeatureFlagService(new FakeFeatureFlagRepository(), new FakeFeatureFlagApplier()),
  );
  const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  restoreSpies = [() => flags.mockRestore(), () => available.mockRestore()];
});

afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    await proxy.close();
  }
  for (const fixture of fixtures.values()) {
    await fixture.teardown();
  }
  fixtures.clear();
  for (const restore of restoreSpies) {
    restore();
  }
  restorePipelineOverrides?.();
  restorePipelineOverrides = undefined;
  PlatformDeviceManagerFactory.setInstance(null);
  registryInternals().toolCallRepository = originalRepository;
  ToolRegistry.clearTools();
  DaemonState.getInstance().reset();
  manager.stopCleanupTimer();
  await db.destroy();
  if (previousAutolock === undefined) {
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
  } else {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
  }
});

/** The registry's call recorder, swapped so no test touches the real database. */
function registryInternals(): { toolCallRepository: unknown } {
  return ToolRegistry as unknown as { toolCallRepository: unknown };
}

interface ForwardRoute {
  clientKey: string;
  sessionUuid?: string;
}

/** The socket server's forwarding steps, driven here exactly as its request loop runs them. */
interface SocketForwardInternals {
  restoreSelectorSessions(args: unknown, socketSessionId: string): Promise<void>;
  getMcpForwardRoute(request: unknown, socketSessionId: string): ForwardRoute;
  withSocketSessionAutolockKey(
    args: unknown,
    socketSessionId: string,
    timeoutMs: number,
  ): Record<string, unknown>;
  recordBoundMcpClientKey(
    request: unknown,
    socketSessionId: string,
    route: ForwardRoute,
    sessionWasActiveBeforeForward: boolean,
    response: unknown,
  ): void;
  boundMcpClientKeysBySocketSession: Map<string, { sessionUuid?: string }>;
}

function internals(socket: UnixSocketServer): SocketForwardInternals {
  return socket as unknown as SocketForwardInternals;
}

function registerTools(): void {
  ToolRegistry.register(
    "getAndroid",
    "getAndroid",
    z
      .object({ __mcpSessionId: z.string().optional(), deviceId: z.string().optional() })
      .passthrough(),
    async (toolArgs) => {
      const sessionUuid = await pool.autolockDevice(
        toolArgs.deviceId ?? devices[0].deviceId,
        "android",
        toolArgs.__mcpSessionId,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ runtime: { session: { sessionUuid } } }),
          },
        ],
      };
    },
  );
  ToolRegistry.registerDeviceAware(
    "routingProbe",
    "routingProbe",
    z.object({
      device: z.string().optional(),
      platform: z.enum(["android", "ios"]).optional(),
      deviceId: z.string().optional(),
      sessionUuid: z.string().optional(),
      keepScreenAwake: z.boolean().optional(),
    }),
    async (device) => {
      received.push(device.deviceId);
      return { content: [{ type: "text" as const, text: device.deviceId }] };
    },
    { deviceReadiness: "booted" },
  );
}

/** One MCP connection: its own proxy and daemon socket session, sharing the daemon's pool. */
function connect(socket: UnixSocketServer, socketSessionId: string): DaemonMcpProxy {
  const dispatch = async (name: string, args: Record<string, unknown>) => {
    const request = { id: "routing", method: "tools/call", params: { name, arguments: args } };
    await internals(socket).restoreSelectorSessions(args, socketSessionId);
    const route = internals(socket).getMcpForwardRoute(request, socketSessionId);
    let fixture = fixtures.get(route.clientKey);
    if (!fixture) {
      fixture = new McpTestFixture({
        daemonMode: true,
        sessionContext: {
          sessionId: route.clientKey,
          initialSessionToolBinding: route.sessionUuid,
        },
      });
      await fixture.setup();
      fixtures.set(route.clientKey, fixture);
      registerTools();
    }
    const forwarded = internals(socket).withSocketSessionAutolockKey(args, socketSessionId, 10000);
    const result = await fixture.client.callTool({ name, arguments: forwarded });
    internals(socket).recordBoundMcpClientKey(request, socketSessionId, route, true, result);
    return result;
  };
  const daemon = new FakeDaemonManager();
  daemon.statusResult = { ...daemon.statusResult, version: DAEMON_VERSION };
  const proxy = new DaemonMcpProxy({
    clientFactory: () => new FakeDaemonClient({ toolResultFor: dispatch }),
    daemonManager: daemon,
    autoStartDaemon: false,
    timer,
    staticToolDefinitionsProvider: () => [
      ...getStaticToolDefinitions(),
      { name: "routingProbe", inputSchema: { properties: { device: {}, sessionUuid: {} } } },
    ],
  });
  proxies.push(proxy);
  return proxy;
}

function newSocketServer(): UnixSocketServer {
  return new UnixSocketServer(
    "/private/tmp/unused-11235.sock",
    "http://localhost:0/mcp",
    DaemonState.getInstance(),
    timer,
  );
}

test("naming another connection's autolock session does not bind the caller's sessionless calls to it (#11235)", async () => {
  const socket = newSocketServer();
  const ownerProxy = connect(socket, "owner");
  const otherProxy = connect(socket, "other");
  await ownerProxy.callTool("getAndroid", {});
  const ownerSession = pool.resolveAutolockSessionForMcpSession("owner");
  expect(ownerSession).toBeDefined();

  // Naming the UUID still reaches that session's device (the UUID is the capability) ...
  const named = await otherProxy.callTool("routingProbe", {
    sessionUuid: ownerSession,
    keepScreenAwake: false,
  });
  expect(named.isError).toBeFalsy();
  expect(received).toEqual([devices[0].deviceId]);
  // ... but never moves ownership (#11188), and binds neither the daemon socket's route nor the
  // proxy: the daemon marks the session as another connection's.
  expect(pool.isAutolockSessionOwnedByOtherConnection(ownerSession!, "other")).toBe(true);
  expect(foreignOwnedSessionUuidFromResult(named)).toBe(ownerSession);
  expect(internals(socket).boundMcpClientKeysBySocketSession.has("other")).toBe(false);

  // The other connection's next untargeted call must not be routed to the owner's device.
  const untargeted = await otherProxy.callTool("routingProbe", { keepScreenAwake: false });
  const reachedOwnerDevice = !untargeted.isError && received.at(-1) === devices[0].deviceId;
  expect(reachedOwnerDevice).toBe(false);
  expect(pool.resolveAutolockSessionForMcpSession("owner")).toBe(ownerSession);
}, 30000);

test("the owner naming its own autolock session is not marked foreign and still binds its route", async () => {
  const socket = newSocketServer();
  const ownerProxy = connect(socket, "owner");
  await ownerProxy.callTool("getAndroid", {});
  const ownerSession = pool.resolveAutolockSessionForMcpSession("owner")!;
  const named = await ownerProxy.callTool("routingProbe", {
    sessionUuid: ownerSession,
    keepScreenAwake: false,
  });
  expect(named.isError).toBeFalsy();
  expect(foreignOwnedSessionUuidFromResult(named)).toBeUndefined();
  expect(internals(socket).boundMcpClientKeysBySocketSession.get("owner")?.sessionUuid).toBe(
    ownerSession,
  );
  await ownerProxy.callTool("routingProbe", { keepScreenAwake: false });
  expect(received).toEqual([devices[0].deviceId, devices[0].deviceId]);
}, 30000);

test("setActiveDevice moves the connection's untargeted calls to the selected device (#11235 N1)", async () => {
  const socket = newSocketServer();
  const proxy = connect(socket, "client");
  await proxy.callTool("getAndroid", { deviceId: devices[0].deviceId });
  const first = pool.resolveAutolockSessionForMcpSession(
    "client",
    "android",
    undefined,
    devices[0].deviceId,
  );
  await proxy.callTool("getAndroid", { deviceId: devices[1].deviceId });
  const second = pool.resolveAutolockSessionForMcpSession(
    "client",
    "android",
    undefined,
    devices[1].deviceId,
  );
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(first).not.toBe(second);

  await proxy.callTool("routingProbe", { keepScreenAwake: false });
  await proxy.callTool("routingProbe", { sessionUuid: second, keepScreenAwake: false });
  await proxy.callTool("routingProbe", { keepScreenAwake: false });
  const selected = await proxy.callTool("setActiveDevice", { deviceId: devices[0].deviceId });
  expect(selected.isError).toBeFalsy();
  await proxy.callTool("routingProbe", { keepScreenAwake: false });
  expect(received.at(-1)).toBe(devices[0].deviceId);
}, 30000);
