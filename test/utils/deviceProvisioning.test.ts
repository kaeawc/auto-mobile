import { describe, it, expect } from "bun:test";
import {
  DefaultDeviceProvisioner,
  buildCreatedDeviceName,
  isCreatedDeviceName,
  pickAndroidSystemImage,
  pickIosDeviceType,
  preferredAbis,
} from "../../src/utils/deviceProvisioning";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { ActionableError } from "../../src/models/ActionableError";
import type { AppleDeviceType } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { SystemImage } from "../../src/utils/android-cmdline-tools/avdmanager";
import { FakeAndroidAvdCreator, FakeIosSimulatorCreator } from "../fakes/FakeDeviceProvisioner";

function deviceType(name: string, productFamily = "iPhone"): AppleDeviceType {
  return {
    name,
    identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/\s+/g, "-")}`,
    productFamily,
    bundlePath: "/tmp",
    minRuntimeVersion: 0,
    maxRuntimeVersion: 0,
  };
}

function systemImage(apiLevel: number, tag: string, abi: string): SystemImage {
  return {
    packageName: `system-images;android-${apiLevel};${tag};${abi}`,
    apiLevel,
    tag,
    abi,
    versionInfo: "",
  };
}

describe("buildCreatedDeviceName", () => {
  it("uses a recognizable prefix and a deterministic injected suffix", () => {
    const name = buildCreatedDeviceName("iPhone 17 Pro", new CountingIdGenerator("uuid"));
    expect(name).toBe("AutoMobile-iPhone-17-Pro-uuid1");
    expect(isCreatedDeviceName(name)).toBe(true);
    expect(isCreatedDeviceName("Pixel_7_API_34")).toBe(false);
  });

  it("falls back to a placeholder when the base name has no usable characters", () => {
    expect(buildCreatedDeviceName("///", new CountingIdGenerator("x"))).toBe("AutoMobile-device-x1");
  });
});

describe("pickIosDeviceType", () => {
  const types = [
    deviceType("iPhone 16"),
    deviceType("iPhone 17"),
    deviceType("iPhone 17 Pro Max"),
    deviceType("iPad Pro 13-inch (M4)", "iPad"),
  ];

  it("prefers the newest base iPhone model by default", () => {
    expect(pickIosDeviceType(types, {}).name).toBe("iPhone 17");
  });

  it("honours an explicit name (case-insensitive)", () => {
    expect(pickIosDeviceType(types, { name: "iphone 16" }).name).toBe("iPhone 16");
  });

  it("selects an iPad for the tablet form factor", () => {
    expect(pickIosDeviceType(types, { formFactor: "tablet" }).name).toBe("iPad Pro 13-inch (M4)");
  });

  it("throws an actionable error when no device types exist", () => {
    expect(() => pickIosDeviceType([], {})).toThrow(ActionableError);
  });

  it("throws an actionable error when the requested family is absent", () => {
    expect(() => pickIosDeviceType([deviceType("iPhone 17")], { formFactor: "tablet" })).toThrow(
      /No iPad simulator device type/
    );
  });
});

describe("pickAndroidSystemImage tag preference", () => {
  // Play Store images refuse `adb root`, and AutoMobile needs a root shell for the
  // root-backed system-locale path (AndroidSystemConfigurationAdapter). Auto-creating
  // one would hand the user a device that cannot run changeLocalization on the API
  // levels that require root, so it must rank BELOW google_apis and default.
  it("prefers a rootable google_apis image over a same-API playstore image", () => {
    const images = [
      systemImage(35, "google_apis_playstore", "arm64-v8a"),
      systemImage(35, "google_apis", "arm64-v8a"),
      systemImage(35, "default", "arm64-v8a"),
    ];

    expect(pickAndroidSystemImage(images, {}, "arm64").packageName).toBe(
      "system-images;android-35;google_apis;arm64-v8a"
    );
  });

  it("prefers default over playstore when google_apis is unavailable", () => {
    const images = [
      systemImage(35, "google_apis_playstore", "arm64-v8a"),
      systemImage(35, "default", "arm64-v8a"),
    ];

    expect(pickAndroidSystemImage(images, {}, "arm64").packageName).toBe(
      "system-images;android-35;default;arm64-v8a"
    );
  });
});

describe("pickAndroidSystemImage", () => {
  const images = [
    systemImage(33, "default", "arm64-v8a"),
    systemImage(34, "google_apis", "arm64-v8a"),
    systemImage(34, "google_apis", "x86_64"),
    systemImage(35, "google_apis", "x86_64"),
  ];

  it("prefers the newest API level with a host-runnable ABI", () => {
    expect(pickAndroidSystemImage(images, {}, "x64").packageName).toBe(
      "system-images;android-35;google_apis;x86_64"
    );
  });

  it("prefers the host ABI when several API levels tie", () => {
    expect(pickAndroidSystemImage(images.slice(0, 3), {}, "arm64").packageName).toBe(
      "system-images;android-34;google_apis;arm64-v8a"
    );
  });

  it("respects the requested API range", () => {
    expect(pickAndroidSystemImage(images, { maxOsVersion: "34" }, "x64").apiLevel).toBe(34);
    expect(pickAndroidSystemImage(images, { minOsVersion: "35" }, "x64").apiLevel).toBe(35);
  });

  it("throws an actionable error when nothing is installed in range", () => {
    expect(() => pickAndroidSystemImage(images, { minOsVersion: "99" }, "x64")).toThrow(
      /No installed Android system image/
    );
  });

  it("maps host architecture to runnable ABIs", () => {
    expect(preferredAbis("arm64")[0]).toBe("arm64-v8a");
    expect(preferredAbis("x64")[0]).toBe("x86_64");
  });
});

describe("DefaultDeviceProvisioner", () => {
  it("creates an iOS simulator with the resolved device type and runtime", async () => {
    const simctl = new FakeIosSimulatorCreator(
      [deviceType("iPhone 17")],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "NEW-UDID"
    );
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
    });

    const created = await provisioner.provision({ platform: "ios" });

    expect(created).toEqual({
      platform: "ios",
      name: "AutoMobile-iPhone-17-uuid1",
      deviceId: "NEW-UDID",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    });
    expect(simctl.createCalls).toEqual([
      {
        name: "AutoMobile-iPhone-17-uuid1",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      },
    ]);
  });

  it("creates an Android AVD from an installed system image", async () => {
    const avd = new FakeAndroidAvdCreator([systemImage(34, "google_apis", "arm64-v8a")]);
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => avd,
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
    });

    const created = await provisioner.provision({ platform: "android" });

    expect(created).toEqual({
      platform: "android",
      name: "AutoMobile-android-34-uuid1",
      deviceType: "system-images;android-34;google_apis;arm64-v8a",
      runtime: "android-34",
    });
    expect(avd.createCalls).toEqual([
      { name: "AutoMobile-android-34-uuid1", package: "system-images;android-34;google_apis;arm64-v8a" },
    ]);
  });

  it("surfaces an actionable error when AVD creation fails", async () => {
    const avd = new FakeAndroidAvdCreator([systemImage(34, "google_apis", "arm64-v8a")]);
    avd.result = { success: false, message: "package not installed" };
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => avd,
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
    });

    await expect(provisioner.provision({ platform: "android" })).rejects.toThrow(
      /Failed to create Android AVD .*package not installed/
    );
  });

  it("reports an actionable error when simctl is unavailable", async () => {
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => new FakeAndroidAvdCreator(),
    });

    await expect(provisioner.provision({ platform: "ios" })).rejects.toThrow(
      /iOS simulator tools \(xcrun simctl\) are not available/
    );
  });
});
