import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  INTERNAL_EXECUTION_ID_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_MCP_SESSION_PARAM,
} from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { subscribeToolCallEndActivity } from "../../src/daemon/toolCallActivity";
import type { BootedDevice } from "../../src/models";
import { executionTracker } from "../../src/server/executionTracker";
import { ToolRegistry, type RegisteredTool } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { RealToolCallPath } from "../helpers/realToolCallPath";

const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const HOLDER = "sess-a";
/** A live session no connection owns: its acquiring call carried no connection identity. */
const OWNERLESS = "sess-ownerless";
const OWNER = "conn-1";
const OTHER = "conn-2";

type Args = Record<string, unknown>;

/**
 * One schema-valid call per plain tool (two for a tool classified per call), each naming the
 * session. The first test below fails when the server registers a plain tool this table lacks.
 */
const PLAIN_TOOL_CALLS: Record<string, Args[]> = {
  setActiveDevice: [{ deviceId: free.deviceId, platform: "android" }],
  listDeviceImages: [{ platform: "android" }],
  listDevices: [{}],
  getAndroid: [{ avdName: "Pixel_A" }],
  getApple: [{ udid: "SIM-UDID" }],
  startDevice: [{ platform: "android", name: "Pixel_A" }],
  provisionDevice: [
    {
      device: {
        platform: "android",
        name: "Pixel_A",
        spec: { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_9" },
      },
    },
  ],
  killDevice: [{ device: free }],
  deleteDevice: [
    {
      target: { platform: "android", isVirtual: true, stableId: "Pixel_B" },
      mode: "destroy",
      verifyAbsence: true,
    },
  ],
  exportPlan: [{}],
  recordSteps: [{ action: "status" }, { action: "begin" }, { action: "end" }],
  getIosSimulatorCapabilities: [{ deviceType: "iPhone 16", runtime: "iOS 18.0" }],
  setToolEnabled: [{ toolName: "tapOn", enabled: false }],
};
const PLAIN_TOOL_CASES = Object.entries(PLAIN_TOOL_CALLS).flatMap(([name, calls]) =>
  calls.map((args) => ({ name, args, title: `${name} ${JSON.stringify(args)}` })),
);

/**
 * #11555: naming a session is not use of it. Only the session's own client, or a control call
 * that actually runs on the session, restarts its idle window; while another connected client
 * owns the session, no call from this connection moves its activity clocks, at its start or at
 * its end, and none binds this connection to it. Every plain tool is driven through the real MCP
 * ingress (its handler stubbed at the registry); device reads run the real device pipeline.
 */
describe("a call naming a session another connection owns is not use of it (#11555)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let fixture: McpTestFixture | undefined;
  let unsubscribe: () => void;
  let spies: Array<ReturnType<typeof spyOn>>;
  let previousAutolock: string | undefined;
  /** Stubbed plain handlers that ran. */
  let handled: string[];

  const clocks = (sessionUuid = HOLDER) => {
    const session = manager.getSession(sessionUuid)!;
    return {
      lastUsedAt: session.lastUsedAt,
      lastHeartbeat: session.lastHeartbeat,
      expiresAt: session.expiresAt,
      ownership: session.ownership,
    };
  };
  const call = (name: string, args: Args, connection: string | undefined, sessionUuid = HOLDER) =>
    fixture!.client.callTool({
      name,
      arguments: {
        ...args,
        sessionUuid,
        ...(connection ? { [INTERNAL_MCP_SESSION_PARAM]: connection } : {}),
      },
    });
  /** A device-aware tool's registered handler under a tracked execution, as the ingress runs it. */
  const runDeviceTool = async (tool: RegisteredTool, args: Args): Promise<void> => {
    const execution = executionTracker.startExecution(tool.name, OTHER, HOLDER);
    try {
      await tool.handler(
        {
          ...args,
          [INTERNAL_EXECUTION_ID_PARAM]: execution.id,
          [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
        },
        undefined,
        execution.abortController.signal,
      );
    } finally {
      executionTracker.endExecution(execution.id);
    }
  };
  const plainTools = (): RegisteredTool[] =>
    ToolRegistry.getEveryRegisteredTool().filter((tool) => !tool.requiresDevice);

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
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), () => {
      return new FakeDbWriteBarrier();
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held, free]);
    discovery.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(discovery);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "named-foreign-session-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    unsubscribe = subscribeToolCallEndActivity(executionTracker, manager, pool);
    tools = new RealToolCallPath([held, free]).install();
    await pool.bindOrReuseDeviceSession(
      HOLDER,
      held.deviceId,
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
    manager.setDeviceReadiness(HOLDER, "automationReady");
    await pool.bindOrReuseDeviceSession(OWNERLESS, free.deviceId, "android");
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
    // The server registered its real tools. A plain tool's handler is its device work: stub it,
    // so only the ingress (classification, refusal, admission, the execution's end) is real.
    handled = [];
    for (const tool of plainTools()) {
      tool.handler = async () => {
        handled.push(tool.name);
        return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
      };
    }
  });

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    unsubscribe();
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

  test("the table covers every plain tool the server registers, with schema-valid calls", () => {
    const registered = plainTools();

    expect(Object.keys(PLAIN_TOOL_CALLS).sort()).toEqual(
      registered.map((tool) => tool.name).sort(),
    );
    const invalid = registered.flatMap((tool) =>
      PLAIN_TOOL_CALLS[tool.name]
        .filter((args) => !tool.schema.safeParse(args).success)
        .map((args) => `${tool.name} ${JSON.stringify(args)}`),
    );
    expect(invalid).toEqual([]);
  });

  describe("from another connection", () => {
    test.each(PLAIN_TOOL_CASES)("$title neither extends nor binds it", async ({ name, args }) => {
      const before = clocks();
      timer.advanceTime(60_000);

      await call(name, args, OTHER);

      expect(clocks()).toEqual(before);
      expect(pool.isSessionOwnedByOtherConnection(HOLDER, OTHER)).toBe(true);
      expect(pool.isSessionOwnedByOtherConnection(HOLDER, OWNER)).toBe(false);
    });

    test("setToolEnabled still runs: editing another session's tool profile is intended", async () => {
      const result = await call("setToolEnabled", { toolName: "tapOn", enabled: false }, OTHER);

      expect(result.isError).not.toBe(true);
      expect(handled).toEqual(["setToolEnabled"]);
    });

    test("every device read runs and neither extends nor binds it", async () => {
      const reads = ToolRegistry.getEveryRegisteredTool().filter(
        (tool) => tool.requiresDevice && tool.deviceReadOnly === true,
      );
      expect(reads.length).toBeGreaterThan(10);
      const before = clocks();
      timer.advanceTime(60_000);

      const failures: string[] = [];
      for (const tool of reads) {
        await runDeviceTool(tool, {
          sessionUuid: HOLDER,
          platform: "android",
          [INTERNAL_MCP_SESSION_PARAM]: OTHER,
        }).catch((error: unknown) => failures.push(`${tool.name}: ${String(error)}`));
      }

      expect(failures).toEqual([]);
      expect(tools.runs.map((run) => run.name).sort()).toEqual(
        reads.map((tool) => tool.name).sort(),
      );
      expect(clocks()).toEqual(before);
      expect(pool.isSessionOwnedByOtherConnection(HOLDER, OTHER)).toBe(true);
    });
  });

  describe("the session's own use still counts", () => {
    test.each(["setToolEnabled", "killDevice", "exportPlan"])(
      "the owner's %s naming its session restarts the idle window",
      async (name) => {
        const before = clocks();
        timer.advanceTime(60_000);

        await call(name, PLAIN_TOOL_CALLS[name][0], OWNER);

        expect(handled).toEqual([name]);
        expect(clocks().lastUsedAt).toBe(before.lastUsedAt + 60_000);
        expect(clocks().expiresAt).toBe(before.expiresAt + 60_000);
      },
    );

    test("a session no connection owns is still used by a call that names it, as before", async () => {
      expect(pool.isSessionOwnedByOtherConnection(OWNERLESS, OTHER)).toBe(false);
      const before = clocks(OWNERLESS);
      timer.advanceTime(60_000);

      await call("setToolEnabled", PLAIN_TOOL_CALLS.setToolEnabled[0], OTHER, OWNERLESS);

      expect(clocks(OWNERLESS).lastUsedAt).toBe(before.lastUsedAt + 60_000);
    });

    test("a caller with no connection identity is not told apart from the owner", async () => {
      const before = clocks();
      timer.advanceTime(60_000);

      await call("setToolEnabled", PLAIN_TOOL_CALLS.setToolEnabled[0], undefined);

      expect(clocks().lastUsedAt).toBe(before.lastUsedAt + 60_000);
    });
  });
});
