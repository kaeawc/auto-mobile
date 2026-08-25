import { describe, expect, test } from "bun:test";
import { MultiPlatformDeviceManager } from "../../src/utils/deviceUtils";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import type { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import type { VirtualDeviceLifecycleCoordinator } from "../../src/utils/virtualDeviceLifecycleCoordinator";
import { FakeTimer } from "../fakes/FakeTimer";
import type { IosPhysicalDeviceLister } from "../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";

async function withProcessPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", {
      value: original,
      configurable: true,
    });
  }
}

describe("MultiPlatformDeviceManager", () => {
  describe("physical iOS device discovery (#5620)", () => {
    const physicalDevice: BootedDevice = {
      name: "Jason's iPhone",
      platform: "ios",
      deviceId: "00008120-001C2D3E1234567A",
    };
    const simulator: BootedDevice = {
      name: "iPhone 16",
      platform: "ios",
      deviceId: "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6",
    };

    function makeManager(options: {
      simulators?: BootedDevice[] | Error;
      physical?: BootedDevice[] | Error;
    }): MultiPlatformDeviceManager {
      const resolve = <T>(value: T | Error): Promise<T> =>
        value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      const fakeSimctl = {
        isAvailable: async () => true,
        getBootedSimulators: () => resolve(options.simulators ?? []),
        getBootedSimulatorsChecked: () => resolve(options.simulators ?? []),
      } as unknown as SimCtlClient;
      const fakeLister: IosPhysicalDeviceLister = {
        listConnectedDevices: () => resolve(options.physical ?? []),
      };

      return new MultiPlatformDeviceManager(
        new FakeAdbClient() as unknown as AdbClient,
        fakeSimctl,
        { getBootedDevices: async () => [] } as unknown as AndroidEmulatorClient,
        undefined,
        undefined,
        fakeLister,
      );
    }

    test("a simulator-only host still lists only its simulators", async () => {
      await withProcessPlatform("darwin", async () => {
        const manager = makeManager({ simulators: [simulator], physical: [] });

        expect(await manager.getBootedDevices("ios")).toEqual([simulator]);
      });
    });

    test("a physical-only host resolves the physical device as a booted iOS device", async () => {
      await withProcessPlatform("darwin", async () => {
        const manager = makeManager({ simulators: [], physical: [physicalDevice] });

        const devices = await manager.getBootedDevices("ios");

        expect(devices).toEqual([physicalDevice]);
        expect(devices[0].platform).toBe("ios");
      });
    });

    test("a host with both reports simulators and physical devices together", async () => {
      await withProcessPlatform("darwin", async () => {
        const manager = makeManager({ simulators: [simulator], physical: [physicalDevice] });

        expect(await manager.getBootedDevices("ios")).toEqual([simulator, physicalDevice]);
      });
    });

    test("a host where devicectl is unavailable degrades instead of throwing", async () => {
      await withProcessPlatform("darwin", async () => {
        const manager = makeManager({
          simulators: [simulator],
          physical: new Error('xcrun: error: unable to find utility "devicectl"'),
        });

        expect(await manager.getBootedDevices("ios")).toEqual([simulator]);
      });
    });

    test("getBootedDevicesDetailed includes physical devices and still succeeds", async () => {
      await withProcessPlatform("darwin", async () => {
        const manager = makeManager({ simulators: [simulator], physical: [physicalDevice] });

        const discovery = await manager.getBootedDevicesDetailed("ios");

        expect(discovery.devices).toEqual([simulator, physicalDevice]);
        expect(discovery.succeededPlatforms.has("ios")).toBe(true);
      });
    });

    test("a simulator discovery failure still surfaces connected physical devices", async () => {
      await withProcessPlatform("darwin", async () => {
        const manager = makeManager({
          simulators: new Error("simctl exploded"),
          physical: [physicalDevice],
        });

        const discovery = await manager.getBootedDevicesDetailed("ios");

        expect(discovery.devices).toEqual([physicalDevice]);
        expect(discovery.succeededPlatforms.has("ios")).toBe(false);
        expect(discovery.discoveryErrors.ios?.code).toBe("failed");
      });
    });

    test("physical discovery is not attempted when iOS tooling is unavailable", async () => {
      await withProcessPlatform("linux", async () => {
        let listerCalls = 0;
        const fakeSimctl = {
          isAvailable: async () => false,
          getBootedSimulators: async () => [],
          getBootedSimulatorsChecked: async () => [],
        } as unknown as SimCtlClient;
        const manager = new MultiPlatformDeviceManager(
          new FakeAdbClient() as unknown as AdbClient,
          fakeSimctl,
          { getBootedDevices: async () => [] } as unknown as AndroidEmulatorClient,
          undefined,
          undefined,
          {
            listConnectedDevices: async () => {
              listerCalls++;
              return [physicalDevice];
            },
          },
        );

        expect(await manager.getBootedDevices("ios")).toEqual([]);
        expect(listerCalls).toBe(0);
      });
    });
  });

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
      getBootedSimulators: async () => [
        { name: "iPhone 15", platform: "ios", deviceId: "booted-1" },
      ],
      isSimulatorRunning: async () => {
        throw new Error("should not use name-based check when deviceId is present");
      },
    } as unknown as SimCtlClient;

    // Use FakeAdbClient to avoid starting real adb daemon
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient() as unknown as AdbClient,
      fakeSimctl,
      null,
    );
    const device: DeviceInfo = {
      name: "iPhone 15",
      platform: "ios",
      isRunning: false,
      deviceId: "booted-1",
    };

    const isRunning = await manager.isDeviceImageRunning(device);

    expect(isRunning).toBe(true);
  });

  test("isDeviceImageRunning falls back to name-based check for iOS without UDID", async () => {
    const fakeSimctl = {
      isAvailable: async () => true,
      getBootedSimulators: async () => [],
      isSimulatorRunning: async (name: string) => name === "iPhone 15",
    } as unknown as SimCtlClient;

    // Use FakeAdbClient to avoid starting real adb daemon
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient() as unknown as AdbClient,
      fakeSimctl,
      null,
    );
    const device: DeviceInfo = {
      name: "iPhone 15",
      platform: "ios",
      isRunning: false,
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
        deviceId: "emulator-5554",
      };
      const fakeSimctl = {
        isAvailable: async () => false,
        getBootedSimulators: async () => {
          simctlListCalls++;
          throw new Error("simctl should not be queried");
        },
      } as unknown as SimCtlClient;
      const fakeEmulator = {
        getBootedDevices: async () => [androidDevice],
      } as unknown as AndroidEmulatorClient;

      const manager = new MultiPlatformDeviceManager(
        new FakeAdbClient() as unknown as AdbClient,
        fakeSimctl,
        fakeEmulator,
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
        deviceId: "emulator-5554",
      };
      const fakeSimctl = {
        isAvailable: async () => true,
        getBootedSimulators: async () => {
          throw new Error("simctl unavailable");
        },
      } as unknown as SimCtlClient;
      const fakeEmulator = {
        getBootedDevices: async () => [androidDevice],
      } as unknown as AndroidEmulatorClient;

      const manager = new MultiPlatformDeviceManager(
        new FakeAdbClient() as unknown as AdbClient,
        fakeSimctl,
        fakeEmulator,
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
        isRunning: false,
      };
      const fakeSimctl = {
        isAvailable: async () => false,
        listSimulatorImages: async () => {
          simctlListCalls++;
          throw new Error("simctl should not be queried");
        },
      } as unknown as SimCtlClient;
      const fakeEmulator = {
        listAvds: async () => [androidImage],
      } as unknown as AndroidEmulatorClient;

      const manager = new MultiPlatformDeviceManager(
        new FakeAdbClient() as unknown as AdbClient,
        fakeSimctl,
        fakeEmulator,
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
        isRunning: false,
      };
      const fakeSimctl = {
        isAvailable: async () => true,
        listSimulatorImages: async () => {
          throw new Error("simctl unavailable");
        },
      } as unknown as SimCtlClient;
      const fakeEmulator = {
        listAvds: async () => [androidImage],
      } as unknown as AndroidEmulatorClient;

      const manager = new MultiPlatformDeviceManager(
        new FakeAdbClient() as unknown as AdbClient,
        fakeSimctl,
        fakeEmulator,
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
      },
    } as unknown as SimCtlClient;
    const fakeEmulator = {
      listAvds: async () => [],
    } as unknown as AndroidEmulatorClient;

    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient() as unknown as AdbClient,
      fakeSimctl,
      fakeEmulator,
    );

    await expect(manager.listDeviceImages("ios")).rejects.toThrow(/simctl list devices exploded/);
  });

  test("getDeviceImagesDetailed retains Android results and records an incomplete iOS inventory", async () => {
    const androidImage: DeviceInfo = {
      name: "Pixel_8",
      platform: "android",
      isRunning: false,
    };
    const fakeSimctl = {
      isAvailable: async () => true,
      listSimulatorImages: async () => {
        throw new Error("simctl list devices exploded");
      },
    } as unknown as SimCtlClient;
    const fakeEmulator = {
      listAvds: async () => [androidImage],
    } as unknown as AndroidEmulatorClient;
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient() as unknown as AdbClient,
      fakeSimctl,
      fakeEmulator,
    );

    const result = await manager.getDeviceImagesDetailed("either");

    expect(result.devices).toEqual([androidImage]);
    expect(result.succeededPlatforms).toEqual(new Set(["android"]));
    expect(result.discoveryErrors?.ios).toEqual({
      code: "failed",
      message: "iOS device inventory failed: simctl list devices exploded",
    });
  });

  test("destroyDevice deletes an iOS simulator by its exact UDID with the caller deadline", async () => {
    const controller = new AbortController();
    let request:
      | { udid: string; options?: { timeoutMs?: number; signal?: AbortSignal } }
      | undefined;
    const fakeSimctl = {
      deleteSimulator: async (
        udid: string,
        options?: { timeoutMs?: number; signal?: AbortSignal },
      ) => {
        request = { udid, options };
      },
    } as unknown as SimCtlClient;
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient() as unknown as AdbClient,
      fakeSimctl,
      {} as AndroidEmulatorClient,
    );

    await manager.destroyDevice(
      {
        name: "iPhone 16",
        platform: "ios",
        deviceId: "IOS-DEVICE-1",
        isRunning: false,
      },
      {
        timeoutMs: 12_345,
        signal: controller.signal,
      },
    );

    expect(request).toEqual({
      udid: "IOS-DEVICE-1",
      options: {
        timeoutMs: 12_345,
        signal: controller.signal,
      },
    });
  });

  test("uses the injected clock for a destroy lifecycle deadline", async () => {
    const timer = new FakeTimer();
    timer.advanceTime(4_000);
    let reservedDeadlineMs: number | undefined;
    const lifecycleCoordinator: VirtualDeviceLifecycleCoordinator = {
      reserve: async (identity, options) => {
        reservedDeadlineMs = options.deadlineMs;
        return {
          identity,
          signal: new AbortController().signal,
          bindCanonicalIdentity: async () => {},
          release: () => {},
        };
      },
    };
    const fakeSimctl = {
      deleteSimulator: async () => {},
    } as unknown as SimCtlClient;
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient() as unknown as AdbClient,
      fakeSimctl,
      {} as AndroidEmulatorClient,
      lifecycleCoordinator,
      timer,
    );

    await manager.destroyDevice(
      {
        name: "iPhone 16",
        platform: "ios",
        deviceId: "IOS-DEVICE-1",
        isRunning: false,
      },
      { timeoutMs: 12_345 },
    );

    expect(reservedDeadlineMs).toBe(16_345);
  });
});
