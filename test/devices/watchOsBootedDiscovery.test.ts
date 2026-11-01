import { describe, expect, test } from "bun:test";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import { withProcessPlatform } from "../helpers/devicePoolSuite";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";

// Booted Apple Watch simulators come from their own sweep and source. A plain "either" read stays
// Android and iOS; only the pool's own readers ask for watches (#14908).

const ANDROID: BootedDevice = { name: "Pixel 9", platform: "android", deviceId: "emulator-5554" };
const IPHONE: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6",
};
const WATCH_UDID = "6B1F3C2E-0000-4000-8000-00000000A7C1";

function watchInfo(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    name: "Apple Watch Series 10 (46mm)",
    platform: "watchos",
    deviceId: WATCH_UDID,
    isRunning: true,
    state: "Booted",
    ...overrides,
  };
}

class FakeWatchList {
  watches: DeviceInfo[] = [];
  error: Error | undefined;
  calls = 0;

  async listWatchSimulators(): Promise<DeviceInfo[]> {
    this.calls++;
    if (this.error) {
      throw this.error;
    }
    return this.watches;
  }
}

function managerWith(watches?: FakeWatchList): MultiPlatformDeviceManager {
  const manager = new MultiPlatformDeviceManager(
    new FakeAdbClient(),
    fakeDeviceManagerSimctl({
      isAvailable: async () => true,
      getBootedSimulatorsChecked: async () => [IPHONE],
    }),
    createFakeAndroidEmulator({ getBootedDevicesChecked: async () => [ANDROID] }),
    { physicalIosDevices: { listConnectedDevices: async () => ({ devices: [], complete: true }) } },
  );
  return watches ? manager.withWatchSimulators(watches) : manager;
}

describe("booted Apple Watch discovery", () => {
  test("a watchos read lists booted watches only, under the watch source", async () => {
    const watches = new FakeWatchList();
    watches.watches = [watchInfo(), watchInfo({ deviceId: "SHUTDOWN", isRunning: false })];

    const discovery = await managerWith(watches).getBootedDevicesDetailed("watchos");

    expect(discovery).toEqual({
      devices: [
        { name: "Apple Watch Series 10 (46mm)", platform: "watchos", deviceId: WATCH_UDID },
      ],
      succeededPlatforms: new Set(["watchos"]),
      succeededSources: new Set(["watchos-simulator"]),
      freshDeviceIds: new Set([WATCH_UDID]),
      discoveryErrors: {},
    });
  });

  test("a plain either read never sweeps watches", async () => {
    await withProcessPlatform("darwin", async () => {
      const watches = new FakeWatchList();
      watches.watches = [watchInfo()];

      const discovery = await managerWith(watches).getBootedDevicesDetailed("either");

      expect(watches.calls).toBe(0);
      expect(discovery.devices).toEqual([ANDROID, IPHONE]);
      expect(discovery.succeededSources?.has("watchos-simulator")).toBe(false);
    });
  });

  test("the pool's either read with includeWatchOs adds watches beside Android and iOS", async () => {
    await withProcessPlatform("darwin", async () => {
      const watches = new FakeWatchList();
      watches.watches = [watchInfo()];

      const discovery = await managerWith(watches).getBootedDevicesDetailed("either", {
        includeWatchOs: true,
      });

      expect(discovery.devices.map((device) => device.platform)).toEqual([
        "android",
        "ios",
        "watchos",
      ]);
      expect(discovery.succeededPlatforms).toEqual(new Set(["android", "ios", "watchos"]));
      expect(discovery.succeededSources?.has("watchos-simulator")).toBe(true);
    });
  });

  test("a failed watch sweep is an unknown, never an empty watch list", async () => {
    const watches = new FakeWatchList();
    watches.error = new Error("simctl list timed out");

    const discovery = await managerWith(watches).getBootedDevicesDetailed("watchos");

    expect(discovery.devices).toEqual([]);
    expect(discovery.succeededPlatforms.has("watchos")).toBe(false);
    expect(discovery.succeededSources?.has("watchos-simulator")).toBe(false);
    expect(discovery.discoveryErrors?.watchos).toEqual({
      code: "failed",
      message: "watchOS simulator discovery failed: simctl list timed out",
    });
  });

  test("without a watch source the watch sweep reports unavailable", async () => {
    const discovery = await managerWith().getBootedDevicesDetailed("watchos");

    expect(discovery.discoveryErrors?.watchos?.code).toBe("unavailable");
    expect(discovery.succeededPlatforms.size).toBe(0);
  });
});
