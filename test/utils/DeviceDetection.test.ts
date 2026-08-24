import { describe, expect, test } from "bun:test";
import { DeviceDetection, DevicePlatform } from "../../src/utils/DeviceDetection";
import { isIosSimulatorUdid } from "../../src/utils/ios-cmdline-tools/iosDeviceType";

/**
 * `detectPlatform` silently misroutes when it is wrong — the caller gets a
 * confident answer, not an error — so the boundary rows below are the
 * specification for what counts as an iOS UDID.
 *
 * Three real-world iOS UDID shapes exist:
 *   - simulator:        8-4-4-4-12 hex UUID   (569C0F94-5D53-40D2-AF8F-F4AA5BAA7D5E)
 *   - physical, A12+:   8 hex + "-" + 16 hex  (00008030-001C2D3E1234567A)
 *   - physical, legacy: 40 hex, no dashes
 */
describe("DeviceDetection.detectPlatform", () => {
  const detection = new DeviceDetection();

  const cases: [label: string, deviceId: string, expected: DevicePlatform][] = [
    // --- iOS: simulator UUIDs -------------------------------------------------
    ["simulator UUID (upper case)", "569C0F94-5D53-40D2-AF8F-F4AA5BAA7D5E", "ios"],
    ["simulator UUID (lower case)", "569c0f94-5d53-40d2-af8f-f4aa5baa7d5e", "ios"],

    // --- iOS: physical devices, A12 and newer ---------------------------------
    ["physical A12+ UDID", "00008030-001C2D3E1234567A", "ios"],
    ["physical A12+ UDID (lower case)", "00008110-000a4d3c1234801e", "ios"],

    // --- iOS: physical devices, legacy 40-hex ---------------------------------
    ["legacy 40-hex UDID", "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "ios"],
    ["legacy 40-hex UDID (upper case)", "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678", "ios"],

    // --- Android: emulators ---------------------------------------------------
    ["android emulator", "emulator-5554", "android"],
    ["android emulator, high port", "emulator-5584", "android"],

    // --- Android: physical serials (must NOT be captured by the iOS widening) --
    ["android serial with letters beyond hex", "R58M12ABCDE", "android"],
    ["android serial, short hex-only", "0123456789ABCDEF", "android"],
    ["android serial, 40 chars but non-hex", `R58M${"Z".repeat(36)}`, "android"],
    ["android transport id style", "192.168.1.24:5555", "android"],

    // --- Degenerate / boundary input ------------------------------------------
    ["empty string", "", "android"],
    ["whitespace only", "   ", "android"],
    [
      "simulator UUID with surrounding whitespace",
      " 569C0F94-5D53-40D2-AF8F-F4AA5BAA7D5E ",
      "android",
    ],
    ["39 hex chars (one short of legacy)", "a".repeat(39), "android"],
    ["41 hex chars (one over legacy)", "a".repeat(41), "android"],
    ["A12+ form, 15 hex tail (one short)", "00008030-001C2D3E123456", "android"],
    ["A12+ form, 17 hex tail (one over)", "00008030-001C2D3E1234567AB", "android"],
    ["A12+ form, 7 hex head (one short)", "0000803-001C2D3E1234567A", "android"],
    ["A12+ form with non-hex char", "00008030-001C2D3E1234567G", "android"],
    ["legacy form with non-hex char", `${"a".repeat(39)}g`, "android"],
    ["not a udid at all", "not-a-uuid", "android"],
  ];

  test.each(cases)("classifies %s as the expected platform", (_label, deviceId, expected) => {
    expect(detection.detectPlatform(deviceId)).toBe(expected);
  });

  test.each(cases)(
    "isiOSDevice/isAndroidDevice agree with detectPlatform for %s",
    (_l, deviceId, expected) => {
      expect(detection.isiOSDevice(deviceId)).toBe(expected === "ios");
      expect(detection.isAndroidDevice(deviceId)).toBe(expected === "android");
    },
  );

  test("static convenience methods match the instance methods", () => {
    expect(DeviceDetection.detectPlatform("00008030-001C2D3E1234567A")).toBe("ios");
    expect(DeviceDetection.isiOSDevice("a".repeat(40))).toBe(true);
    expect(DeviceDetection.isAndroidDevice("emulator-5554")).toBe(true);
  });

  /**
   * Simulator-vs-physical branching across the iOS action layer keys off
   * `isIosSimulatorUdid`. Both classifiers must agree that these are iOS; they
   * differ only on which transport (simctl vs devicectl) to use.
   */
  test("stays consistent with isIosSimulatorUdid, the sim-vs-physical router", () => {
    const simulator = "569C0F94-5D53-40D2-AF8F-F4AA5BAA7D5E";
    const physicalNew = "00008030-001C2D3E1234567A";
    const physicalLegacy = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

    for (const udid of [simulator, physicalNew, physicalLegacy]) {
      expect(detection.detectPlatform(udid)).toBe("ios");
    }

    expect(isIosSimulatorUdid(simulator)).toBe(true);
    expect(isIosSimulatorUdid(physicalNew)).toBe(false);
    expect(isIosSimulatorUdid(physicalLegacy)).toBe(false);
  });
});
