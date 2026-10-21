import { describe, expect, test } from "bun:test";
import { handleDeviceConditionCall } from "../../src/server/deviceConditionTool";
import { DeviceConditionRegistry } from "../../src/features/deviceCondition/DeviceConditionRegistry";
import type { BootedDevice } from "../../src/models";
import { toolText, toolStructured } from "../helpers/toolResponse";

const device: BootedDevice = {
  name: "emulator-5554",
  platform: "android",
  deviceId: "emulator-5554",
};
const flagOn = { isEnabled: () => true };
const flagOff = { isEnabled: () => false };

function freshRegistry() {
  // No injectors: a non-unset condition is unsupported, which is what this foundational drop ships.
  return new DeviceConditionRegistry(() => undefined);
}

describe("handleDeviceConditionCall (#14050)", () => {
  test("refuses when the feature flag is off", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { rootState: "unset" }, sessionUuid: "s" },
      { featureFlags: flagOff, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toMatch(/feature flag/);
  });

  test("refuses mixing deviceCondition with other setDeviceState fields", async () => {
    const response = await handleDeviceConditionCall(
      device,
      {
        deviceCondition: { rootState: "unset" },
        doNotDisturb: { enabled: true },
        sessionUuid: "s",
      },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toMatch(/cannot be combined/);
  });

  test("refuses an empty deviceCondition request", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: {}, sessionUuid: "s" },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toMatch(/reset or at least one condition/);
  });

  test("refuses an invalid deviceCondition value", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { rootState: "rooted-detectable" }, sessionUuid: "s" },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toMatch(/Invalid deviceCondition/);
  });

  test("refuses a lease in direct mode (no session to enforce it)", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { reset: true, expiresInSeconds: 30 } },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toMatch(/no lifecycle owner|needs a session/);
  });

  test("applies a reset and reports the structured deviceCondition result", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { reset: true }, sessionUuid: "s" },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    const structured = toolStructured(response) as {
      success: boolean;
      deviceCondition: { version: number; active: unknown[] };
    };
    expect(structured.success).toBe(true);
    expect(structured.deviceCondition.version).toBe(1);
    expect(structured.deviceCondition.active).toEqual([]);
  });
});
