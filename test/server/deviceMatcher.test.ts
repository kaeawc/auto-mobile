import { describe, it, expect } from "bun:test";
import { DefaultDeviceMatcher, compareVersions } from "../../src/server/deviceMatcher";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { SeededRandom } from "../fakes/SeededRandom";

const matcher = new DefaultDeviceMatcher();

function bootedDevice(overrides: Partial<BootedDevice> & { deviceId: string }): BootedDevice {
  return {
    name: "Test Device",
    platform: "android",
    ...overrides,
  };
}

function deviceImage(overrides: Partial<DeviceInfo> & { name: string }): DeviceInfo {
  return {
    platform: "android",
    isRunning: false,
    ...overrides,
  };
}

describe("compareVersions", () => {
  it("compares simple versions", () => {
    expect(compareVersions("14", "13")).toBeGreaterThan(0);
    expect(compareVersions("13", "14")).toBeLessThan(0);
    expect(compareVersions("14", "14")).toBe(0);
  });

  it("compares semver versions", () => {
    expect(compareVersions("17.2", "17.1")).toBeGreaterThan(0);
    expect(compareVersions("17.2", "17.2")).toBe(0);
    expect(compareVersions("17.1.1", "17.2")).toBeLessThan(0);
  });

  it("treats missing parts as zero", () => {
    expect(compareVersions("17", "17.0")).toBe(0);
    expect(compareVersions("17.0.0", "17")).toBe(0);
    expect(compareVersions("17.1", "17")).toBeGreaterThan(0);
  });

  it("orders quarterly-release suffixes after their bare release", () => {
    expect(compareVersions("14", "14-QPR1")).toBeLessThan(0);
    expect(compareVersions("14-QPR1", "14")).toBeGreaterThan(0);
    expect(compareVersions("14-QPR2", "14-QPR1")).toBeGreaterThan(0);
    expect(compareVersions("15-QPR1", "14")).toBeGreaterThan(0);
  });

  it("does not order a codename against a numeric release", () => {
    expect(Number.isNaN(compareVersions("Tiramisu", "14"))).toBe(true);
    expect(Number.isNaN(compareVersions("Tiramisu", "Tiramisu"))).toBe(false);
    expect(compareVersions("Tiramisu", "Tiramisu")).toBe(0);
  });
});

