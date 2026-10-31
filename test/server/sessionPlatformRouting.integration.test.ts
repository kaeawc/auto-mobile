import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { FakeFeatureFlagRepository } from "../fakes/FakeFeatureFlagRepository";
import { FakeFeatureFlagApplier } from "../fakes/FakeFeatureFlagApplier";
import { afterEach, beforeAll, beforeEach, expect, test, spyOn } from "bun:test";
import { z } from "zod/v4";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SELECTS_ACTIVE_DEVICE } from "../../src/server/toolRegistryTypes";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
} from "../../src/utils/directSessionDeviceRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import type { BootedDevice } from "../../src/models";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const android: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const ios: BootedDevice = { deviceId: "iphone", platform: "ios", name: "iPhone" };
let fixtureOrUndefined: McpTestFixture | undefined;

function requireFixture(): McpTestFixture {
  if (!fixtureOrUndefined) {
    throw new Error("fixture not set up");
  }
  return fixtureOrUndefined;
}
let originalManager: ReturnType<typeof ToolRegistry.getCollaboratorsForTesting>["deviceReadiness"];
let originalRepository: ReturnType<
  typeof ToolRegistry.getCollaboratorsForTesting
>["toolCallRepository"];
let featureFlags: ReturnType<typeof spyOn> | undefined;
let restorePipelineOverrides: (() => void) | undefined;

const received: string[] = [];

beforeAll(async () => {
  // McpTestFixture loads the server dynamically; warm that import outside the
  // per-test timing so the cases measure only their in-process routing work.
  await import("../../src/server/index");
});

beforeEach(async () => {
  // Keep production discovery in-process; fake device ids must never reach
  // host adb, simulator, or physical-device discovery. Reporting no booted
  // devices also makes setActiveDevice skip CtrlProxy resume in direct mode.
  restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
    displayInventory: new FakeDisplayInventoryProvider(),
  });
  const fakeDeviceUtils = new FakeDeviceUtils();
  fakeDeviceUtils.setBootedDevices("android", []);
  fakeDeviceUtils.setBootedDevices("ios", []);
  PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
  featureFlags = spyOn(FeatureFlagService, "getInstance").mockReturnValue(
    new FeatureFlagService(new FakeFeatureFlagRepository(), new FakeFeatureFlagApplier()),
  );
  originalRepository = ToolRegistry.getCollaboratorsForTesting().toolCallRepository;
  ToolRegistry.setCollaboratorsForTesting({
    toolCallRepository: { recordToolCall: async () => {} },
  });
  ToolRegistry.clearTools();
  clearDirectSessionDevices();
  received.length = 0;
  originalManager = ToolRegistry.getCollaboratorsForTesting().deviceReadiness;
  const manager = new FakeDeviceReadiness();
  manager.setConnectedDevices([android, ios]);
  ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: manager });
  const fixture = new McpTestFixture();
  fixtureOrUndefined = fixture;
  await fixture.setup();
  for (const [name, sessionUuid, device] of [
    ["getAndroid", "android-session", android],
    ["getApple", "ios-session", ios],
  ] as const) {
    ToolRegistry.register(name, name, z.object({}), async () => {
      registerDirectSessionDevice(sessionUuid, device);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ runtime: { session: { sessionUuid } } }),
          },
        ],
      };
    });
  }
  const schema = z.object({
    platform: z.enum(["android", "ios"]).optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
  });
  ToolRegistry.registerDeviceAware("routingProbe", "routingProbe", schema, async (device) => {
    received.push(device.deviceId);
    return { content: [{ type: "text" as const, text: device.deviceId }] };
  });
  ToolRegistry.register("setActiveDevice", "setActiveDevice", schema, {
    handler: async () => ({ content: [] }),
    ...SELECTS_ACTIVE_DEVICE,
  });
  await fixture.client.callTool({ name: "getAndroid", arguments: {} });
  await fixture.client.callTool({ name: "getApple", arguments: {} });
});
afterEach(async () => {
  try {
    await fixtureOrUndefined?.teardown();
  } finally {
    fixtureOrUndefined = undefined;
    featureFlags?.mockRestore();
    featureFlags = undefined;
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    PlatformDeviceManagerFactory.setInstance(null);
    ToolRegistry.setCollaboratorsForTesting({ toolCallRepository: originalRepository });
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: originalManager });
    ToolRegistry.clearTools();
    clearDirectSessionDevices();
  }
});

test("MCP platform and explicit sessions reach the correct device after two acquisitions", async () => {
  for (const args of [
    { platform: "android" },
    { platform: "ios" },
    { sessionUuid: "android-session" },
  ]) {
    await requireFixture().client.callTool({ name: "routingProbe", arguments: args });
  }
  expect(received).toEqual([android.deviceId, ios.deviceId, android.deviceId]);
});

test("successful setActiveDevice changes subsequent sessionless routing", async () => {
  await requireFixture().client.callTool({
    name: "setActiveDevice",
    arguments: { deviceId: android.deviceId, platform: "android" },
  });
  await requireFixture().client.callTool({ name: "routingProbe", arguments: {} });
  expect(received).toEqual([android.deviceId]);
});

test("explicit session takes precedence over platform", async () => {
  await requireFixture().client.callTool({
    name: "routingProbe",
    arguments: { sessionUuid: "android-session", platform: "ios" },
  });
  expect(received).toEqual([android.deviceId]);
});

test("direct setActiveDevice rebinds the default to a free device", async () => {
  const other: BootedDevice = { deviceId: "emulator-5556", platform: "android", name: "Other" };
  const manager = new FakeDeviceReadiness();
  manager.setConnectedDevices([android, ios, other]);
  ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: manager });
  registerUtilityTools({ legacyDeviceSelection: () => manager });
  // Leave `other` out of the fake booted list so the legacy handler's
  // resumeCtrlProxyIfCurrentlyBooted call exits before touching CtrlProxy.
  const result = await requireFixture().client.callTool({
    name: "setActiveDevice",
    arguments: { deviceId: other.deviceId, platform: "android" },
  });
  expect(result.isError).not.toBe(true);
  await requireFixture().client.callTool({ name: "routingProbe", arguments: {} });
  expect(received).toEqual([other.deviceId]);
});
