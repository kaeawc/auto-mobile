import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry, type ToolRegistryCollaborators } from "../../src/server/toolRegistry";
import {
  registerDirectSessionDevice,
  unregisterDirectSession,
} from "../../src/utils/directSessionDeviceRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";

// In direct (no-proxy) mode a watch session reaches its watch without naming watchOS, whether or
// not the call also repeats the watch's deviceId (#14908).

const WATCH: BootedDevice = {
  name: "Apple Watch Series 10 (46mm)",
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
  platform: "watchos",
};
const SESSION = "watch-direct-session";

describe("direct watch session platform", () => {
  let readiness: FakeDeviceReadiness;
  let original: ToolRegistryCollaborators;
  let restore: (() => void) | undefined;

  beforeEach(() => {
    ToolRegistry.clearTools();
    readiness = new FakeDeviceReadiness();
    original = ToolRegistry.getCollaboratorsForTesting();
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: readiness });
    restore = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    readiness.setConnectedDevices([WATCH]);
    registerDirectSessionDevice(SESSION, WATCH);
    ToolRegistry.registerDeviceAware(
      "listApps",
      "A tool a watch session may call",
      z.object({
        platform: z.enum(["android", "ios", "watchos"]).optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
      }),
      async () => ({ success: true }),
    );
  });

  afterEach(() => {
    unregisterDirectSession(SESSION);
    restore?.();
    ToolRegistry.setCollaboratorsForTesting(original);
    ToolRegistry.clearTools();
  });

  test.each([
    ["without", {}],
    ["with", { deviceId: WATCH.deviceId }],
  ])("a watch session call %s its deviceId readies the watch as watchos", async (_label, extra) => {
    await ToolRegistry.getTool("listApps")!.handler({ sessionUuid: SESSION, ...extra });

    expect(readiness.getLastEnsureDeviceReadyPlatform()).toBe("watchos");
  });
});