describe("DefaultDeviceMatcher.matchBootedDevice", () => {
  it("filters by platform", () => {
    const devices = [
      bootedDevice({ deviceId: "1", platform: "android", osVersion: "14" }),
      bootedDevice({ deviceId: "2", platform: "ios", osVersion: "17.2" }),
    ];

    const result = matcher.matchBootedDevice({ platform: "ios" }, devices, "LATEST");
    expect(result?.deviceId).toBe("2");
  });

  it("filters by minOsVersion", () => {
    const devices = [
      bootedDevice({ deviceId: "1", osVersion: "13" }),
      bootedDevice({ deviceId: "2", osVersion: "14" }),
      bootedDevice({ deviceId: "3", osVersion: "15" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", minOsVersion: "14" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("3");
  });

  it("filters by maxOsVersion", () => {
    const devices = [
      bootedDevice({ deviceId: "1", osVersion: "13" }),
      bootedDevice({ deviceId: "2", osVersion: "14" }),
      bootedDevice({ deviceId: "3", osVersion: "15" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", maxOsVersion: "14" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("2");
  });

  it("accepts a point release under a major-only maxOsVersion bound (#6132)", () => {
    // AvdConfigReader.versionToApiLevelRange widens a major-only maxOsVersion
    // like "8" to the whole API-level span for that major (26-27), so
    // provisioning with only android-27 installed can create an "8.1" AVD.
    // The matcher must accept that AVD on the identical follow-up
    // createIfMissing request instead of rejecting it as 8.1 > 8 and
    // re-provisioning forever.
    const devices = [bootedDevice({ deviceId: "1", osVersion: "8.1" })];

    const result = matcher.matchBootedDevice(
      { platform: "android", maxOsVersion: "8" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("1");
  });

  it("still rejects a later major under a major-only maxOsVersion bound", () => {
    const devices = [bootedDevice({ deviceId: "1", osVersion: "9" })];

    const result = matcher.matchBootedDevice(
      { platform: "android", maxOsVersion: "8" },
      devices,
      "LATEST",
    );
    expect(result).toBeNull();
  });

  it("rejects a point release under a dotted maxOsVersion bound (does not widen)", () => {
    // A dotted bound like "17.2" names an exact inclusive endpoint -- unlike
    // a major-only bound, it must NOT gain wildcard/prefix semantics. A
    // device reporting "17.2.1" (e.g. iOS's three-component os_version) is
    // genuinely newer than "17.2" and must be rejected.
    const devices = [bootedDevice({ deviceId: "1", platform: "ios", osVersion: "17.2.1" })];

    const result = matcher.matchBootedDevice(
      { platform: "ios", maxOsVersion: "17.2" },
      devices,
      "LATEST",
    );
    expect(result).toBeNull();
  });

  it("accepts an exact match under a dotted maxOsVersion bound", () => {
    const devices = [bootedDevice({ deviceId: "1", platform: "ios", osVersion: "17.2" })];

    const result = matcher.matchBootedDevice(
      { platform: "ios", maxOsVersion: "17.2" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("1");
  });

  it("accepts a device below a lettered maxOsVersion bound (Android 12L, #6132 follow-up)", () => {
    // maxOsVersion "12L" resolves to exactly API 32 in AvdConfigReader's
    // table. If only android-31 is installed, provisioning falls back to
    // API 31, whose config.ini reports osVersion "12" (apiLevelToVersion(31)).
    // The matcher must accept that reused AVD ("12" <= "12L") instead of
    // treating one numeric and one lettered release as incomparable and
    // re-provisioning on every identical createIfMissing call.
    const devices = [bootedDevice({ deviceId: "1", osVersion: "12" })];

    const result = matcher.matchBootedDevice(
      { platform: "android", maxOsVersion: "12L" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("1");
  });

  it("accepts an exact 12L device under a lettered maxOsVersion bound", () => {
    const devices = [bootedDevice({ deviceId: "1", osVersion: "12L" })];

    const result = matcher.matchBootedDevice(
      { platform: "android", maxOsVersion: "12L" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("1");
  });

  it("rejects a device above a lettered maxOsVersion bound", () => {
    const devices = [bootedDevice({ deviceId: "1", osVersion: "13" })];

    const result = matcher.matchBootedDevice(
      { platform: "android", maxOsVersion: "12L" },
      devices,
      "LATEST",
    );
    expect(result).toBeNull();
  });

  it("rejects a lettered device against a plain major maxOsVersion bound", () => {
    // A plain "12" bound must NOT be widened to swallow "12L" -- 12L is a
    // distinct, later release than any unlettered Android 12 point release.
    const devices = [bootedDevice({ deviceId: "1", osVersion: "12L" })];

    const result = matcher.matchBootedDevice(
      { platform: "android", maxOsVersion: "12" },
      devices,
      "LATEST",
    );
    expect(result).toBeNull();
  });

  it("filters by minOsVersion and maxOsVersion together", () => {
    const devices = [
      bootedDevice({ deviceId: "1", osVersion: "13" }),
      bootedDevice({ deviceId: "2", osVersion: "14" }),
      bootedDevice({ deviceId: "3", osVersion: "15" }),
      bootedDevice({ deviceId: "4", osVersion: "16" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", minOsVersion: "14", maxOsVersion: "15" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("3");
  });

  it("LATEST returns the first candidate when versions tie", () => {
    const devices = [
      bootedDevice({ deviceId: "1", osVersion: "15" }),
      bootedDevice({ deviceId: "2", osVersion: "15" }),
    ];

    const result = matcher.matchBootedDevice({ platform: "android" }, devices, "LATEST");
    expect(result?.deviceId).toBe("1");
  });

  it("MINIMUM returns the lowest version, first candidate on ties", () => {
    const devices = [
      bootedDevice({ deviceId: "1", osVersion: "15" }),
      bootedDevice({ deviceId: "2", osVersion: "13" }),
      bootedDevice({ deviceId: "3", osVersion: "13" }),
    ];

    const result = matcher.matchBootedDevice({ platform: "android" }, devices, "MINIMUM");
    expect(result?.deviceId).toBe("2");
  });

  it("returns null when no osVersion matches range", () => {
    const devices = [
      bootedDevice({ deviceId: "1", osVersion: "12" }),
      bootedDevice({ deviceId: "2", osVersion: "16" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", minOsVersion: "14", maxOsVersion: "15" },
      devices,
      "LATEST",
    );
    expect(result).toBeNull();
  });

  it("filters by name (case-insensitive substring)", () => {
    const devices = [
      bootedDevice({ deviceId: "1", name: "iPhone 16e", osVersion: "18" }),
      bootedDevice({ deviceId: "2", name: "iPad Pro 13", osVersion: "18" }),
      bootedDevice({ deviceId: "3", name: "iPhone 15 Pro", osVersion: "17" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", name: "iphone" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("1");
  });

  it("filters by exact name match", () => {
    const devices = [
      bootedDevice({ deviceId: "1", name: "iPhone 16e", osVersion: "18" }),
      bootedDevice({ deviceId: "2", name: "iPhone 15 Pro", osVersion: "17" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", name: "iPhone 15 Pro" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("2");
  });

  it("filters by formFactor", () => {
    const devices = [
      bootedDevice({ deviceId: "1", formFactor: "phone", osVersion: "14" }),
      bootedDevice({ deviceId: "2", formFactor: "tablet", osVersion: "14" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", formFactor: "tablet" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("2");
  });

  it("filters by screenSize with tolerance", () => {
    const devices = [
      bootedDevice({ deviceId: "1", screenWidth: 1080, screenHeight: 2400, osVersion: "14" }),
      bootedDevice({ deviceId: "2", screenWidth: 800, screenHeight: 1280, osVersion: "14" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", screenSize: { width: 1080, height: 2340 } },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("1");
  });

  it("rejects screenSize outside tolerance", () => {
    const devices = [
      bootedDevice({ deviceId: "1", screenWidth: 1080, screenHeight: 2400, osVersion: "14" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", screenSize: { width: 800, height: 1280 } },
      devices,
      "LATEST",
    );
    expect(result).toBeNull();
  });

  it("LATEST strategy picks highest version", () => {
    const devices = [
      bootedDevice({ deviceId: "1", osVersion: "13" }),
      bootedDevice({ deviceId: "2", osVersion: "15" }),
      bootedDevice({ deviceId: "3", osVersion: "14" }),
    ];

    const result = matcher.matchBootedDevice({ platform: "android" }, devices, "LATEST");
    expect(result?.deviceId).toBe("2");
  });

  it("MINIMUM strategy picks lowest matching version", () => {
    const devices = [
      bootedDevice({ deviceId: "1", osVersion: "13" }),
      bootedDevice({ deviceId: "2", osVersion: "15" }),
      bootedDevice({ deviceId: "3", osVersion: "14" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", minOsVersion: "14" },
      devices,
      "MINIMUM",
    );
    expect(result?.deviceId).toBe("3");
  });

  it("RANDOM strategy returns a valid candidate", () => {
    const matcher = new DefaultDeviceMatcher(new SeededRandom(1));
    const devices = [
      bootedDevice({ deviceId: "1", osVersion: "14" }),
      bootedDevice({ deviceId: "2", osVersion: "15" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", minOsVersion: "14" },
      devices,
      "RANDOM",
    );
    expect(result).not.toBeNull();
    expect(result!.deviceId).toBe("2");
  });

  it("returns null for empty device list", () => {
    const result = matcher.matchBootedDevice({ platform: "android" }, [], "LATEST");
    expect(result).toBeNull();
  });

  it("does not silently drop a device whose osVersion has a non-numeric suffix", () => {
    // "14-QPR1" is Android 14; before the fix it parsed to NaN and was rejected
    // by BOTH the min and max filters, so the device vanished entirely (#4183).
    const devices = [bootedDevice({ deviceId: "1", osVersion: "14-QPR1" })];

    const result = matcher.matchBootedDevice(
      { platform: "android", minOsVersion: "14", maxOsVersion: "14" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("1");
  });

  it("does not let an older QPR satisfy a newer QPR minimum", () => {
    const devices = [
      bootedDevice({ deviceId: "bare", osVersion: "14" }),
      bootedDevice({ deviceId: "qpr1", osVersion: "14-QPR1" }),
      bootedDevice({ deviceId: "qpr2", osVersion: "14-QPR2" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", minOsVersion: "14-QPR2" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("qpr2");
  });

  it("prefers a QPR update over the bare release for LATEST", () => {
    const devices = [
      bootedDevice({ deviceId: "bare", osVersion: "14" }),
      bootedDevice({ deviceId: "qpr2", osVersion: "14-QPR2" }),
    ];

    const result = matcher.matchBootedDevice({ platform: "android" }, devices, "LATEST");
    expect(result?.deviceId).toBe("qpr2");
  });

  it("trims surrounding whitespace from version bounds", () => {
    const devices = [
      bootedDevice({ deviceId: "13", osVersion: "13" }),
      bootedDevice({ deviceId: "14", osVersion: "14" }),
      bootedDevice({ deviceId: "15", osVersion: "15" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", minOsVersion: " 14 ", maxOsVersion: "\t14\n" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("14");
  });

  it("does not let a codename satisfy a numeric minimum or outrank a numeric release", () => {
    const devices = [
      bootedDevice({ deviceId: "codename", osVersion: "Tiramisu" }),
      bootedDevice({ deviceId: "numeric", osVersion: "15" }),
    ];

    expect(
      matcher.matchBootedDevice({ platform: "android", minOsVersion: "14" }, devices, "LATEST")
        ?.deviceId,
    ).toBe("numeric");
    expect(matcher.matchBootedDevice({ platform: "android" }, devices, "LATEST")?.deviceId).toBe(
      "numeric",
    );
  });

  it("skips devices without osVersion when minOsVersion filter is set", () => {
    const devices = [
      bootedDevice({ deviceId: "1" }), // no osVersion
      bootedDevice({ deviceId: "2", osVersion: "14" }),
    ];

    const result = matcher.matchBootedDevice(
      { platform: "android", minOsVersion: "13" },
      devices,
      "LATEST",
    );
    expect(result?.deviceId).toBe("2");
  });
});

describe("DefaultDeviceMatcher.matchDeviceImage", () => {
  it("filters images by platform and minOsVersion", () => {
    const images = [
      deviceImage({ name: "Pixel_6_API_33", osVersion: "13" }),
      deviceImage({ name: "Pixel_7_API_34", osVersion: "14" }),
      deviceImage({ name: "iPhone 15", platform: "ios", osVersion: "17.2" }),
    ];

    const result = matcher.matchDeviceImage(
      { platform: "android", minOsVersion: "14" },
      images,
      "LATEST",
    );
    expect(result?.name).toBe("Pixel_7_API_34");
  });

  it("applies MINIMUM strategy to images", () => {
    const images = [
      deviceImage({ name: "A", osVersion: "14" }),
      deviceImage({ name: "B", osVersion: "15" }),
      deviceImage({ name: "C", osVersion: "16" }),
    ];

    const result = matcher.matchDeviceImage(
      { platform: "android", minOsVersion: "14" },
      images,
      "MINIMUM",
    );
    expect(result?.name).toBe("A");
  });

  it("filters by name", () => {
    const images = [
      deviceImage({ name: "iPhone 15", platform: "ios", osVersion: "17" }),
      deviceImage({ name: "iPhone 16e", platform: "ios", osVersion: "18" }),
      deviceImage({ name: "iPad Pro", platform: "ios", osVersion: "18" }),
    ];

    const result = matcher.matchDeviceImage(
      { platform: "ios", name: "iPhone 16" },
      images,
      "LATEST",
    );
    expect(result?.name).toBe("iPhone 16e");
  });

  it("filters images by formFactor and screenSize", () => {
    const images = [
      deviceImage({
        name: "Phone",
        formFactor: "phone",
        screenWidth: 1080,
        screenHeight: 2400,
        osVersion: "14",
      }),
      deviceImage({
        name: "Tablet",
        formFactor: "tablet",
        screenWidth: 2560,
        screenHeight: 1600,
        osVersion: "14",
      }),
    ];

    const result = matcher.matchDeviceImage(
      { platform: "android", formFactor: "tablet" },
      images,
      "LATEST",
    );
    expect(result?.name).toBe("Tablet");
  });

  it("returns null when no images match", () => {
    const images = [deviceImage({ name: "Old", osVersion: "12" })];

    const result = matcher.matchDeviceImage(
      { platform: "android", minOsVersion: "14" },
      images,
      "LATEST",
    );
    expect(result).toBeNull();
  });

  it("combines all criteria", () => {
    const images = [
      deviceImage({
        name: "A",
        osVersion: "14",
        formFactor: "phone",
        screenWidth: 1080,
        screenHeight: 2400,
      }),
      deviceImage({
        name: "B",
        osVersion: "14",
        formFactor: "tablet",
        screenWidth: 2560,
        screenHeight: 1600,
      }),
      deviceImage({
        name: "C",
        osVersion: "15",
        formFactor: "phone",
        screenWidth: 1080,
        screenHeight: 2400,
      }),
    ];

    const result = matcher.matchDeviceImage(
      {
        platform: "android",
        minOsVersion: "14",
        formFactor: "phone",
        screenSize: { width: 1080, height: 2400 },
      },
      images,
      "LATEST",
    );
    expect(result?.name).toBe("C");
  });

  it("filters with maxOsVersion on images", () => {
    const images = [
      deviceImage({ name: "A", osVersion: "14" }),
      deviceImage({ name: "B", osVersion: "15" }),
      deviceImage({ name: "C", osVersion: "16" }),
    ];

    const result = matcher.matchDeviceImage(
      { platform: "android", minOsVersion: "14", maxOsVersion: "15" },
      images,
      "LATEST",
    );
    expect(result?.name).toBe("B");
  });
});
