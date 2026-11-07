import { expect, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAvdConfigReader } from "../fakes/FakeAvdConfigReader";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const emulator: BootedDevice = {
  deviceId: "emulator-5620",
  name: "arbitrary-avd-name",
  platform: "android",
};

test.each([
  ["wearos_small_round", "watch"],
  ["pixel_6", "phone"],
  ["unrecognized", undefined],
] as const)("sessionless handler receives %s form factor as %s", async (deviceName, expected) => {
  const restoreRegistry = preserveToolRegistry();
  const previous = ToolRegistry.getCollaboratorsForTesting();
  const timer = new FakeTimer();
  const readiness = new FakeDeviceReadiness();
  readiness.setConnectedDevices([emulator]);
  const reader = new FakeAvdConfigReader({
    deviceName,
    ...(deviceName === "pixel_6"
      ? { screenWidth: 1080, screenHeight: 2400, screenDensity: 420 }
      : {}),
  });
  const displays = new FakeDisplayInventoryProvider();
  const restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
    displayInventory: displays,
    deviceReadAccess: {
      avdConfigReader: reader,
      listBooted: async () => {
        throw new Error("Legacy control calls must resolve through readiness");
      },
      isAuthorized: () => true,
    },
    auditRunner: {
      run: ({ device, args, handler, progress, signal }) => handler(device, args, progress, signal),
    },
    afterToolCall: {
      handle: async ({ response }) => ({ durationMs: 0, finalizedResponse: response }),
    },
  });
  ToolRegistry.setCollaboratorsForTesting({
    timer,
    deviceReadiness: readiness,
    toolCallRepository: { recordToolCall: async () => {} },
    navigationToolCallRecorder: { record: () => undefined },
  });
  try {
    let received: BootedDevice | undefined;
    ToolRegistry.registerDeviceAware(
      "legacyFormFactorProbe",
      "Inspect the legacy device",
      z.object({ deviceId: z.string() }),
      async (device) => {
        received = device;
        return { success: true };
      },
    );
    await ToolRegistry.getTool("legacyFormFactorProbe")!.handler({ deviceId: emulator.deviceId });
    expect(received?.deviceId).toBe(emulator.deviceId);
    expect(received?.formFactor).toBe(expected);
    expect(reader.readConfigCalls).toEqual([emulator.name]);
    expect(readiness.getEnsureDeviceReadyCalls()).toBe(1);
    expect(displays.tokens).toEqual([emulator.deviceId]);
    expect(emulator).not.toHaveProperty("formFactor");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    restorePipeline();
    ToolRegistry.setCollaboratorsForTesting(previous);
    restoreRegistry();
  }
});
