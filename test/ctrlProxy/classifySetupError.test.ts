import { describe, expect, test } from "bun:test";
import { classifySetupError } from "../../src/ctrlProxy/classifySetupError";
import type { ProxySetupErrorCategory } from "../../src/utils/interfaces/ProxyManager";

describe("classifySetupError", () => {
  // Captured adb stderr from #13392, including serial-scoping and transport-id cases.
  test.each<[string | undefined, string, ProxySetupErrorCategory]>([
    ["emulator-9999", "adb: device 'emulator-9999' not found", "deviceConnection"],
    ["emulator-9999", "error: device 'emulator-9999' not found", "deviceConnection"],
    [
      "emulator-9999",
      "adb: error: failed to get feature set: device 'emulator-9999' not found",
      "deviceConnection",
    ],
    ["ZZZ123", "adb: device 'ZZZ123' not found", "deviceConnection"],
    ["emulator-5554", "adb: device 'emulator-9999' not found", "unknown"],
    [undefined, "adb: device 'emulator-9999' not found", "deviceConnection"],
    ["emulator-5554", "adb: no device with transport id '99'", "unknown"],
    [undefined, "adb: no device with transport id '99'", "unknown"],
  ])("classifies captured stderr for %s: %s -> %s", (deviceId, stderr, category) => {
    expect(classifySetupError(stderr, deviceId).category).toBe(category);
  });

  // Synthetic cases, not captured adb stderr.
  test("classifies an unqualified missing-device message", () => {
    expect(classifySetupError("error: device not found", "emulator-5554").category).toBe(
      "deviceConnection",
    );
  });

  test("permission denied takes precedence over a missing-device message", () => {
    expect(
      classifySetupError(
        "permission denied: adb: device 'emulator-5554' not found",
        "emulator-5554",
      ).category,
    ).toBe("permission");
  });
});
