import { describe, expect, test } from "bun:test";
import { classifyDisplayCutout } from "../../src/utils/displayCutout";

describe("classifyDisplayCutout", () => {
  test("classifies known Android profile identifiers without inspecting camera metadata", () => {
    expect(classifyDisplayCutout("android", "pixel_2")).toBe("none");
    expect(classifyDisplayCutout("android", "Nexus 5X")).toBe("none");
    expect(classifyDisplayCutout("android", "Medium Phone")).toBe("none");
    expect(classifyDisplayCutout("android", "Small Phone")).toBe("none");
    expect(classifyDisplayCutout("android", "pixel_3_xl")).toBe("notch");
    expect(classifyDisplayCutout("android", "pixel_9")).toBe("hole_punch");
  });

  test("classifies known iOS simulator device types including no-cutout devices", () => {
    expect(
      classifyDisplayCutout(
        "ios",
        "com.apple.CoreSimulator.SimDeviceType.iPhone-SE--2nd-generation-",
      ),
    ).toBe("none");
    expect(
      classifyDisplayCutout(
        "ios",
        "com.apple.CoreSimulator.SimDeviceType.iPod-touch--7th-generation-",
      ),
    ).toBe("none");
    expect(classifyDisplayCutout("ios", "com.apple.CoreSimulator.SimDeviceType.iPhone-14")).toBe(
      "notch",
    );
    expect(classifyDisplayCutout("ios", "com.apple.CoreSimulator.SimDeviceType.iPhone-Air")).toBe(
      "dynamic_island",
    );
    expect(classifyDisplayCutout("ios", "com.apple.CoreSimulator.SimDeviceType.iPhone-17e")).toBe(
      "dynamic_island",
    );
  });

  test("keeps an unknown model unclassified instead of guessing from camera hardware", () => {
    expect(classifyDisplayCutout("android", "future_phone_with_three_cameras")).toBe("unknown");
    expect(classifyDisplayCutout("android", "pixel_fold")).toBe("unknown");
  });
});
