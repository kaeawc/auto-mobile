import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import {
  configuredImageForBootedDevice,
  type StableConfiguredDeviceImage,
} from "../../src/utils/configuredDeviceInventory";

describe("configuredImageForBootedDevice", () => {
  const configured: StableConfiguredDeviceImage = {
    stableId: "Pixel_9_API_36",
    name: "Pixel_9_API_36",
    platform: "android",
    isRunning: false,
  };
  const configuredImages = new Map([["android:Pixel_9_API_36", configured]]);

  test("does not match a physical Android device by configured AVD name", () => {
    const physicalDevice: BootedDevice = {
      name: "Pixel_9_API_36",
      platform: "android",
      deviceId: "R58N90ABCDE",
    };

    expect(configuredImageForBootedDevice(physicalDevice, configuredImages)).toBeUndefined();
  });

  test("matches an Android emulator by configured AVD name", () => {
    const emulator: BootedDevice = {
      name: "Pixel_9_API_36",
      platform: "android",
      deviceId: "emulator-5554",
    };

    expect(configuredImageForBootedDevice(emulator, configuredImages)).toBe(configured);
  });
});
