import { makePool } from "../helpers/makePool";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";
import { DaemonClient } from "../../src/daemon/client/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import { foreignOwnedSessionUuidFromResult } from "../../src/daemon/routedSessionMeta";
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
import { up as addActivitySequence } from "../../src/db/migrations/2026_10_15_000_device_session_activity_seq";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import type { DaemonRequest } from "../../src/daemon/types";
import { isRecord } from "../../src/server/pipeline/isRecord";
import { ToolRegistry, type ToolRegistryCollaborators } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
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
let originalRepository: ReturnType<
  typeof ToolRegistry.getCollaboratorsForTesting
>["toolCallRepository"];
let originalCollaborators: ToolRegistryCollaborators;
let deviceReadiness: FakeDeviceReadiness;
let restorePipelineOverrides: (() => void) | undefined;
const fixtures = new Map<string, McpTestFixture>();
const proxies: DaemonMcpProxy[] = [];
let received: string[];
let restoreSpies: Array<() => void> = [];

beforeEach(async () => {
  originalCollaborators = ToolRegistry.getCollaboratorsForTesting();
  deviceReadiness = new FakeDeviceReadiness();
  deviceReadiness.setConnectedDevices(devices);
  ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: deviceReadiness });
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
    addActivitySequence,
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
  pool = makePool(manager, "daemon", {
    timer,
    deviceManager: utils,
    deviceSessionRepository: repository,
  });
  await pool.initializeWithDevices(devices);
  DaemonState.getInstance().initialize(manager, pool);
  ToolRegistry.clearTools();
  restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
    displayInventory: new FakeDisplayInventoryProvider(),
  });
  originalRepository = ToolRegistry.getCollaboratorsForTesting().toolCallRepository;
  ToolRegistry.setCollaboratorsForTesting({
    toolCallRepository: { recordToolCall: async () => {} },
  });
  received = [];
  const flags = spyOn(FeatureFlagService, "getInstance").mockReturnValue(
    new FeatureFlagService(new FakeFeatureFlagRepository(), new FakeFeatureFlagApplier()),
  );
  const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  restoreSpies = [() => flags.mockRestore(), () => available.mockRestore()];
});

afterEach(async () => {
  try {
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
    ToolRegistry.setCollaboratorsForTesting({ toolCallRepository: originalRepository });
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    await db.destroy();
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  } finally {
    ToolRegistry.setCollaboratorsForTesting(originalCollaborators);
  }
});

function registerTools(): void {
  ToolRegistry.register(
    "getAndroid",
    "getAndroid",
    z
      .object({ __mcpSessionId: z.string().optional(), deviceId: z.string().optional() })
      .passthrough(),
    async (toolArgs) => {
      const deviceId = toolArgs.deviceId ?? devices[0].deviceId;
      // Autolock off mints an ordinary device session owned by the acquiring connection.
      const sessionUuid =
        (await pool.autolockDevice(deviceId, "android", toolArgs.__mcpSessionId)) ??
        (await pool.bindOrReuseDeviceSession({
          sessionId: `session-${deviceId}`,
          deviceId,
          platform: "android",
          allowSessionRebind: false,
          mcpSessionId: toolArgs.__mcpSessionId,
        }));
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
  ToolRegistry.registerDeviceAware(
    "watchProbe",
    "watchProbe",
    z.object({ deviceId: z.string().optional(), sessionUuid: z.string().optional() }),
    async (device) => {
      received.push(device.deviceId);
      return { content: [{ type: "text" as const, text: device.deviceId }] };
    },
    { deviceReadiness: "booted", deviceReadOnly: true },
  );
}

/** One MCP connection: its own proxy and daemon socket session, sharing the daemon's pool. */
function connect(socket: UnixSocketServer, socketSessionId: string): DaemonMcpProxy {
  const dispatch = async (name: string, args: Record<string, unknown>) => {
    const request: DaemonRequest = {
      id: "routing",
      type: "mcp_request",
      method: "tools/call",
      params: { name, arguments: args },
    };
    await socket.testHooks.restoreSelectorSessions(args, socketSessionId);
    const route = await socket.testHooks.getMcpForwardRoute(request, socketSessionId);
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
    const forwarded = socket.testHooks.withSocketSessionAutolockKey(args, socketSessionId, 10000);
    if (!isRecord(forwarded)) {
      throw new Error("Expected forwarded tool arguments to be an object");
    }
    // The first call pays one-time cold-start cost (~0.4 s locally, ~3.5-4.3 s on Windows CI,
    // which sits on the fixture's 4 s default); the tests carry a 30 s timeout of their own.
    const result = await fixture.client.callTool(
      { name, arguments: forwarded },
      { timeout: 20_000 },
    );
    socket.testHooks.recordBoundMcpClientKey(request, socketSessionId, route, {
      sessionWasActiveBeforeForward: true,
      response: result,
    });
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
      { name: "watchProbe", inputSchema: { properties: { sessionUuid: {} } } },
    ],
  });
  proxies.push(proxy);
  return proxy;
}

function newSocketServer(): UnixSocketServer {
  return new UnixSocketServer("/private/tmp/unused-11235.sock", DaemonState.getInstance(), timer);
}

