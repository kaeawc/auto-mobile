import { beforeAll, describe, expect, spyOn } from "bun:test";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/wire/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/daemon/videoRecordingManager";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { warmedTests } from "../helpers/warmedTests";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/** Records each platform kill and stops there: a recorded kill proves the call got past every gate. */
class RecordingKillDeviceManager extends FakeDeviceUtils {
  readonly killed: string[] = [];

  override async killDevice(device: BootedDevice): Promise<void> {
    this.killed.push(device.deviceId);
    throw new Error("platform kill reached");
  }
}

const held: BootedDevice = { name: "iPhone A", deviceId: "IOS-HELD", platform: "ios" };
const free: BootedDevice = { name: "iPhone B", deviceId: "IOS-FREE", platform: "ios" };
const HOLDER = "holder-session";
const OWNER = "conn-1";
const OTHER = "conn-2";

function wire(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as { text: string }[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

/**
 * #11542: the MCP ingress applies the #11344 owner rule ("a control call naming a session another
 * connected client owns is refused, and naming it neither extends nor binds it") to plain tools
 * (`ToolRegistry.register`: killDevice, deleteDevice, ...) as well as device-aware ones. Admitted
 * on the named session instead, the lifecycle holder gate would see the caller as the holder.
 */
describe("a plain control tool naming a session another connection owns", () => {
  let manager: RecordingKillDeviceManager;
  let sessionManager: SessionManager;
  let timer: FakeTimer;
  let fixture: McpTestFixture | undefined;
  let restorePipeline: () => void;
  let spies: Array<ReturnType<typeof spyOn>> = [];
  let harnessArranged = false;
  let previousAutolock: string | undefined;

  const call = (args: Record<string, unknown>) =>
    fixture!.client.callTool({ name: "killDevice", arguments: args });

  beforeAll(async () => {
    // Pay the server module's cold import outside any test's budget.
    const restore = installHermeticServerFixture();
    const warm = new McpTestFixture({ daemonMode: true });
    await warm.setup();
    await warm.teardown();
    restore();
  });

  async function arrangeHarness(): Promise<void> {
    harnessArranged = true;
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    ToolRegistry.clearTools();
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    timer = new FakeTimer();
    manager = new RecordingKillDeviceManager();
    manager.setBootedDevices("ios", [held, free]);
    manager.setBootedDevices("android", []);
    PlatformDeviceManagerFactory.setInstance(manager);
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: { listRecordings: async () => [] } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "plain-tool-foreign-session", {
        timer,
        deviceManager: manager,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    // OWNER's connection acquires the session that holds the device.
    await pool.bindOrReuseDeviceSession({
      sessionId: HOLDER,
      deviceId: held.deviceId,
      platform: "ios",
      allowSessionRebind: false,
      mcpSessionId: OWNER,
    });
    registerDeviceTools();
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
  }

  async function teardownHarness(): Promise<void> {
    if (!harnessArranged) {
      return;
    }
    harnessArranged = false;
    await fixture?.teardown();
    fixture = undefined;
    ToolRegistry.clearTools();
    restorePipeline();
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    PlatformDeviceManagerFactory.setInstance(null);
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  }

  // First-use costs (the tool call path, the refusal) are paid in beforeAll. The DevicePool
  // harness is still built inside each test, so its cost is paid in the test body.
  const test = warmedTests(teardownHarness);
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  arranged(
    "the setup: another connection is foreign to the session, and its sessionless kill is refused",
    async () => {
      const pool = DaemonState.getInstance().getDevicePool();
      expect(pool.isSessionOwnedByOtherConnection(HOLDER, OTHER)).toBe(true);

      const result = await call({ device: held, [INTERNAL_MCP_SESSION_PARAM]: OTHER });

      expect(result.isError).toBe(true);
      expect(wire(result).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(manager.killed).toEqual([]);
    },
  );

  arranged(
    "killDevice naming the owner's session from another connection is refused, not run",
    async () => {
      const result = await call({
        device: held,
        sessionUuid: HOLDER,
        [INTERNAL_MCP_SESSION_PARAM]: OTHER,
      });

      // No shutdown work reaches the device the other connection's session holds.
      expect(manager.killed).toEqual([]);
      expect(result.isError).toBe(true);
      expect(wire(result).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    },
  );

  arranged(
    "a plain control call naming the owner's session from another connection does not extend it",
    async () => {
      const before = sessionManager.getSession(HOLDER)!.lastUsedAt;
      timer.advanceTime(60_000);

      // Another connection kills an unheld device and merely names the owner's session.
      await call({ device: free, sessionUuid: HOLDER, [INTERNAL_MCP_SESSION_PARAM]: OTHER });

      expect(sessionManager.getSession(HOLDER)!.lastUsedAt).toBe(before);
    },
  );

  arranged(
    "force overrides the holder check, not the naming of another connection's session",
    async () => {
      const named = await call({
        device: held,
        force: true,
        sessionUuid: HOLDER,
        [INTERNAL_MCP_SESSION_PARAM]: OTHER,
      });

      expect(wire(named).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      // The remedy names the way to force-stop the device (#11555).
      expect(JSON.stringify(named.content)).toContain("leave sessionUuid out");
      expect(manager.killed).toEqual([]);

      await call({ device: held, force: true, [INTERNAL_MCP_SESSION_PARAM]: OTHER });

      expect(manager.killed).toEqual([held.deviceId]);
    },
  );

  arranged("the owner's own killDevice naming its session still reaches the device", async () => {
    await call({ device: held, sessionUuid: HOLDER, [INTERNAL_MCP_SESSION_PARAM]: OWNER });

    expect(manager.killed).toEqual([held.deviceId]);
  });

  arranged(
    "a plain read naming the owner's session from another connection is not refused",
    async () => {
      const before = sessionManager.getSession(HOLDER)!.lastUsedAt;
      timer.advanceTime(60_000);

      const result = await fixture!.client.callTool({
        name: "listDevices",
        arguments: { platform: "ios", sessionUuid: HOLDER, [INTERNAL_MCP_SESSION_PARAM]: OTHER },
      });

      expect(result.isError).not.toBe(true);
      expect(sessionManager.getSession(HOLDER)!.lastUsedAt).toBe(before);
    },
  );

  arranged("once the owner has disconnected another connection may name the session", async () => {
    DaemonState.getInstance().getDevicePool().releaseMcpSessionBindings(OWNER);

    await call({ device: held, sessionUuid: HOLDER, [INTERNAL_MCP_SESSION_PARAM]: OTHER });

    expect(manager.killed).toEqual([held.deviceId]);
  });
});
