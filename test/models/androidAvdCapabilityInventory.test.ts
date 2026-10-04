import { expect, test } from "bun:test";
import { buildAndroidAvdCapabilityInventory } from "../../src/models/virtualDeviceCapabilities";
import { buildAndroidAvdCapabilityInventory as featureProjection } from "../../src/features/device-control/virtualDeviceCapabilities";

test("the feature module preserves the model projection export", () => {
  expect(featureProjection).toBe(buildAndroidAvdCapabilityInventory);
});

test("normalizes camera and boolean values without claiming unknown capabilities", () => {
  expect(
    buildAndroidAvdCapabilityInventory({
      "hw.camera.back": " VirtualScene ",
      "hw.camera.front": " OFF ",
      "hw.fingerprint": " TRUE ",
      "hw.gps": "unknown",
    }),
  ).toEqual({
    schemaVersion: 1,
    capabilities: [
      { id: "android.hardware.camera", state: "available", source: "avd_config" },
      { id: "android.hardware.camera.front", state: "unavailable", source: "avd_config" },
      { id: "android.hardware.fingerprint", state: "available", source: "avd_config" },
    ],
  });
});