test("a read naming another connection's session watches it without binding the caller (#11235)", async () => {
  const socket = newSocketServer();
  const ownerProxy = connect(socket, "owner");
  const otherProxy = connect(socket, "other");
  await ownerProxy.callTool("getAndroid", {});
  const ownerSession = pool.resolveAutolockSessionForMcpSession("owner");
  expect(ownerSession).toBeDefined();

  // A read is never refused: it watches that session's device ...
  const named = await otherProxy.callTool("watchProbe", { sessionUuid: ownerSession });
  expect(named.isError).toBeFalsy();
  expect(received).toEqual([devices[0].deviceId]);
  // ... but never moves ownership (#11188), and binds neither the daemon socket's route nor the
  // proxy: the daemon marks the session as another connection's.
  expect(pool.isSessionOwnedByOtherConnection(ownerSession!, "other")).toBe(true);
  expect(foreignOwnedSessionUuidFromResult(named)).toBe(ownerSession);
  expect(socket.testHooks.boundMcpClientFor("other")).toBeUndefined();

  // The other connection's next untargeted call must not be routed to the owner's device.
  const scansBeforeUntargeted = deviceReadiness.getDetectConnectedPlatformsCallCount();
  const untargeted = await otherProxy.callTool("routingProbe", { keepScreenAwake: false });
  expect(deviceReadiness.getDetectConnectedPlatformsCallCount()).toBe(scansBeforeUntargeted + 1);
  expect(untargeted.isError).toBe(true);
  expect(JSON.stringify(untargeted.content)).toContain("Multiple Android devices detected");
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
  expect(socket.testHooks.boundMcpClientFor("owner")?.sessionUuid).toBe(ownerSession);
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

function sessionFromResult(result: { content?: unknown }): string {
  const [first] = result.content as Array<{ text: string }>;
  return JSON.parse(first.text).runtime.session.sessionUuid;
}

function refusalCode(result: { content?: unknown }): unknown {
  const [first] = result.content as Array<{ text: string }>;
  return JSON.parse(first.text).code;
}

for (const autolock of ["1", "0"]) {
  const mode = autolock === "1" ? "autolock on" : "autolock off";

  test(`a control call naming another connection's session is refused and binds nothing (#11344, ${mode})`, async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock;
    const socket = newSocketServer();
    const ownerProxy = connect(socket, "owner");
    const otherProxy = connect(socket, "other");
    const ownerSession = sessionFromResult(await ownerProxy.callTool("getAndroid", {}));

    const named = await otherProxy.callTool("routingProbe", {
      sessionUuid: ownerSession,
      keepScreenAwake: false,
    });
    expect(named.isError).toBe(true);
    expect(refusalCode(named)).toBe("device_owned_by_other_session");
    expect(received).toEqual([]);
    expect(socket.testHooks.boundMcpClientFor("other")).toBeUndefined();

    const scansBeforeUntargeted = deviceReadiness.getDetectConnectedPlatformsCallCount();
    const untargeted = await otherProxy.callTool("routingProbe", { keepScreenAwake: false });
    expect(deviceReadiness.getDetectConnectedPlatformsCallCount()).toBe(scansBeforeUntargeted + 1);
    expect(untargeted.isError).toBe(true);
    expect(JSON.stringify(untargeted.content)).toContain("Multiple Android devices detected");
    const reachedOwnerDevice = !untargeted.isError && received.at(-1) === devices[0].deviceId;
    expect(reachedOwnerDevice).toBe(false);
  }, 30000);

  test(`a thrown call naming another connection's session leaves the caller on its own device (#11344, ${mode})`, async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock;
    const socket = newSocketServer();
    const ownerProxy = connect(socket, "owner");
    const otherProxy = connect(socket, "other");
    const ownerSession = sessionFromResult(await ownerProxy.callTool("getAndroid", {}));
    await otherProxy.callTool("getAndroid", { deviceId: devices[1].deviceId });

    await expect(
      otherProxy.callTool("routingProbe", { sessionUuid: ownerSession, keepScreenAwake: "no" }),
    ).rejects.toThrow();

    const untargeted = await otherProxy.callTool("routingProbe", { keepScreenAwake: false });
    expect(untargeted.isError).toBeFalsy();
    expect(received).toEqual([devices[1].deviceId]);
  }, 30000);

  test(`an explicit sessionUuid targets one call and leaves the connection's default alone (#11347, ${mode})`, async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock;
    const socket = newSocketServer();
    const proxy = connect(socket, "client");
    const first = sessionFromResult(
      await proxy.callTool("getAndroid", { deviceId: devices[0].deviceId }),
    );
    const second = sessionFromResult(
      await proxy.callTool("getAndroid", { deviceId: devices[1].deviceId }),
    );
    const selected = await proxy.callTool("setActiveDevice", { deviceId: devices[0].deviceId });
    expect(selected.isError).toBeFalsy();
    const socketRoute = () => socket.testHooks.boundMcpClientFor("client")?.sessionUuid;

    // The named session takes that one call ...
    await proxy.callTool("routingProbe", { sessionUuid: second, keepScreenAwake: false });
    expect(received).toEqual([devices[1].deviceId]);
    expect(socketRoute()).not.toBe(second);
    // ... and the untargeted call after it still runs on the selected device, in the proxy
    // (the session it forwards), the daemon socket (its route) and the daemon (the device).
    await proxy.callTool("routingProbe", { keepScreenAwake: false });
    expect(received).toEqual([devices[1].deviceId, devices[0].deviceId]);
    expect(socketRoute()).toBe(first);

    // Once the socket has a route, naming the other session again does not move it either.
    await proxy.callTool("routingProbe", { sessionUuid: second, keepScreenAwake: false });
    expect(socketRoute()).toBe(first);
    await proxy.callTool("routingProbe", { keepScreenAwake: false });
    expect(received.at(-1)).toBe(devices[0].deviceId);
    if (autolock === "1") {
      expect(pool.resolveAutolockSessionForMcpSession("client")).toBe(first);
    }
  }, 30000);
}
