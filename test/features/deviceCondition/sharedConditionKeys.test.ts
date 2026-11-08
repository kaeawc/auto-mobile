import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DEVICE_CONDITION_APPLY,
  deviceConditionChanges,
  deviceConditionInputSchema,
} from "../../../src/features/deviceCondition/DeviceConditionTypes";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import { resolveIosSimulatorConditionInjector } from "../../../src/features/deviceCondition/iosSimulatorConditionInjectors";

const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

describe("shared statusBar/privacy/location keys (#14073)", () => {
  test("object values become apply changes carrying their params, before faults", () => {
    const parsed = deviceConditionInputSchema.parse({
      statusBar: { time: "9:41" },
      privacy: { appId: "com.example.app", service: "photos", action: "grant" },
      location: "unset",
      faults: { battery: "low" },
    });
    expect(deviceConditionChanges(parsed)).toEqual([
      { key: "statusBar", value: DEVICE_CONDITION_APPLY, params: { time: "9:41" } },
      {
        key: "privacy",
        value: DEVICE_CONDITION_APPLY,
        params: { appId: "com.example.app", service: "photos", action: "grant" },
      },
      { key: "location", value: "unset" },
      { key: "faults.battery", value: "low" },
    ]);
  });

  test("the schema rejects empty, out-of-range and unknown values", () => {
    for (const input of [
      { statusBar: {} },
      { statusBar: { batteryLevel: 101 } },
      { statusBar: { hideNotifications: true } },
      { location: { latitude: 91, longitude: 0 } },
      { privacy: { appId: "com.example.app", service: "camera", action: "grant" } },
      { privacy: { appId: "not an id", service: "photos", action: "grant" } },
      { privacy: { appId: "com.example.app", service: "photos", action: "reset" } },
    ]) {
      expect(deviceConditionInputSchema.safeParse(input).success).toBe(false);
    }
  });

  test("Android refuses each shared key with an iOS Simulator pointer and owes nothing", async () => {
    const controller = new DeviceConditionController((key) =>
      resolveIosSimulatorConditionInjector(android, key),
    );
    const result = await controller.apply({
      statusBar: { time: "9:41" },
      location: { latitude: 0, longitude: 0 },
    });
    expect(result.success).toBe(false);
    expect(result.changes.map((change) => change.status)).toEqual(["unsupported", "unsupported"]);
    expect(result.changes[0].detail).toContain("iOS Simulator only");
    expect(result.active).toEqual([]);
  });
});
