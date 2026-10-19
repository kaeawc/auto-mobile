import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { describeInventoryDevice } from "../../src/daemon/inventoryDeviceDescription";
import type { StableConfiguredDeviceImage } from "../../src/utils/configuredDeviceInventory";

const heldDevice: BootedDevice = {
  platform: "android",
  name: "Unknown (emulator-5554)",
  deviceId: "emulator-5554",
};

const image: StableConfiguredDeviceImage = {
  platform: "android",
  name: "Pixel_9_API_36",
  stableId: "Pixel_9_API_36",
  isRunning: false,
  apiLevel: 36,
  osVersion: "16",
};

const images = new Map([["android:Pixel_9_API_36", image]]);

describe("describeInventoryDevice", () => {
  test("looks the configured image up by the pooled AVD name for an adb-offline held device", () => {
    const description = describeInventoryDevice({
      device: heldDevice,
      configuredImages: images,
      adbOffline: { adbState: "offline", avdName: "Pixel_9_API_36" },
    });
    expect(description.apiLevel).toBe(36);
    expect(description.identity.stableId).toBe("Pixel_9_API_36");
    expect(description.runtime.connection).toEqual({ state: "offline", adbState: "offline" });
  });

  test("without an AVD name the device's own name is the lookup key", () => {
    const description = describeInventoryDevice({ device: heldDevice, configuredImages: images });
    expect(description.apiLevel).toBeNull();
  });

  test("a transport-resolved AVD name names the stable identity of a virtual device", () => {
    const description = describeInventoryDevice({
      device: { ...heldDevice, name: "emulator-5554" },
      configuredImages: new Map(),
      transportAvdName: "Pixel_9_API_36",
    });
    expect(description.isVirtual).toBe(true);
    expect(description.identity).toEqual({ stableId: "Pixel_9_API_36" });
  });
});
