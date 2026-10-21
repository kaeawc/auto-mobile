import {
  registerDirectSessionDevice,
  unregisterDirectSession,
} from "../../src/utils/directSessionDeviceRegistry";
import { AmbiguousDeviceTargetError } from "../../src/daemon/ambiguousDeviceTargetRefusal";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry, type ToolRegistryCollaborators } from "../../src/server/toolRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { BootedDevice } from "../../src/models";
import { z } from "zod/v4";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";

describe("ToolRegistry iOS session context", () => {
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

  beforeEach(() => {
    ToolRegistry.clearTools();
    fakeDeviceReadiness = new FakeDeviceReadiness();
    originalCollaborators = ToolRegistry.getCollaboratorsForTesting();
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: fakeDeviceReadiness });
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
  });

  afterEach(() => {
    unregisterDirectSession("session-123");
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    ToolRegistry.setCollaboratorsForTesting(originalCollaborators);
    ToolRegistry.clearTools();
  });

  test("requires sessionUuid when multiple iOS simulators are booted", async () => {
    fakeDeviceReadiness.setConnectedDevices([iosDeviceA, iosDeviceB]);

    ToolRegistry.registerDeviceAware(
      "iosSessionRequiredTool",
      "Tool requiring sessionUuid when multiple iOS simulators are booted",
      z.object({
        platform: z.enum(["ios", "android"]).optional(),
        sessionUuid: z.string().optional(),
      }),
      async () => ({ success: true }),
    );

    const tool = ToolRegistry.getTool("iosSessionRequiredTool");
    expect(tool).toBeDefined();

    const error = await tool!.handler({ platform: "ios" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AmbiguousDeviceTargetError);
    expect(error).toMatchObject({
      name: "AmbiguousDeviceTargetError",
      code: "ambiguous_device_target",
      retryable: false,
      candidates: [
        { deviceId: iosDeviceA.deviceId, platform: "ios" },
        { deviceId: iosDeviceB.deviceId, platform: "ios" },
      ],
    });
    expect((error as Error).message).toContain(
      "Multiple iOS simulators detected. Provide sessionUuid to target a specific simulator.",
    );
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
  });

  test("allows sessionUuid when multiple iOS simulators are booted", async () => {
    registerDirectSessionDevice("session-123", iosDeviceA);
    fakeDeviceReadiness.setConnectedDevices([iosDeviceA, iosDeviceB]);

    ToolRegistry.registerDeviceAware(
      "iosSessionAllowedTool",
      "Tool allows sessionUuid when multiple iOS simulators are booted",
      z.object({
        platform: z.enum(["ios", "android"]).optional(),
        sessionUuid: z.string().optional(),
      }),
      async () => ({ success: true }),
    );

    const tool = ToolRegistry.getTool("iosSessionAllowedTool");
    expect(tool).toBeDefined();

    const response = await tool!.handler({ platform: "ios", sessionUuid: "session-123" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("allows explicit deviceId when multiple iOS simulators are booted", async () => {
    fakeDeviceReadiness.setConnectedDevices([iosDeviceA, iosDeviceB]);

    ToolRegistry.registerDeviceAware(
      "iosDeviceIdAllowedTool",
      "Tool allows deviceId without sessionUuid when multiple iOS simulators are booted",
      z.object({
        platform: z.enum(["ios", "android"]).optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
      }),
      async () => ({ success: true }),
    );

    const tool = ToolRegistry.getTool("iosDeviceIdAllowedTool");
    expect(tool).toBeDefined();

    const response = await tool!.handler({ platform: "ios", deviceId: "ios-device-b" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("allows operation when setActiveDevice was called with an iOS device and platform is ios", async () => {
    fakeDeviceReadiness.setConnectedDevices([iosDeviceA, iosDeviceB]);
    // Simulate setActiveDevice having been called
    fakeDeviceReadiness.setExplicitDevicePin(iosDeviceA);
    fakeDeviceReadiness.setExplicitDevicePin(iosDeviceA);

    ToolRegistry.registerDeviceAware(
      "iosActiveDeviceTool",
      "Tool allows operation after setActiveDevice was called",
      z.object({
        platform: z.enum(["ios", "android"]).optional(),
        sessionUuid: z.string().optional(),
      }),
      async () => ({ success: true }),
    );

    const tool = ToolRegistry.getTool("iosActiveDeviceTool");
    expect(tool).toBeDefined();

    // Should succeed without sessionUuid because setActiveDevice was called with platform: ios
    const response = await tool!.handler({ platform: "ios" });
    expect(response).toEqual({ success: true });
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(1);
  });

  test("still requires sessionUuid when setActiveDevice was called but platform is not ios", async () => {
    fakeDeviceReadiness.setConnectedDevices([iosDeviceA, iosDeviceB]);
    // Simulate setActiveDevice having been called
    fakeDeviceReadiness.setExplicitDevicePin(iosDeviceA);
    fakeDeviceReadiness.setExplicitDevicePin(iosDeviceA);

    ToolRegistry.registerDeviceAware(
      "iosActiveDeviceEitherPlatformTool",
      "Tool requires sessionUuid when platform is either even with setActiveDevice",
      z.object({
        platform: z.enum(["ios", "android"]).optional(),
        sessionUuid: z.string().optional(),
      }),
      async () => ({ success: true }),
    );

    const tool = ToolRegistry.getTool("iosActiveDeviceEitherPlatformTool");
    expect(tool).toBeDefined();

    // Should still require sessionUuid because platform is not explicitly "ios"
    // ensureDeviceReady won't honor currentDevice when platform doesn't match
    await expect(tool!.handler({})).rejects.toThrow(
      "Multiple iOS simulators detected. Provide sessionUuid to target a specific simulator.",
    );
    expect(fakeDeviceReadiness.getEnsureDeviceReadyCallCount()).toBe(0);
  });
});
