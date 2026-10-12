import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DAEMON_OWNED_SESSIONS_PARAM,
  INTERNAL_MCP_SESSION_PARAM,
} from "../../src/daemon/constants";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { BootedDevice } from "../../src/models";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { asPlanAllocation } from "../helpers/planLabelAllocation";
import { RealToolCallPath } from "../helpers/realToolCallPath";

// #11586: a direct-socket client names the owner's derived `${base}:${label}` session in its
// owned-sessions selector. Restoring it must be judged as restoring its base.

const primary: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const labelled: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const BASE = "sess-a";
const OWNER = "conn-1";
const OTHER = "conn-2";

/** The socket server's private restore step: where the owned-sessions selector is consumed. */
interface RestoreSeam {
  restoreSelectorSessions(args: unknown, socketSessionId: string): Promise<void>;
}

function wire(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as { text: string }[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("restoring a derived label session through the owned-sessions selector", () => {
  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let fixture: McpTestFixture | undefined;
  let spies: Array<ReturnType<typeof spyOn>>;
  let previousAutolock: string | undefined;
  let labelSession: string;
  let socketServer: UnixSocketServer;

  /** A socket `tools/call` from `connection` whose arguments carry the owned-sessions selector. */
  const socketRestore = (connection: string, args: Record<string, unknown>): Promise<void> =>
    (socketServer as unknown as RestoreSeam).restoreSelectorSessions(
      { ...args, [DAEMON_OWNED_SESSIONS_PARAM]: [labelSession] },
      connection,
    );

  const tap = (connection: string, args: Record<string, unknown>) =>
    fixture!.client.callTool({
      name: "tapAt",
      arguments: { x: 10, y: 10, ...args, [INTERNAL_MCP_SESSION_PARAM]: connection },
    });

  beforeAll(async () => {
    // Pay the server module's cold import outside any test's budget.
    const restore = installHermeticServerFixture();
    const warm = new McpTestFixture({ daemonMode: true });
    await warm.setup();
    await warm.teardown();
    restore();
  });

  beforeEach(async () => {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    const timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), () => {
      return new FakeDbWriteBarrier();
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [primary, labelled]);
    discovery.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(discovery);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "label-restore-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([primary, labelled]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    tools = new RealToolCallPath([primary, labelled]).install();
    await pool.bindOrReuseDeviceSession(
      BASE,
      primary.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      OWNER,
    );
    const labels = buildDeviceLabelMap(["A", "B"], BASE);
    labelSession = labels.B;
    manager.setDeviceLabels(BASE, labels);
    await asPlanAllocation(manager, BASE, [labelSession], () =>
      pool.assignMultipleDevices([labelSession], 1_000, "android"),
    );
    socketServer = new UnixSocketServer(
      "/tmp/never-listened.sock",
      "http://localhost:0/mcp",
      { isInitialized: () => true, getDevicePool: () => pool } as unknown as DaemonStateAccess,
      timer,
    );
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
  });

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    tools.uninstall();
    PlatformDeviceManagerFactory.setInstance(null);
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  });

  test("another connection's call naming the derived session is refused at the restore", async () => {
    await expect(socketRestore(OTHER, { sessionUuid: labelSession })).rejects.toMatchObject({
      code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
    });
  });

  test("the owner still drives its labelled device by label after another connection tried to restore it", async () => {
    await socketRestore(OTHER, { deviceId: primary.deviceId }).catch(() => {});

    const result = await tap(OWNER, { sessionUuid: BASE, device: "B" });

    expect(result.isError).not.toBe(true);
    expect(tools.runs.map((run) => run.deviceId)).toEqual([labelled.deviceId]);
  });

  test("the owner still drives its labelled device by session name after that restore", async () => {
    await socketRestore(OTHER, { deviceId: primary.deviceId }).catch(() => {});

    const result = await tap(OWNER, { sessionUuid: labelSession });

    expect(result.isError).not.toBe(true);
    expect(tools.runs.map((run) => run.deviceId)).toEqual([labelled.deviceId]);
  });

  test("the other connection gains nothing from the refused restore", async () => {
    await socketRestore(OTHER, { deviceId: primary.deviceId }).catch(() => {});

    const result = await tap(OTHER, { sessionUuid: labelSession });

    expect(tools.runs).toEqual([]);
    expect(wire(result).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(pool.resolveOwnedDeviceSessionForMcpSession(OTHER, labelled.deviceId)).toBeUndefined();
  });

  test("the owner's own selector naming its derived session restores nothing new and is not refused", async () => {
    await socketRestore(OWNER, { sessionUuid: labelSession });

    expect(pool.isSessionOwnedByOtherConnection(BASE, OWNER)).toBe(false);
    expect(pool.isSessionOwnedByOtherConnection(BASE, OTHER)).toBe(true);
    expect(pool.isSessionOwnedByOtherConnection(labelSession, OTHER)).toBe(true);
  });
});
