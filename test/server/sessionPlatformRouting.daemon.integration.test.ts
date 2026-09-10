import { UnixSocketServer } from "../../src/daemon/socketServer";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";
import { DaemonClient } from "../../src/daemon/client";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { DAEMON_VERSION } from "../../src/daemon/constants";
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
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import type { BootedDevice } from "../../src/models";

const devices: BootedDevice[] = [
  { name: "Pixel", deviceId: "emulator-5554", platform: "android" },
  { name: "iPhone", deviceId: "iphone", platform: "ios" },
  { name: "Pixel 2", deviceId: "emulator-5556", platform: "android" },
];
let db: Kysely<Database>;
let manager: SessionManager;
let pool: DevicePool;
let androidSession: string | undefined;
let iosSession: string | undefined;
let previousAutolock: string | undefined;
let originalRepository: unknown;

beforeEach(async () => {
  previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
  process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
  db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: new Sqlite(":memory:") }),
  });
  await up(db as Kysely<unknown>);
  const repository = new DeviceSessionRepository(db);
  const timer = new FakeTimer();
  manager = new SessionManager(timer, repository);
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [devices[0], devices[2]]);
  utils.setBootedDevices("ios", [devices[1]]);
  pool = new DevicePool(
    manager,
    "daemon",
    timer,
    new FakeInstalledAppsRepository(),
    utils,
    new DefaultRetryExecutor(timer),
    repository,
  );
  await pool.initializeWithDevices(devices);
  DaemonState.getInstance().initialize(manager, pool);
  ToolRegistry.clearTools();
  originalRepository = (ToolRegistry as any).toolCallRepository;
  (ToolRegistry as any).toolCallRepository = { recordToolCall: async () => {} };
});

