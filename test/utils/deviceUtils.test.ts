import { describe, expect, test } from "bun:test";
import { MultiPlatformDeviceManager } from "../../src/utils/deviceUtils";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import type { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { runWithAbortSignal } from "../../src/utils/AbortContext";

async function withProcessPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", {
      value: original,
      configurable: true
    });
  }
}

describe("MultiPlatformDeviceManager", () => {
  test("forwards ambient cancellation to Android detailed discovery", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const emulator = {
      getBootedDevicesChecked: async (
        _onlyEmulators: boolean,
        _options: { bypassDeviceListCache?: boolean },
        signal?: AbortSignal,
      ): Promise<BootedDevice[]> => {
        receivedSignal = signal;
        return [];
      },
    } as unknown as AndroidEmulatorClient;
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient() as unknown as AdbClient,
      {} as SimCtlClient,
      emulator,
    );

    await runWithAbortSignal(controller.signal, () => manager.getBootedDevicesDetailed("android"));

    expect(receivedSignal).toBe(controller.signal);
  });

  test("isDeviceImageRunning uses UDID when present for iOS", async () => {
    const fakeSimctl = {
      isAvailable: async () => true,
      getBootedSimulators: async () => [{ name: "iPhone 15", platform: "ios", deviceId: "booted-1" }],
      isSimulatorRunning: async () => {
        throw new Error("should not use name-based check when deviceId is present");
      }
    } as unknown as SimCtlClient;

    // Use FakeAdbClient to avoid starting real adb daemon
    const manager = new MultiPlatformDeviceManager(new FakeAdbClient() as unknown as AdbClient, fakeSimctl, null);
    const device: DeviceInfo = {
      name: "iPhone 15",
      platform: "ios",
      isRunning: false,
      deviceId: "booted-1"
    };

    const isRunning = await manager.isDeviceImageRunning(device);

    expect(isRunning).toBe(true);
  });

  test("isDeviceImageRunning falls back to name-based check for iOS without UDID", async () => {
    const fakeSimctl = {
      isAvailable: async () => true,
      getBootedSimulators: async () => [],
      isSimulatorRunning: async (name: string) => name === "iPhone 15"
    } as unknown as SimCtlClient;

    // Use FakeAdbClient to avoid starting real adb daemon
    const manager = new MultiPlatformDeviceManager(new FakeAdbClient() as unknown as AdbClient, fakeSimctl, null);
    const device: DeviceInfo = {
      name: "iPhone 15",
      platform: "ios",
      isRunning: false
    };

    const isRunning = await manager.isDeviceImageRunning(device);

    expect(isRunning).toBe(true);
  });

  test("getBootedDevices(either) skips iOS discovery on non-darwin when simctl is unavailable", async () => {
    await withProcessPlatform("linux", async () => {
      let simctlListCalls = 0;
      const androidDevice: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554"
      };
      const fakeSimctl = {
        isAvailable: async () => false,
        getBootedSimulators: async () => {
          simctlListCalls++;
          throw new Error("simctl should not be queried");
        }
      } as unknown as SimCtlClient;
      const fakeEmulator = {
        getBootedDevices: async () => [androidDevice]
      } as unknown as AndroidEmulatorClient;

      const manager = new MultiPlatformDeviceManager(
        new FakeAdbClient() as unknown as AdbClient,
        fakeSimctl,
        fakeEmulator
      );

      const devices = await manager.getBootedDevices("either");

      expect(devices).toEqual([androidDevice]);
      expect(simctlListCalls).toBe(0);
    });
  });

  test("getBootedDevices(either) preserves Android results when non-darwin iOS discovery fails after availability", async () => {
    await withProcessPlatform("linux", async () => {
      const androidDevice: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554"
      };
      const fakeSimctl = {
        isAvailable: async () => true,
        getBootedSimulators: async () => {
          throw new Error("simctl unavailable");
        }
      } as unknown as SimCtlClient;
      const fakeEmulator = {
        getBootedDevices: async () => [androidDevice]
      } as unknown as AndroidEmulatorClient;

      const manager = new MultiPlatformDeviceManager(
        new FakeAdbClient() as unknown as AdbClient,
        fakeSimctl,
        fakeEmulator
      );

      const devices = await manager.getBootedDevices("either");

      expect(devices).toEqual([androidDevice]);
    });
  });

  test("listDeviceImages(either) skips iOS image discovery on non-darwin when simctl is unavailable", async () => {
    await withProcessPlatform("linux", async () => {
      let simctlListCalls = 0;
      const androidImage: DeviceInfo = {
        name: "Pixel_8",
        platform: "android",
        isRunning: false
      };
      const fakeSimctl = {
        isAvailable: async () => false,
        listSimulatorImages: async () => {
          simctlListCalls++;
          throw new Error("simctl should not be queried");
        }
      } as unknown as SimCtlClient;
      const fakeEmulator = {
        listAvds: async () => [androidImage]
      } as unknown as AndroidEmulatorClient;

      const manager = new MultiPlatformDeviceManager(
        new FakeAdbClient() as unknown as AdbClient,
        fakeSimctl,
        fakeEmulator
      );

      const devices = await manager.listDeviceImages("either");

      expect(devices).toEqual([androidImage]);
      expect(simctlListCalls).toBe(0);
    });
  });

  test("listDeviceImages(either) preserves Android results when non-darwin iOS image discovery fails after availability", async () => {
    await withProcessPlatform("linux", async () => {
      const androidImage: DeviceInfo = {
        name: "Pixel_8",
        platform: "android",
        isRunning: false
      };
      const fakeSimctl = {
        isAvailable: async () => true,
        listSimulatorImages: async () => {
          throw new Error("simctl unavailable");
        }
      } as unknown as SimCtlClient;
      const fakeEmulator = {
        listAvds: async () => [androidImage]
      } as unknown as AndroidEmulatorClient;

      const manager = new MultiPlatformDeviceManager(
        new FakeAdbClient() as unknown as AdbClient,
        fakeSimctl,
        fakeEmulator
      );

      const devices = await manager.listDeviceImages("either");

      expect(devices).toEqual([androidImage]);
    });
  });

  test("listDeviceImages(ios) surfaces iOS image discovery failures", async () => {
    const fakeSimctl = {
      isAvailable: async () => true,
      listSimulatorImages: async () => {
        throw new Error("simctl list devices exploded");
      }
    } as unknown as SimCtlClient;
    const fakeEmulator = {
      listAvds: async () => []
    } as unknown as AndroidEmulatorClient;

    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient() as unknown as AdbClient,
      fakeSimctl,
      fakeEmulator
    );

    await expect(manager.listDeviceImages("ios")).rejects.toThrow(/simctl list devices exploded/);
  });

});
