import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { BootedDevice } from "../../src/models";
import { z } from "zod";

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
  const androidA: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const androidB: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };

  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;

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
    setAutolock(false);
  });

  test("requires sessionUuid when autolock is on and multiple Android devices exist", async () => {
    setAutolock(true);
    fakeDeviceSessionManager.setConnectedDevices([androidA, androidB]);

    const tool = registerTool("autolockMultiAndroid");

    await expect(tool.handler({ platform: "android" })).rejects.toThrow(
      "Device pool autolock is enabled and multiple devices are available."
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
      "Device pool autolock is enabled and multiple devices are available."
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
});