afterEach(async () => {
  (ToolRegistry as any).toolCallRepository = originalRepository;
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

async function acquireBoth(): Promise<void> {
  androidSession = await pool.autolockDevice(devices[0].deviceId, "android", "client");
  iosSession = await pool.autolockDevice(devices[1].deviceId, "ios", "client");
}

test("daemon routes both platforms and explicit session wins over platform", async () => {
  await acquireBoth();
  const received: string[] = [];
  ToolRegistry.registerDeviceAware(
    "platformProbe",
    "platformProbe",
    z.object({}),
    async (device) => {
      received.push(device.deviceId);
      return { success: true };
    },
    { deviceReadiness: "booted" },
  );
  const tool = ToolRegistry.getTool("platformProbe")!;
  await tool.handler({ platform: "android", __mcpSessionId: "client", keepScreenAwake: false });
  await tool.handler({ platform: "ios", __mcpSessionId: "client", keepScreenAwake: false });
  await tool.handler({ platform: "ios", sessionUuid: androidSession, keepScreenAwake: false });
  expect(received).toEqual([devices[0].deviceId, devices[1].deviceId, devices[0].deviceId]);
}, 30000);

test("ambiguous platform names candidates and deviceId selects the matching owned session", async () => {
  await acquireBoth();
  expect(pool.resolveAutolockSessionForMcpSession("client", "android")).toBe(androidSession);
  expect(pool.resolveAutolockSessionForMcpSession("client", "ios")).toBe(iosSession);
  expect(pool.resolveAutolockSessionForMcpSession("other", "android")).toBeUndefined();
  const second = await pool.autolockDevice(devices[2].deviceId, "android", "client");
  expect(() => pool.resolveAutolockSessionForMcpSession("client", "android")).toThrow(
    `Candidate sessions: ${androidSession}`,
  );
  expect(
    pool.resolveAutolockSessionForMcpSession("client", "android", undefined, devices[2].deviceId),
  ).toBe(second);
}, 30000);

test("setActiveDevice selects an acquired session without an explicit UUID", async () => {
  await acquireBoth();
  registerUtilityTools();
  const result = await ToolRegistry.getTool("setActiveDevice")!.handler({
    deviceId: devices[0].deviceId,
    platform: "android",
    __mcpSessionId: "client",
  });
  expect(JSON.parse(result.content[0].text).sessionUuid).toBe(androidSession);
  expect(pool.resolveAutolockSessionForMcpSession("client")).toBe(androidSession);
}, 30000);

test("proxy and socket route through reused MCP clients using the socket-owned pool", async () => {
  const flags = spyOn(FeatureFlagService, "getInstance").mockReturnValue(
    new FeatureFlagService(new FakeFeatureFlagRepository(), new FakeFeatureFlagApplier()),
  );
  const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  const timer = new FakeTimer();
  const socket = new UnixSocketServer(
    "/private/tmp/unused-6807.sock",
    "http://localhost:0/mcp",
    DaemonState.getInstance(),
    timer,
  );
  const fixtures = new Map<string, McpTestFixture>();
  const received: string[] = [];
  const routes: string[] = [];
  let socketSessionId = "client";
  const dispatch = async (name: string, args: Record<string, unknown>) => {
    const request = { id: "routing", method: "tools/call", params: { name, arguments: args } };
    await (socket as any).restoreSelectorSessions(args, socketSessionId);
    const route = (socket as any).getMcpForwardRoute(request, socketSessionId);
    routes.push(route.clientKey);
    let fixture = fixtures.get(route.clientKey);
    if (!fixture) {
      fixture = new McpTestFixture({
        daemonMode: true,
        sessionToolSelectionService: {
          isEnabled: async (id, name, fallback) =>
            id && ["listDevices", "listDeviceImages"].includes(name) ? false : fallback,
          getOverride: async (id, name) =>
            id && ["listDevices", "listDeviceImages"].includes(name) ? false : undefined,
        },
        sessionContext: {
          sessionId: route.clientKey,
          initialSessionToolBinding: route.sessionUuid,
        },
      });
      await fixture.setup();
      fixtures.set(route.clientKey, fixture);
      for (const [toolName, device] of [
        ["getAndroid", devices[0]],
        ["getApple", devices[1]],
      ] as const) {
        ToolRegistry.register(toolName, toolName, z.object({}), async () => {
          const sessionUuid = await pool.autolockDevice(device.deviceId, device.platform, "client");
          return { content: [{ type: "text" as const, text: JSON.stringify({ sessionUuid }) }] };
        });
      }
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
    const forwarded = (socket as any).withSocketSessionAutolockKey(args, socketSessionId, 10000);
    const result = await fixture.client.callTool({ name, arguments: forwarded });
    (socket as any).recordBoundMcpClientKey(request, socketSessionId, route, true, result);
    return result;
  };
  const daemon = new FakeDaemonManager();
  daemon.statusResult = { ...daemon.statusResult, version: DAEMON_VERSION };
  const client = new FakeDaemonClient({ toolResultFor: dispatch });
  const proxy = new DaemonMcpProxy({
    clientFactory: () => client,
    daemonManager: daemon,
    autoStartDaemon: false,
    timer,
    staticToolDefinitionsProvider: () => [
      ...getStaticToolDefinitions(),
      { name: "routingProbe", inputSchema: { properties: { device: {}, sessionUuid: {} } } },
    ],
  });
  try {
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    for (const name of ["listDevices", "listDeviceImages"]) {
      await expect(proxy.callTool(name, { platform: "android" })).rejects.toThrow("disabled");
    }
    // Acquisition and execution intentionally share different internal MCP clients.
    expect(routes[0]).not.toBe(routes[1]);
    for (const args of [
      { platform: "android" },
      { platform: "ios" },
      { platform: "android", deviceId: devices[0].deviceId },
      { deviceId: devices[0].deviceId },
    ]) {
      await proxy.callTool("routingProbe", { ...args, keepScreenAwake: false });
    }
    // A replacement socket must recover both acquisitions before selector routing.
    socketSessionId = "replacement-client";
    client.emitConnectionClosed();

    await proxy.callTool("routingProbe", { platform: "android", keepScreenAwake: false });
    await proxy.callTool("routingProbe", { platform: "ios", keepScreenAwake: false });
    const android = pool.resolveAutolockSessionForMcpSession(socketSessionId, "android");
    await proxy.callTool("routingProbe", {
      sessionUuid: android,
      platform: "ios",
      keepScreenAwake: false,
    });
    await proxy.callTool("routingProbe", {
      sessionUuid: android,
      platform: "ios",
      keepScreenAwake: false,
    });
    await proxy.callTool("setActiveDevice", { deviceId: devices[0].deviceId, platform: "android" });
    expect(pool.resolveAutolockSessionForMcpSession(socketSessionId)).toBe(android);
    await proxy.callTool("routingProbe", { keepScreenAwake: false });
    expect(received).toEqual([
      devices[0].deviceId,
      devices[1].deviceId,
      devices[0].deviceId,
      devices[0].deviceId,
      devices[0].deviceId,
      devices[1].deviceId,
      devices[0].deviceId,
      devices[0].deviceId,
      devices[0].deviceId,
    ]);
    const pinned = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: daemon,
      autoStartDaemon: false,
      timer,
      initialSessionUuid: pool.resolveAutolockSessionForMcpSession("client", "ios"),
    });
    try {
      await expect(
        pinned.callTool("routingProbe", {
          platform: "android",
          deviceId: devices[0].deviceId,
          keepScreenAwake: false,
        }),
      ).rejects.toThrow("does not match");
    } finally {
      await pinned.close();
    }
    const apple = pool.resolveAutolockSessionForMcpSession(socketSessionId, "ios")!;
    // Releasing the default must not fence a different, still-owned session.
    await proxy.callTool("setActiveDevice", { deviceId: devices[1].deviceId, platform: "ios" });
    await manager.releaseSession(apple, "heartbeat-timeout");
    await pool.releaseDevice(devices[1].deviceId, apple);
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, apple, "heartbeat-timeout");
    await expect(
      proxy.callTool("routingProbe", { platform: "ios", keepScreenAwake: false }),
    ).rejects.toThrow();
    await expect(proxy.callTool("routingProbe", {})).rejects.toThrow();
    await expect(proxy.callTool("routingProbe", { sessionUuid: apple })).rejects.toThrow();
    await proxy.callTool("routingProbe", { platform: "android", keepScreenAwake: false });
    await proxy.callTool("routingProbe", { sessionUuid: android, keepScreenAwake: false });

    expect(received.slice(-2)).toEqual([devices[0].deviceId, devices[0].deviceId]);
    const staleResult = await proxy.callTool("routingProbe", {
      sessionUuid: apple,
      keepScreenAwake: false,
    });
    expect(staleResult.isError).toBe(true);
    expect(received.slice(-2)).toEqual([devices[0].deviceId, devices[0].deviceId]);
    expect(manager.getSession(apple)).toBeNull();
    await proxy.callTool("setActiveDevice", { deviceId: devices[2].deviceId, platform: "android" });
    await proxy.callTool("routingProbe", { keepScreenAwake: false });
    expect(received.at(-1)).toBe(devices[2].deviceId);
  } finally {
    await proxy.close();
    for (const fixture of fixtures.values()) {
      await fixture.teardown();
    }
    available.mockRestore();
    flags.mockRestore();
  }
}, 30000);

test("setActiveDevice rebinds the current session to an unacquired free device", async () => {
  await acquireBoth();
  registerUtilityTools();
  const result = await ToolRegistry.getTool("setActiveDevice")!.handler({
    deviceId: devices[2].deviceId,
    platform: "android",
    __mcpSessionId: "client",
  });
  expect(JSON.parse(result.content[0].text).sessionUuid).toBe(iosSession);
  expect(manager.getSession(iosSession!)?.assignedDevice).toBe(devices[2].deviceId);
  expect(pool.resolveAutolockSessionForMcpSession("client")).toBe(iosSession);
}, 30000);

test("restoring retained sessions preserves an already changed default", async () => {
  await acquireBoth();
  await pool.attachAutolockSessionToMcpSession(androidSession!, "client");
  await pool.restoreAutolockSessionsForMcpSession([androidSession!, iosSession!], "client");
  expect(pool.resolveAutolockSessionForMcpSession("client")).toBe(androidSession);
});
