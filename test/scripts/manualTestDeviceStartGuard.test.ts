import { expect, test } from "bun:test";
import {
  DEVICE_START_TOOLS,
  deviceStartGuardRefusal,
} from "../../scripts/manual-test/deviceStartGuard";
const explicit: Record<string, unknown[]> = {
  startDevice: [
    { avdName: "Pixel" },
    { deviceId: "serial" },
    { device: { avdName: "Pixel" } },
    { device: { deviceId: "udid" } },
  ],
  getAndroid: [{ avdName: "Pixel" }, { deviceId: "serial" }],
  getApple: [{ udid: "udid" }, { deviceId: "udid" }],
  provisionDevice: [{ device: { name: "Pixel" } }, { device: { deviceId: "udid" } }],
};
for (const tool of DEVICE_START_TOOLS) {
  test(`${tool} accepts every explicit spelling and refuses selectors`, () => {
    for (const args of explicit[tool]) {
      expect(deviceStartGuardRefusal(tool, args, { allowSelector: false })).toBeUndefined();
    }
    for (const args of [
      {},
      { platform: "android", minOsVersion: "14", requires: {} },
      { name: " ", avdName: "", deviceId: " ", udid: "", device: { name: " ", deviceId: "" } },
    ]) {
      const refusal = deviceStartGuardRefusal(tool, args, { allowSelector: false });
      expect(refusal).toContain(tool);
      expect(refusal).toContain("20261012a");
      expect(refusal).toContain("--allow-selector");
      expect(deviceStartGuardRefusal(tool, args, { allowSelector: true })).toBeUndefined();
    }
    for (const args of [null, [], "name", 3, undefined]) {
      expect(deviceStartGuardRefusal(tool, args, { allowSelector: false })).toContain("object");
    }
  });
}
test("other tools pass without interpreting their arguments", () => {
  expect(deviceStartGuardRefusal("observe", null, { allowSelector: false })).toBeUndefined();
  expect(deviceStartGuardRefusal("listDevices", {}, { allowSelector: false })).toBeUndefined();
});

test("startDevice requires exact identifiers and top-level fields win over legacy device", () => {
  for (const args of [
    { name: "Pixel" },
    { device: { name: "Pixel_9" } },
    { udid: "simulator" },
    { avdName: "", device: { avdName: "Pixel_9" } },
    { deviceId: " ", device: { deviceId: "serial" } },
    { platform: "android", name: "", device: { name: "Pixel_9" } },
  ]) {
    expect(deviceStartGuardRefusal("startDevice", args, { allowSelector: false })).toContain(
      "avdName (Android) or deviceId (UDID/serial)",
    );
    expect(deviceStartGuardRefusal("startDevice", args, { allowSelector: true })).toBeUndefined();
  }
});
