import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";

describe("ToolRegistry Android session context", () => {
  const androidDeviceA: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };
  const androidDeviceB: BootedDevice = {
    name: "Pixel B",
    deviceId: "emulator-5556",
    platform: "android",
  };
  const iosDeviceA: BootedDevice = {
    name: "iPhone A",
    deviceId: "ios-device-a",
    platform: "ios",
  };
  const iosDeviceB: BootedDevice = {
    name: "iPhone B",
    deviceId: "ios-device-b",
    platform: "ios",
  };

  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;

  const schema = z.object({
    platform: z.enum(["ios", "android"]).optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
  });

  function registerTool(name: string) {
    ToolRegistry.registerDeviceAware(name, name, schema, async (device) => ({
      success: true,
      deviceId: device.deviceId,
    }));
    return ToolRegistry.getTool(name)!;
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
  });

  test("requires sessionUuid when multiple Android devices are booted", async () => {
    fakeDeviceSessionManager.setConnectedDevices([androidDeviceA, androidDeviceB]);
    const tool = registerTool("androidSessionRequiredTool");

    await expect(tool.handler({ platform: "android" })).rejects.toThrow(
      "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("requires sessionUuid for platform either when only multiple Android devices exist", async () => {
    fakeDeviceSessionManager.setConnectedDevices([androidDeviceA, androidDeviceB]);
    const tool = registerTool("androidEitherSessionRequiredTool");

    await expect(tool.handler({})).rejects.toThrow(
      "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("allows sessionUuid when multiple Android devices are booted", async () => {
    fakeDeviceSessionManager.setConnectedDevices([androidDeviceA, androidDeviceB]);
    const tool = registerTool("androidSessionAllowedTool");

    const response = await tool.handler({ platform: "android", sessionUuid: "session-123" });

    expect(response).toEqual({ success: true, deviceId: androidDeviceA.deviceId });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("allows explicit deviceId when multiple Android devices are booted", async () => {
    fakeDeviceSessionManager.setConnectedDevices([androidDeviceA, androidDeviceB]);
    const tool = registerTool("androidDeviceIdAllowedTool");

    const response = await tool.handler({
      platform: "android",
      deviceId: androidDeviceB.deviceId,
    });

    expect(response).toEqual({ success: true, deviceId: androidDeviceB.deviceId });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("allows the already-active Android device for a named platform", async () => {
    fakeDeviceSessionManager.setConnectedDevices([androidDeviceA, androidDeviceB]);
    fakeDeviceSessionManager.setCurrentDevice(androidDeviceB, "android");
    const tool = registerTool("androidActiveDeviceTool");

    const response = await tool.handler({ platform: "android" });

    expect(response).toEqual({ success: true, deviceId: androidDeviceB.deviceId });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("allows a single Android device without an explicit target", async () => {
    fakeDeviceSessionManager.setConnectedDevices([androidDeviceA]);
    const tool = registerTool("androidSingleDeviceTool");

    const response = await tool.handler({ platform: "android" });

    expect(response).toEqual({ success: true, deviceId: androidDeviceA.deviceId });
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("prevents Android first-win state from poisoning a later unqualified tapAt", async () => {
    fakeDeviceSessionManager.setConnectedDevices([
      androidDeviceA,
      androidDeviceB,
      iosDeviceA,
      iosDeviceB,
    ]);
    const platformScopedTool = registerTool("androidSelectionProbe");

    await expect(platformScopedTool.handler({ platform: "android" })).rejects.toThrow(
      "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
    expect(fakeDeviceSessionManager.getCurrentDevice()).toBeUndefined();

    registerInteractionTools();
    const tapAt = ToolRegistry.getTool("tapAt")!;

    await expect(tapAt.handler({ x: 10, y: 20 })).rejects.toThrow(
      "Both Android and iOS devices are connected. For a device tool call, pass sessionUuid (from getAndroid/getApple), platform, or a bound device label on this call to select the target. Alternatively, call setActiveDevice to select an active device.",
    );
    expect(fakeDeviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(1);
  });
});
