import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ActionableError, type BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerAllTools } from "../../src/server/registerAllTools";
import {
  APPLE_PLATFORM_SUPPORTED_TOOLS,
  assertToolSupportsDevicePlatform,
  unsupportedPlatformToolMessage,
} from "../../src/server/applePlatformToolSupport";
import type { NonIosApplePlatform } from "../../src/models/Platform";
import {
  registerDirectSessionDevice,
  unregisterDirectSession,
} from "../../src/utils/directSessionDeviceRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { isolateEmptyToolRegistry } from "../helpers/withTemporaryTool";

const watch: BootedDevice = {
  name: "Apple Watch Series 10 (46mm)",
  deviceId: "8E5C2D9A-1F1B-4C55-9C51-0F8E2B3A7D11",
  platform: "watchos",
};
const appleTv: BootedDevice = {
  name: "Apple TV 4K (3rd generation)",
  deviceId: "5B7E1C3D-2A4F-4E6B-8C9D-1E2F3A4B5C6D",
  platform: "tvos",
};
const iphone: BootedDevice = { name: "iPhone 16", deviceId: "IPHONE-UDID", platform: "ios" };
const DEVICES: Record<NonIosApplePlatform, BootedDevice> = { watchos: watch, tvos: appleTv };

describe("assertToolSupportsDevicePlatform", () => {
  test("rejects a watch for a tool that has not opted in, naming the tool and platform", () => {
    expect(() => assertToolSupportsDevicePlatform("tapOn", watch)).toThrow(
      new ActionableError(
        "tapOn does not support watchOS yet. Target an Android or iOS device instead.",
      ),
    );
  });

  test("rejects an Apple TV for a tool that has not opted in, naming the tool and platform", () => {
    expect(() => assertToolSupportsDevicePlatform("observe", appleTv)).toThrow(
      new ActionableError(
        "observe does not support tvOS yet. Target an Android or iOS device instead.",
      ),
    );
  });

  test("checks each platform against its own allowlist", () => {
    const supported = { watchos: new Set(["observe"]), tvos: new Set(["launchApp"]) };
    expect(() => assertToolSupportsDevicePlatform("observe", watch, supported)).not.toThrow();
    expect(() => assertToolSupportsDevicePlatform("launchApp", appleTv, supported)).not.toThrow();
    expect(() => assertToolSupportsDevicePlatform("observe", appleTv, supported)).toThrow(
      "does not support tvOS yet",
    );
    expect(() => assertToolSupportsDevicePlatform("launchApp", watch, supported)).toThrow(
      "does not support watchOS yet",
    );
  });

  test("never rejects an Android or iOS device", () => {
    expect(() => assertToolSupportsDevicePlatform("tapOn", iphone)).not.toThrow();
    expect(() =>
      assertToolSupportsDevicePlatform("tapOn", { ...iphone, platform: "android" }),
    ).not.toThrow();
  });
});

describe.each(["watchos", "tvos"] as const)(
  "every registered device-aware tool fails closed on %s (#14899, #15886)",
  (platform) => {
    const device = DEVICES[platform];
    const session = `${platform}-tool-support-session`;
    isolateEmptyToolRegistry();
    let restoreOverrides: () => void = () => {};
    let restoreCollaborators: () => void = () => {};

    beforeAll(() => {
      registerAllTools({ daemonMode: true });
      const readiness = new FakeDeviceReadiness();
      readiness.setConnectedDevices([device]);
      const previous = ToolRegistry.getCollaboratorsForTesting();
      ToolRegistry.setCollaboratorsForTesting({
        deviceReadiness: readiness,
        toolCallRepository: { async recordToolCall(): Promise<void> {} },
      });
      restoreCollaborators = () =>
        ToolRegistry.setCollaboratorsForTesting({
          deviceReadiness: previous.deviceReadiness,
          toolCallRepository: previous.toolCallRepository,
        });
      restoreOverrides = ToolRegistry.setPipelineOverridesForTesting({
        displayInventory: new FakeDisplayInventoryProvider(),
      });
      registerDirectSessionDevice(session, device);
    });

    afterAll(() => {
      unregisterDirectSession(session);
      restoreOverrides();
      restoreCollaborators();
    });

    test("the allowlist names only registered device-aware tools", () => {
      const deviceAware = new Set(
        ToolRegistry.getEveryRegisteredTool()
          .filter((tool) => tool.deviceAwareHandler !== undefined)
          .map((tool) => tool.name),
      );
      expect(
        [...APPLE_PLATFORM_SUPPORTED_TOOLS[platform]].filter((name) => !deviceAware.has(name)),
      ).toEqual([]);
    });

    test("rejects the device before the handler runs, for each tool not on the allowlist", async () => {
      const unsupported = ToolRegistry.getEveryRegisteredTool().filter(
        (tool) =>
          tool.deviceAwareHandler !== undefined &&
          !APPLE_PLATFORM_SUPPORTED_TOOLS[platform].has(tool.name),
      );
      expect(unsupported.length).toBeGreaterThan(0);
      const outcomes = await Promise.all(
        unsupported.map(async (tool) => {
          try {
            await tool.handler({ sessionUuid: session });
            return `${tool.name}: resolved`;
          } catch (error) {
            return error instanceof ActionableError &&
              error.message === unsupportedPlatformToolMessage(tool.name, platform)
              ? "rejected"
              : `${tool.name}: ${String(error)}`;
          }
        }),
      );
      expect(outcomes.filter((outcome) => outcome !== "rejected")).toEqual([]);
    });
  },
);
