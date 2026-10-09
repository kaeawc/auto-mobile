/**
 * #11096 item 1: one-shot `--cli` acquisitions through the daemon socket are anonymous, so the
 * owner's CLI idempotency decision (#2421, #11087) holds end to end: a second one-shot call for
 * the same device reuses the first call's session, while a device an MCP connection holds stays
 * refused to the CLI. Drives the real {@link UnixSocketServer}, real {@link DevicePool} and the
 * registered `getAndroid` handler; only the loopback MCP hop is replaced by a direct dispatch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up } from "../../src/db/migrations/2026_04_02_000_device_sessions";
import { up as addStableDeviceIdentity } from "../../src/db/migrations/2026_09_14_000_device_session_stable_identity";
import { up as addStableDeviceIdentityWriterFence } from "../../src/db/migrations/2026_09_14_001_device_session_identity_writer_fence";
import { up as addLivenessOwner } from "../../src/db/migrations/2026_09_16_000_device_session_liveness_owner";
import { up as addLivenessContract } from "../../src/db/migrations/2026_09_16_001_device_session_liveness_contract";
import { up as addLivenessWriterFence } from "../../src/db/migrations/2026_09_17_000_device_session_liveness_writer_fence";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { DAEMON_ONE_SHOT_CLI_PARAM } from "../../src/daemon/constants";
import { DaemonClient } from "../../src/daemon/client";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { getDeviceSessionIdFromResult } from "../../src/server/deviceSessionResult";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

const DEVICE_ID = "emulator-5554";
const AVD_NAME = "Agent_AVD";

interface Harness {
  db: Kysely<Database>;
  manager: SessionManager;
  pool: DevicePool;
  server: UnixSocketServer;
  socketPath: string;
  clients: DaemonClient[];
}

async function createHarness(): Promise<Harness> {
  const db = new Kysely<Database>({
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
  const timer = new FakeTimer();
  const barrier = new FakeDbWriteBarrier();
  const manager = new SessionManager(timer, repository, () => barrier);
  const devices = new FakeDeviceManager(
    [],
    [{ deviceId: DEVICE_ID, name: AVD_NAME, platform: "android" }],
  );
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "one-shot-cli-daemon", {
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager: devices,
      retryExecutor: new DefaultRetryExecutor(timer),
      deviceSessionRepository: repository,
      recoveryPolicy: { onLoss: false, maxAttempts: 2 },
      idGenerator: new FakeIdGenerator(),
      lifecycleCoordinator: new InMemoryVirtualDeviceLifecycleCoordinator(timer),
    }),
  );
  await pool.initializeWithDevices(devices.bootedDevices);

  const matcher = new FakeDeviceMatcher();
  const deviceUtils = new FakeDeviceUtils();
  deviceUtils.setBootedDevices("android", devices.bootedDevices);
  // The booted emulator's AVD is in the image inventory, so acquisitions resolve its source
  // image as they do on a real host (#11138).
  const image = {
    name: AVD_NAME,
    platform: "android" as const,
    isRunning: true,
    source: "local" as const,
  };
  deviceUtils.setDeviceImages("android", [image]);
  matcher.setImageResult(image);
  matcher.setBootedResult(devices.bootedDevices[0]);
  DaemonState.getInstance().initialize(manager, pool);
  setDeviceToolsDependencies({
    deviceManagerFactory: () => deviceUtils,
    deviceMatcherFactory: () => matcher,
    ensureCtrlProxyReady: async () => {},
    notifyResourcesChanged: async () => {},
    notifyDeviceInventoryResourcesChanged: async () => {},
    syncInstalledAppResourceRegistry: async () => false,
    timer,
    idGenerator: new FakeIdGenerator(),
    lifecycleCoordinator: new InMemoryVirtualDeviceLifecycleCoordinator(timer),
  });
  registerDeviceTools();

  const socketPath = join(tmpdir(), `one-shot-cli-${randomUUID()}.sock`);
  const server = new UnixSocketServer(
    socketPath,
    "http://localhost:0/mcp",
    DaemonState.getInstance(),
    new FakeTimer(),
  );
  // The loopback MCP hop dispatches straight to the registered handler with the arguments the
  // socket server forwards, internal markers included.
  server.mcpClientFactory = async () => ({
    callTool: async ({ name, arguments: args }: { name: string; arguments?: unknown }) =>
      await ToolRegistry.getTool(name)!.handler(args as Record<string, unknown>),
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    close: async () => {},
  });
  await server.start();
  return { db, manager, pool, server, socketPath, clients: [] };
}

function connect(h: Harness): DaemonClient {
  const client = new DaemonClient(h.socketPath, 5_000, undefined, {}, null);
  h.clients.push(client);
  return client;
}

/** A one-shot `--cli` invocation: its own connection, marked one-shot, closed afterwards. */
async function oneShotCliGetAndroid(
  h: Harness,
  target: Record<string, unknown> = { deviceId: DEVICE_ID },
): Promise<unknown> {
  const client = connect(h);
  try {
    return await client.callTool("getAndroid", {
      ...target,
      [DAEMON_ONE_SHOT_CLI_PARAM]: true,
    });
  } finally {
    await client.close();
  }
}

