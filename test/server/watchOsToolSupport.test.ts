import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ActionableError, type BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerAllTools } from "../../src/server/registerAllTools";
import {
  WATCHOS_SUPPORTED_TOOLS,
  assertToolSupportsDevicePlatform,
  watchOsUnsupportedToolMessage,
} from "../../src/server/watchOsToolSupport";
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
const iphone: BootedDevice = { name: "iPhone 16", deviceId: "IPHONE-UDID", platform: "ios" };
const WATCH_SESSION = "watchos-tool-support-session";

describe("assertToolSupportsDevicePlatform", () => {
  test("rejects a watch for a tool that has not opted in, naming the tool", () => {
    expect(() => assertToolSupportsDevicePlatform("tapOn", watch)).toThrow(
      new ActionableError(watchOsUnsupportedToolMessage("tapOn")),
    );
  });

  test("passes a watch for a tool that opted in", () => {
    expect(() =>
      assertToolSupportsDevicePlatform("observe", watch, new Set(["observe"])),
    ).not.toThrow();
  });

  test("never rejects an Android or iOS device", () => {
    expect(() => assertToolSupportsDevicePlatform("tapOn", iphone)).not.toThrow();
    expect(() =>
      assertToolSupportsDevicePlatform("tapOn", { ...iphone, platform: "android" }),
    ).not.toThrow();
  });
});

describe("every registered device-aware tool fails closed on a watch (#14899)", () => {
  isolateEmptyToolRegistry();
  let restoreOverrides: () => void = () => {};
  let restoreCollaborators: () => void = () => {};

  beforeAll(() => {
    registerAllTools({ daemonMode: true });
    const readiness = new FakeDeviceReadiness();
    readiness.setConnectedDevices([watch]);
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
    registerDirectSessionDevice(WATCH_SESSION, watch);
  });

  afterAll(() => {
    unregisterDirectSession(WATCH_SESSION);
    restoreOverrides();
    restoreCollaborators();
  });

  test("the allowlist names only registered device-aware tools", () => {
    const deviceAware = new Set(
      ToolRegistry.getEveryRegisteredTool()
        .filter((tool) => tool.deviceAwareHandler !== undefined)
        .map((tool) => tool.name),
    );
    expect([...WATCHOS_SUPPORTED_TOOLS].filter((name) => !deviceAware.has(name))).toEqual([]);
  });

  test("rejects a watch before the handler runs, for each tool not on the allowlist", async () => {
    const unsupported = ToolRegistry.getEveryRegisteredTool().filter(
      (tool) => tool.deviceAwareHandler !== undefined && !WATCHOS_SUPPORTED_TOOLS.has(tool.name),
    );
    expect(unsupported.length).toBeGreaterThan(0);
    const outcomes = await Promise.all(
      unsupported.map(async (tool) => {
        try {
          await tool.handler({ sessionUuid: WATCH_SESSION });
          return `${tool.name}: resolved`;
        } catch (error) {
          return error instanceof ActionableError &&
            error.message === watchOsUnsupportedToolMessage(tool.name)
            ? "rejected"
            : `${tool.name}: ${String(error)}`;
        }
      }),
    );
    expect(outcomes.filter((outcome) => outcome !== "rejected")).toEqual([]);
  });
});
