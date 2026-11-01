import { beforeAll, describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models";
import {
  APPLE_PLATFORM_SUPPORTED_TOOLS,
  unsupportedPlatformToolMessage,
} from "../../src/server/applePlatformToolSupport";
import { toAdvertisedJsonSchema } from "../../src/server/pipeline/advertisedSchema";
import { registerAllTools } from "../../src/server/registerAllTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { createLifecycleHandlers } from "../../src/server/deviceToolsLifecycle";
import { registerDeviceTools, setDeviceToolsDependencies } from "../../src/server/deviceTools";
import { AppleTvSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import { FakeAppleTvProvisionSimctl, tvDevice } from "../fakes/FakeAppleTvSimctl";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { FakeTimer } from "../fakes/FakeTimer";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import { restartStopHarness } from "../helpers/restartStopHarness";
import { toolJson } from "../helpers/toolResponse";

isolateToolRegistry();

/** Every `platform` property's enum in a JSON schema, with the path that reached it. */
function platformEnums(
  node: unknown,
  path: string[] = [],
): Array<{ path: string; values: string[] }> {
  if (Array.isArray(node)) {
    return node.flatMap((child, index) => platformEnums(child, [...path, String(index)]));
  }
  if (node === null || typeof node !== "object") {
    return [];
  }
  return Object.entries(node).flatMap(([key, value]) => {
    const here =
      key === "platform" && value !== null && typeof value === "object" && "enum" in value
        ? [{ path: [...path, key].join("."), values: (value as { enum: string[] }).enum }]
        : [];
    return [...here, ...platformEnums(value, [...path, key])];
  });
}

describe("tvOS is advertised in tool schemas and refused by unsupported tools (#15886)", () => {
  beforeAll(() => {
    registerAllTools({ daemonMode: true });
  });

  test("every tool input that offers Android also offers tvos", () => {
    const offered = ToolRegistry.getEveryRegisteredTool().flatMap((tool) =>
      platformEnums(toAdvertisedJsonSchema(tool.schema, { constrainAppIds: false })).map(
        (entry) => ({ tool: tool.name, ...entry }),
      ),
    );
    expect(offered.length).toBeGreaterThan(0);
    const missing = offered.filter(
      (entry) => entry.values.includes("android") && !entry.values.includes("tvos"),
    );
    expect(missing).toEqual([]);
  });

  test("every tool that offers tvos and is not behind the device gate refuses it by name", async () => {
    const plain = ToolRegistry.getEveryRegisteredTool().filter(
      (tool) =>
        tool.deviceAwareHandler === undefined &&
        !["listDevices", "listDeviceImages", "provisionDevice", "deleteDevice"].includes(
          tool.name,
        ) &&
        JSON.stringify(toAdvertisedJsonSchema(tool.schema, { constrainAppIds: false })).includes(
          '"tvos"',
        ),
    );
    expect(plain.map((tool) => tool.name).sort()).toEqual([
      "killDevice",
      "setActiveDevice",
      "startDevice",
    ]);
    const outcomes = await Promise.all(
      plain.map(async (tool) => {
        // Both shapes a lifecycle request names its platform with.
        const request = {
          platform: "tvos",
          deviceId: "5B7E1C3D-2A4F-4E6B-8C9D-1E2F3A4B5C6D",
          name: "Apple TV 4K (3rd generation)",
          target: { platform: "tvos", isVirtual: true, stableId: "5B7E1C3D" },
        };
        const error = await Promise.resolve(tool.handler(request)).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        return { tool: tool.name, error };
      }),
    );
    expect(
      outcomes
        .filter(({ tool }) => !APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has(tool))
        .filter(
          ({ tool, error }) =>
            !(error instanceof ActionableError) ||
            error.message !== unsupportedPlatformToolMessage(tool, "tvos"),
        ),
    ).toEqual([]);
    for (const { tool, error } of outcomes.filter(({ tool }) =>
      APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has(tool),
    )) {
      expect(error instanceof Error ? error.message : undefined).not.toBe(
        unsupportedPlatformToolMessage(tool, "tvos"),
      );
    }
  });
});

describe("killDevice Apple TV platform admission", () => {
  const { test } = restartStopHarness();

  function arrange() {
    const tv = tvDevice({ state: "Booted" });
    const simctl = new FakeAppleTvProvisionSimctl([tv]);
    const timer = new FakeTimer();
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient(),
      fakeDeviceManagerSimctl({ killSimulator: simctl.killSimulator.bind(simctl) }),
      createFakeAndroidEmulator(),
      { timer },
    ).withAppleTvSimulators(new AppleTvSimulatorInventory(simctl, "arm64"));
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      timer,
      stopPerformanceMonitoring: () => {},
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      clearInstalledAppsForDevice: async () => {},
    });
    return { tv, simctl, timer };
  }

  test("killDevice shuts down an Apple TV named only by its device", async () => {
    const { tv, simctl, timer } = arrange();
    const result = await createLifecycleHandlers().killDeviceHandler({
      device: { platform: "tvos", name: tv.name, deviceId: tv.udid },
    });
    expect(toolJson(result)).toMatchObject({
      platform: "tvos",
      message: `tvos '${tv.name}' shutdown successfully`,
    });
    expect(simctl.commands).toEqual([`shutdown ${tv.udid}`]);
    expect(tv.state).toBe("Shutdown");
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("killDevice with only an Apple TV deviceId cannot shut down through tvOS", async () => {
    const { tv, simctl, timer } = arrange();
    registerDeviceTools();
    const tool = ToolRegistry.getTool("killDevice")!;
    // Public ingress validates this schema before invoking the plain handler.
    await expect(
      (async () => await tool.handler(tool.schema.parse({ deviceId: tv.udid })))(),
    ).rejects.toThrow();
    await expect(tool.handler({ deviceId: tv.udid })).rejects.toThrow();
    expect(simctl.commands).toEqual([]);
    expect(tv.state).toBe("Booted");
    expect(timer.getSleepHistory()).toEqual([]);
  });
});