function errorText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return content?.map((entry) => entry.text ?? "").join("\n") ?? String(result);
}

async function settle<T>(promise: Promise<T>): Promise<T | Error> {
  return await promise.catch((error: unknown) => error as Error);
}

describe("one-shot CLI acquisition through the daemon socket (#11096)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await Promise.all(h.clients.map(async (client) => await client.close()));
    await h.server.close();
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    ToolRegistry.clearTools();
    h.manager.stopCleanupTimer();
    await h.db.destroy();
  });

  // #11138: an acquisition that resolves a source image (an AVD name, or a booted serial the pool
  // knows the AVD of) hit the "freshly started device" guard instead of the anonymous reuse.
  test.each([
    { name: "avdName", target: { avdName: AVD_NAME } },
    { name: "deviceId of an already-booted AVD", target: { deviceId: DEVICE_ID } },
  ])(
    "a second one-shot CLI getAndroid by $name reuses the first call's session",
    async ({ target }) => {
      const first = getDeviceSessionIdFromResult(await oneShotCliGetAndroid(h, target));
      expect(first).toBeDefined();

      const second = await settle(oneShotCliGetAndroid(h, target));

      expect(second).not.toBeInstanceOf(Error);
      expect(getDeviceSessionIdFromResult(second)).toBe(first);
      expect(h.pool.getDevice(DEVICE_ID)?.sessionId).toBe(first);
      expect(h.manager.getActiveSessionCount()).toBe(1);
    },
  );

  test("a device an MCP connection acquired by AVD name is refused to a one-shot CLI call", async () => {
    const mcp = connect(h);
    const held = getDeviceSessionIdFromResult(
      await mcp.callTool("getAndroid", { avdName: AVD_NAME }),
    );
    expect(held).toBeDefined();

    const refusal = await settle(oneShotCliGetAndroid(h, { avdName: AVD_NAME }));

    expect(getDeviceSessionIdFromResult(refusal)).toBeUndefined();
    const text = refusal instanceof Error ? refusal.message : errorText(refusal);
    expect(text).toContain("already assigned to another session");
    expect(h.pool.getDevice(DEVICE_ID)?.sessionId).toBe(held);
  });

  test("a device an MCP connection holds is refused to a one-shot CLI call", async () => {
    const mcp = connect(h);
    const held = getDeviceSessionIdFromResult(
      await mcp.callTool("getAndroid", { deviceId: DEVICE_ID }),
    );
    expect(held).toBeDefined();

    const refusal = await settle(oneShotCliGetAndroid(h));

    expect(getDeviceSessionIdFromResult(refusal)).toBeUndefined();
    const text = refusal instanceof Error ? refusal.message : errorText(refusal);
    expect(text).toContain("already assigned to another session");
    expect(h.pool.getDevice(DEVICE_ID)?.sessionId).toBe(held);
    expect(h.manager.getActiveSessionCount()).toBe(1);
  });

  test("an MCP connection is refused a device a one-shot CLI call holds", async () => {
    const held = getDeviceSessionIdFromResult(await oneShotCliGetAndroid(h));
    expect(held).toBeDefined();

    const mcp = connect(h);
    const refusal = await settle(mcp.callTool("getAndroid", { deviceId: DEVICE_ID }));

    expect(getDeviceSessionIdFromResult(refusal)).toBeUndefined();
    const text = refusal instanceof Error ? refusal.message : errorText(refusal);
    expect(text).toContain("already assigned to another session");
    expect(h.pool.getDevice(DEVICE_ID)?.sessionId).toBe(held);
  });
});
