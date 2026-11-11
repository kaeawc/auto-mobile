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
import { loadTvosSimctlFixture } from "../helpers/tvosSimctlFixtures";
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
const visionPro: BootedDevice = {
  name: "Apple Vision Pro",
  deviceId: "7C1D2E3F-4A5B-4C6D-8E9F-0A1B2C3D4E5F",
  platform: "visionos",
};
const iphone: BootedDevice = { name: "iPhone 16", deviceId: "IPHONE-UDID", platform: "ios" };
const DEVICES: Record<NonIosApplePlatform, BootedDevice> = {
  watchos: watch,
  tvos: appleTv,
  visionos: visionPro,
};
const DEVICE_LIFECYCLE_TOOLS = [
  "listDevices",
  "listDeviceImages",
  "provisionDevice",
  "deleteDevice",
  "startDevice",
  "setActiveDevice",
  "killDevice",
];

describe("assertToolSupportsDevicePlatform", () => {
  test("rejects a watch for a tool that has not opted in, naming the tool and platform", () => {
    expect(() => assertToolSupportsDevicePlatform("pinchOn", watch)).toThrow(
      new ActionableError(
        "pinchOn does not support watchOS yet. Target an Android or iOS device instead.",
      ),
    );
  });

  test("rejects an Apple TV for a tool that has not opted in, naming the tool and platform", () => {
    expect(() => assertToolSupportsDevicePlatform("tapAt", appleTv)).toThrow(
      new ActionableError(
        "tapAt does not support tvOS touch gestures; use focus navigation via pressButton (up/down/left/right/select).",
      ),
    );
  });

  test("checks each platform against its own allowlist", () => {
    const supported = {
      watchos: new Set(["observe"]),
      tvos: new Set(["launchApp"]),
      visionos: new Set(["startDevice"]),
    };
    expect(() => assertToolSupportsDevicePlatform("observe", watch, supported)).not.toThrow();
    expect(() => assertToolSupportsDevicePlatform("launchApp", appleTv, supported)).not.toThrow();
    expect(() => assertToolSupportsDevicePlatform("observe", appleTv, supported)).toThrow(
      "does not support tvOS yet",
    );
    expect(() => assertToolSupportsDevicePlatform("launchApp", watch, supported)).toThrow(
      "does not support watchOS yet",
    );
    expect(() =>
      assertToolSupportsDevicePlatform("startDevice", visionPro, supported),
    ).not.toThrow();
    expect(() => assertToolSupportsDevicePlatform("launchApp", visionPro, supported)).toThrow(
      "does not support visionOS yet",
    );
  });

  test("rejects a Vision Pro for a tool that has not opted in, naming the tool and platform", () => {
    expect(() => assertToolSupportsDevicePlatform("tapAt", visionPro)).toThrow(
      new ActionableError(
        "tapAt does not support visionOS yet. Target an Android or iOS device instead.",
      ),
    );
  });

  test("visionOS allows lifecycle, app tools, logs, plans, observe and window-app input", () => {
    expect([...APPLE_PLATFORM_SUPPORTED_TOOLS.visionos].sort()).toEqual(
      [
        ...DEVICE_LIFECYCLE_TOOLS,
        "executePlan",
        "installApp",
        "uninstallApp",
        "launchApp",
        "terminateApp",
        "listApps",
        "observe",
        "tapOn",
        "sendKeys",
        "getLogs",
      ].sort(),
    );
    for (const tool of [
      ...DEVICE_LIFECYCLE_TOOLS,
      "executePlan",
      "installApp",
      "uninstallApp",
      "launchApp",
      "terminateApp",
      "listApps",
      "observe",
      "tapOn",
      "sendKeys",
      "getLogs",
    ]) {
      expect(() => assertToolSupportsDevicePlatform(tool, visionPro)).not.toThrow();
      expect(() => assertRequestedPlatformSupported(tool, { platform: "visionos" })).not.toThrow();
    }
    for (const tool of ["pressButton", "tapAt", "swipeOn", "pinchOn", "tapAny"]) {
      expect(() => assertToolSupportsDevicePlatform(tool, visionPro)).toThrow(
        new ActionableError(unsupportedPlatformToolMessage(tool, "visionos")),
      );
    }
  });

  test("admits tvOS lifecycle tools without enabling watchOS lifecycle tools", () => {
    for (const tool of ["startDevice", "setActiveDevice", "killDevice"]) {
      expect(() => assertToolSupportsDevicePlatform(tool, appleTv)).not.toThrow();
      expect(() => assertRequestedPlatformSupported(tool, { platform: "tvos" })).not.toThrow();
      expect(APPLE_PLATFORM_SUPPORTED_TOOLS.watchos.has(tool)).toBe(false);
    }
  });

  test("admits postNotification on watchOS and tvOS", () => {
    for (const [device, platform] of [
      [watch, "watchos"],
      [appleTv, "tvos"],
    ] as const) {
      expect(() => assertToolSupportsDevicePlatform("postNotification", device)).not.toThrow();
      expect(() =>
        assertRequestedPlatformSupported("postNotification", { platform }),
      ).not.toThrow();
    }
  });

  test("admits tvOS and watchOS diagnostics; visionOS admits getLogs but still refuses crashApp", () => {
    expect(() => assertToolSupportsDevicePlatform("getLogs", visionPro)).not.toThrow();
    for (const tool of ["getLogs", "crashApp"]) {
      for (const device of [appleTv, watch, iphone, { ...iphone, platform: "android" as const }]) {
        expect(() => assertToolSupportsDevicePlatform(tool, device)).not.toThrow();
        expect(() =>
          assertRequestedPlatformSupported(tool, { platform: device.platform }),
        ).not.toThrow();
      }
    }
    expect(() => assertToolSupportsDevicePlatform("crashApp", visionPro)).toThrow(ActionableError);
    expect(() => assertRequestedPlatformSupported("crashApp", { platform: "visionos" })).toThrow(
      ActionableError,
    );
  });

  test("never rejects an Android or iOS device", () => {
    expect(() => assertToolSupportsDevicePlatform("tapOn", iphone)).not.toThrow();
    expect(() =>
      assertToolSupportsDevicePlatform("tapOn", { ...iphone, platform: "android" }),
    ).not.toThrow();
  });
});

