import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { BootedDevice } from "../../src/models";
import { z } from "zod/v4";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

const AUTOLOCK_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
] as const;

function setAutolock(enabled: boolean): void {
  for (const key of AUTOLOCK_ENV_KEYS) {
    delete process.env[key];
  }
  if (enabled) {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
  }
}

describe("ToolRegistry autolock session enforcement", () => {
  const androidA: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };
  const androidB: BootedDevice = {
    name: "Pixel B",
    deviceId: "emulator-5556",
    platform: "android",
  };

  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;
  let daemonSessionManager: SessionManager | undefined;

  const schema = z.object({
    platform: z.enum(["ios", "android"]).optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
  });

  function registerTool(name: string) {
    ToolRegistry.registerDeviceAware(name, name, schema, async () => ({ success: true }));
    const tool = ToolRegistry.getTool(name);
    expect(tool).toBeDefined();
    return tool!;
  }

  beforeEach(() => {
    ToolRegistry.clearTools();
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    originalDeviceSessionManager = (ToolRegistry as any).deviceSessionManager;
    (ToolRegistry as any).deviceSessionManager = fakeDeviceSessionManager;
  });

  afterEach(() => {
    (ToolRegistry as any).deviceSessionManager = originalDeviceSessionManager;
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
    setAutolock(false);
  });

  test("requires sessionUuid when autolock is on and multiple Android devices exist", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const tool = registerTool("autolockMultiAndroid");

    await expect(tool.handler({ platform: "android" })).rejects.toThrow(
      "Device pool autolock is enabled and multiple devices are available.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("allows the call when a sessionUuid is provided", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const tool = registerTool("autolockWithSession");

    const response = await tool.handler({ platform: "android", sessionUuid: "session-123" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("allows the call when an explicit deviceId is provided", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const tool = registerTool("autolockWithDeviceId");

    const response = await tool.handler({ platform: "android", deviceId: "emulator-5556" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("does not require sessionUuid when only one Android device exists", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA]);

    const tool = registerTool("autolockSingleAndroid");

    const response = await tool.handler({ platform: "android" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("does not require sessionUuid when autolock is disabled, even with multiple devices", async () => {
    setAutolock(false);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const tool = registerTool("autolockDisabledMultiAndroid");

    const response = await tool.handler({ platform: "android" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("requires sessionUuid for platform 'either' when multiple devices exist", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const tool = registerTool("autolockEitherPlatform");

    await expect(tool.handler({})).rejects.toThrow(
      "Device pool autolock is enabled and multiple devices are available.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("allows the call when a device was pinned via setActiveDevice", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);
    fakeDeviceSessionManager.setCurrentDevice(androidA, "android");

    const tool = registerTool("autolockActiveDevice");

    const response = await tool.handler({ platform: "android" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("resolves the autolock session from the MCP session when sessionUuid is omitted", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA, androidB]);
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
    );
    await pool.initializeWithDevices([androidA, androidB]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    const sessionId = await pool.autolockDevice(androidA.deviceId, "android", "mcp-session-1");

    let handledDevice: BootedDevice | undefined;
    let handledArgs: Record<string, unknown> | undefined;
    ToolRegistry.registerDeviceAware(
      "implicitAutolockSession",
      "implicitAutolockSession",
      schema,
      async (device, args) => {
        handledDevice = device;
        handledArgs = args;
        return { success: true };
      },
    );
    const tool = ToolRegistry.getTool("implicitAutolockSession")!;

    const response = await tool.handler({
      platform: "android",
      keepScreenAwake: false,
      __mcpSessionId: "mcp-session-1",
    });

    expect(response).toEqual({ success: true });
    expect(handledDevice?.deviceId).toBe(androidA.deviceId);
    expect(handledArgs?.sessionUuid).toBe(sessionId);
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("resolves the MCP autolock session when the provided deviceId belongs to it", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA, androidB]);
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
    );
    await pool.initializeWithDevices([androidA, androidB]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    const sessionId = await pool.autolockDevice(androidA.deviceId, "android", "mcp-session-1");

    let handledDevice: BootedDevice | undefined;
    let handledArgs: Record<string, unknown> | undefined;
    ToolRegistry.registerDeviceAware(
      "implicitAutolockWithDeviceId",
      "implicitAutolockWithDeviceId",
      schema,
      async (device, args) => {
        handledDevice = device;
        handledArgs = args;
        return { success: true };
      },
    );
    const tool = ToolRegistry.getTool("implicitAutolockWithDeviceId")!;

    const response = await tool.handler({
      platform: "android",
      deviceId: androidA.deviceId,
      __mcpSessionId: "mcp-session-1",
    });

    expect(response).toEqual({ success: true });
    expect(handledDevice?.deviceId).toBe(androidA.deviceId);
    expect(handledArgs?.sessionUuid).toBe(sessionId);
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("does not apply an MCP autolock session to a different provided deviceId", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA, androidB]);
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
    );
    await pool.initializeWithDevices([androidA, androidB]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    await pool.autolockDevice(androidA.deviceId, "android", "mcp-session-1");
    await pool.autolockDevice(androidB.deviceId, "android", "mcp-session-2");

    const tool = registerTool("implicitAutolockDifferentDeviceId");

    await expect(
      tool.handler({
        platform: "android",
        deviceId: androidB.deviceId,
        __mcpSessionId: "mcp-session-1",
      }),
    ).rejects.toThrow("Device 'emulator-5556' is locked to another session.");
  });
});
