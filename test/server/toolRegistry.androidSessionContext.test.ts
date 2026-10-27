import {
  registerDirectSessionDevice,
  unregisterDirectSession,
} from "../../src/utils/directSessionDeviceRegistry";
import { AmbiguousDeviceTargetError } from "../../src/daemon/ambiguousDeviceTargetRefusal";
import { shapeToolCallError } from "../../src/daemon/shapeToolCallError";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { ToolRegistry, type ToolRegistryCollaborators } from "../../src/server/toolRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

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

  let fakeDeviceReadiness: FakeDeviceReadiness;
  let originalCollaborators: ToolRegistryCollaborators;
  let restorePipelineOverrides: (() => void) | undefined;

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
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    fakeDeviceReadiness = new FakeDeviceReadiness();
    originalCollaborators = ToolRegistry.getCollaboratorsForTesting();
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: fakeDeviceReadiness });
  });

  afterEach(() => {
    unregisterDirectSession("session-123");
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    ToolRegistry.setCollaboratorsForTesting(originalCollaborators);
    ToolRegistry.clearTools();
  });

  test("requires sessionUuid when multiple Android devices are booted", async () => {
    fakeDeviceReadiness.setConnectedDevices([androidDeviceA, androidDeviceB]);
    const tool = registerTool("androidSessionRequiredTool");

    const error = await tool.handler({ platform: "android" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AmbiguousDeviceTargetError);
    expect((error as Error).message).toContain(
      "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
    expect(
      JSON.parse(shapeToolCallError(error, { toolName: tool.name, source: "MCP" }).content[0].text),
    ).toMatchObject({
      code: "ambiguous_device_target",
      retryable: false,
      candidates: [
        { deviceId: androidDeviceA.deviceId, platform: "android" },
        { deviceId: androidDeviceB.deviceId, platform: "android" },
      ],
    });
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("requires sessionUuid for platform either when only multiple Android devices exist", async () => {
    fakeDeviceReadiness.setConnectedDevices([androidDeviceA, androidDeviceB]);
    const tool = registerTool("androidEitherSessionRequiredTool");

    await expect(tool.handler({})).rejects.toThrow(
      "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("allows sessionUuid when multiple Android devices are booted", async () => {
    fakeDeviceReadiness.setConnectedDevices([androidDeviceA, androidDeviceB]);
    const tool = registerTool("androidSessionAllowedTool");
    registerDirectSessionDevice("session-123", androidDeviceA);

    const response = await tool.handler({ platform: "android", sessionUuid: "session-123" });

    expect(response).toEqual({ success: true, deviceId: androidDeviceA.deviceId });
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("allows explicit deviceId when multiple Android devices are booted", async () => {
    fakeDeviceReadiness.setConnectedDevices([androidDeviceA, androidDeviceB]);
    const tool = registerTool("androidDeviceIdAllowedTool");

    const response = await tool.handler({
      platform: "android",
      deviceId: androidDeviceB.deviceId,
    });

    expect(response).toEqual({ success: true, deviceId: androidDeviceB.deviceId });
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("allows an explicitly pinned Android device for a named platform", async () => {
    fakeDeviceReadiness.setConnectedDevices([androidDeviceA, androidDeviceB]);
    fakeDeviceReadiness.setExplicitDevicePin(androidDeviceB);
    fakeDeviceReadiness.setExplicitDevicePin(androidDeviceB);
    const tool = registerTool("androidActiveDeviceTool");

    const response = await tool.handler({ platform: "android" });

    expect(response).toEqual({ success: true, deviceId: androidDeviceB.deviceId });
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("keeps an Android pin when its scan fails", async () => {
    fakeDeviceReadiness.setConnectedDevices([androidDeviceA, androidDeviceB, iosDeviceA]);
    fakeDeviceReadiness.setExplicitDevicePin(androidDeviceB);
    fakeDeviceReadiness.setExplicitDevicePin(androidDeviceB);
    fakeDeviceReadiness.setPlatformScanFailure("android", true);
    const tool = registerTool("androidFailedScanPinTool");

    await tool.handler({ platform: "android" });

    expect(fakeDeviceReadiness.getExplicitDevicePin()).toEqual(androidDeviceB);
  });

  test("allows a single Android device without an explicit target", async () => {
    fakeDeviceReadiness.setConnectedDevices([androidDeviceA]);
    const tool = registerTool("androidSingleDeviceTool");

    const response = await tool.handler({ platform: "android" });

    expect(response).toEqual({ success: true, deviceId: androidDeviceA.deviceId });
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("prevents Android first-win state from poisoning a later unqualified tapAt", async () => {
    fakeDeviceReadiness.setConnectedDevices([
      androidDeviceA,
      androidDeviceB,
      iosDeviceA,
      iosDeviceB,
    ]);
    const platformScopedTool = registerTool("androidSelectionProbe");

    await expect(platformScopedTool.handler({ platform: "android" })).rejects.toThrow(
      "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
    expect(fakeDeviceReadiness.getExplicitDevicePin()).toBeUndefined();

    registerInteractionTools();
    const tapAt = ToolRegistry.getTool("tapAt")!;

    await expect(tapAt.handler({ x: 10, y: 20 })).rejects.toThrow(
      "Both Android and iOS devices are connected. For a device tool call, pass sessionUuid (from getAndroid/getApple), platform, or a bound device label on this call to select the target. Alternatively, call setActiveDevice to select an active device.",
    );
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(1);
  });
});