describe.each(["watchos", "tvos", "visionos"] as const)(
  "every registered device-aware tool fails closed on %s (#14899, #15886, #16848)",
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

    if (platform === "tvos") {
      test("says a capability the tvOS runtime lacks is not available, not unsupported yet (#17529)", async () => {
        for (const [name, exitCode, stderr] of [
          ["appearance", 45, "Runtime does not support userInterfaceStyle"],
          ["content_size", 45, "Runtime does not support dynamic text"],
          ["status_bar", 45, "Status bar overrides not supported on this platform."],
          ["pbcopy", 147, "Pasteboard is not supported by this runtime."],
        ] as const) {
          const capture = loadTvosSimctlFixture(name);
          expect(capture.exitCode).toBe(exitCode);
          expect(capture.stdout).toBe("");
          expect(capture.stderr).toContain(stderr);
        }
        for (const [tool, message] of [
          [
            "displayConfig",
            "displayConfig is not available on tvOS: the tvOS simulator runtime does not support appearance or content size changes. Target an Android or iOS device instead.",
          ],
          [
            "statusBar",
            "statusBar is not available on tvOS: the tvOS simulator runtime has no status bar override. Target an Android or iOS device instead.",
          ],
          [
            "clipboard",
            "clipboard is not available on tvOS: the tvOS simulator runtime has no pasteboard. Target an Android or iOS device instead.",
          ],
        ] as const) {
          expect(APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has(tool)).toBe(false);
          expect(unsupportedPlatformToolMessage(tool, "tvos")).toBe(message);
          const registered = ToolRegistry.getTool(tool);
          expect(registered).toBeDefined();
          const error = await Promise.resolve(registered!.handler({ sessionUuid: session })).then(
            () => undefined,
            (caught: unknown) => caught,
          );
          expect(error).toBeInstanceOf(ActionableError);
          expect(error instanceof Error ? error.message : error).toBe(message);
          expect(() => assertToolSupportsDevicePlatform(tool, appleTv)).toThrow(
            new ActionableError(message),
          );
          expect(() => assertRequestedPlatformSupported(tool, { platform: "tvos" })).toThrow(
            new ActionableError(message),
          );
        }
        // The reason table is tvOS-only and ignores inherited object keys.
        expect(unsupportedPlatformToolMessage("clipboard", "watchos")).toBe(
          "clipboard does not support watchOS yet. Target an Android or iOS device instead.",
        );
        expect(unsupportedPlatformToolMessage("toString", "tvos")).toBe(
          "toString does not support tvOS yet. Target an Android or iOS device instead.",
        );
      });
    }

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
    expect(() => assertRequestedPlatformSupported("tapAt", { platform: "tvos" })).toThrow(
      new ActionableError(unsupportedPlatformToolMessage("tapAt", "tvos")),
    );
    expect(() => assertRequestedPlatformSupported("pinchOn", { platform: "watchos" })).toThrow(
      new ActionableError(unsupportedPlatformToolMessage("pinchOn", "watchos")),
    );
    expect(() => assertRequestedPlatformSupported("pressButton", { platform: "visionos" })).toThrow(
      new ActionableError(unsupportedPlatformToolMessage("pressButton", "visionos")),
    );
  });

  test("allows Android, iOS, no platform, and a platform the tool opted in to", () => {
    const supported = {
      watchos: new Set(["observe"]),
      tvos: new Set<string>(),
      visionos: new Set<string>(),
    };
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

test("tvOS opts into videoRecording and compareScreenshot (#16725)", () => {
  for (const tool of ["videoRecording", "compareScreenshot"]) {
    expect(() => assertToolSupportsDevicePlatform(tool, appleTv)).not.toThrow();
    expect(() => assertRequestedPlatformSupported(tool, { platform: "tvos" })).not.toThrow();
    expect(APPLE_PLATFORM_SUPPORTED_TOOLS.watchos.has(tool)).toBe(false);
    expect(APPLE_PLATFORM_SUPPORTED_TOOLS.visionos.has(tool)).toBe(false);
  }
});

test("tvOS opts into observe", () => {
  expect(APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has("observe")).toBe(true);
  expect(() => assertToolSupportsDevicePlatform("observe", appleTv)).not.toThrow();
});

test("watchOS opts into sendKeys", () => {
  expect(APPLE_PLATFORM_SUPPORTED_TOOLS.watchos.has("sendKeys")).toBe(true);
  expect(() => assertToolSupportsDevicePlatform("sendKeys", watch)).not.toThrow();
  expect(() => assertRequestedPlatformSupported("sendKeys", { platform: "watchos" })).not.toThrow();
});
