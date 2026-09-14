import { afterEach, describe, expect, test } from "bun:test";
import { listBootedDevicesForResource } from "../../src/server/resourceDeviceResolver";
import type { BootedDevice } from "../../src/models";
import type { PlatformDeviceManager } from "../../src/utils/deviceUtils";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";

const device: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 8",
  platform: "android",
};

describe("listBootedDevicesForResource", () => {
  afterEach(() => {
    PlatformDeviceManagerFactory.setInstance(null);
  });

  test("uses legacy discovery when no abort signal is supplied", async () => {
    let legacyCalls = 0;
    const legacyOnlyManager = {
      getBootedDevices: async () => {
        legacyCalls++;
        return [device];
      },
    };
    PlatformDeviceManagerFactory.setInstance(legacyOnlyManager as unknown as PlatformDeviceManager);

    await expect(listBootedDevicesForResource("android", "test")).resolves.toEqual([device]);
    expect(legacyCalls).toBe(1);
  });

  test("forwards an abort signal through detailed discovery", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const detailedManager = {
      getBootedDevices: async () => {
        throw new Error("legacy discovery should not be used with an abort signal");
      },
      getBootedDevicesDetailed: async (_platform: string, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        options?.signal?.throwIfAborted();
        return { devices: [device], succeededPlatforms: new Set(["android"]) };
      },
    };
    PlatformDeviceManagerFactory.setInstance(detailedManager as unknown as PlatformDeviceManager);

    controller.abort();
    await expect(
      listBootedDevicesForResource("android", "test", { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(receivedSignal).toBe(controller.signal);
  });
});
