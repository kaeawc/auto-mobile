import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ActionableError, type BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerAllTools } from "../../src/server/registerAllTools";
import {
  APPLE_PLATFORM_SUPPORTED_TOOLS,
  assertRequestedPlatformSupported,
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
    expect(() => assertToolSupportsDevicePlatform("pinchOn", watch)).toThrow(
      new ActionableError(
        "pinchOn does not support watchOS yet. Target an Android or iOS device instead.",
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

  test("admits tvOS lifecycle tools without enabling watchOS lifecycle tools", () => {
    for (const tool of ["startDevice", "setActiveDevice", "killDevice"]) {
      expect(() => assertToolSupportsDevicePlatform(tool, appleTv)).not.toThrow();
      expect(() => assertRequestedPlatformSupported(tool, { platform: "tvos" })).not.toThrow();
      expect(APPLE_PLATFORM_SUPPORTED_TOOLS.watchos.has(tool)).toBe(false);
    }
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

    test("the allowlist names only registered tools", () => {
      const deviceAware = new Set(ToolRegistry.getEveryRegisteredTool().map((tool) => tool.name));
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

describe("assertRequestedPlatformSupported", () => {
  test("refuses a requested Apple TV or watch for a tool that has not opted in", () => {
    expect(() => assertRequestedPlatformSupported("tapOn", { platform: "tvos" })).toThrow(
      new ActionableError(unsupportedPlatformToolMessage("tapOn", "tvos")),
    );
    expect(() => assertRequestedPlatformSupported("pinchOn", { platform: "watchos" })).toThrow(
      new ActionableError(unsupportedPlatformToolMessage("pinchOn", "watchos")),
    );
  });

  test("allows Android, iOS, no platform, and a platform the tool opted in to", () => {
    const supported = { watchos: new Set(["observe"]), tvos: new Set<string>() };
    expect(() => assertRequestedPlatformSupported("tapOn", { platform: "ios" })).not.toThrow();
    expect(() => assertRequestedPlatformSupported("tapOn", { platform: "android" })).not.toThrow();
    expect(() => assertRequestedPlatformSupported("tapOn", {})).not.toThrow();
    expect(() =>
      assertRequestedPlatformSupported("observe", { platform: "watchos" }, supported),
    ).not.toThrow();
  });
});

describe("a device-aware tool refuses a requested tvOS platform before session resolution", () => {
  const session = "ios-session-asked-for-tvos";
  const tool = "__tvosRequestProbe__";
  const handled: BootedDevice[] = [];
  isolateEmptyToolRegistry();
  let restoreOverrides: () => void = () => {};
  let restoreCollaborators: () => void = () => {};

  beforeAll(() => {
    ToolRegistry.registerDeviceAware(
      tool,
      "probe",
      z.object({ platform: z.string().optional(), sessionUuid: z.string().optional() }),
      async (device) => {
        handled.push(device);
        return { content: [] };
      },
    );
    const readiness = new FakeDeviceReadiness();
    readiness.setConnectedDevices([iphone]);
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
    registerDirectSessionDevice(session, iphone);
  });

  afterAll(() => {
    unregisterDirectSession(session);
    restoreOverrides();
    restoreCollaborators();
  });

  test("an iOS session runs the tool when the request names iOS", async () => {
    handled.length = 0;
    await ToolRegistry.getTool(tool)!.handler({ platform: "ios", sessionUuid: session });
    expect(handled.map((device) => device.deviceId)).toEqual([iphone.deviceId]);
  });

  test("naming tvos with that iOS session is refused and never reaches the iPhone", async () => {
    handled.length = 0;
    const error = await Promise.resolve(
      ToolRegistry.getTool(tool)!.handler({ platform: "tvos", sessionUuid: session }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toEqual(new ActionableError(unsupportedPlatformToolMessage(tool, "tvos")));
    expect(handled).toEqual([]);
  });
});
