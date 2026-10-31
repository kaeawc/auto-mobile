import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import type { BootedDevice, DeviceInfo, Platform } from "../../src/models";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import {
  runDeviceManagerContract,
  runImageIdentityContract,
  type ScriptedDeviceManager,
} from "./DeviceManagerContract";

function scriptedFake(): ScriptedDeviceManager {
  const fake = new FakeDeviceUtils();
  return {
    manager: fake,
    setImages: (platform, images) => fake.setDeviceImages(platform, images),
    setBooted: (platform, devices) => fake.setBootedDevices(platform, devices),
    failBootedDiscovery: (platform) => fake.failedPlatforms.add(platform),
  };
}

// The real manager runs over stubbed emulator and simctl seams: no adb, no Xcode, no device.
function scriptedReal(): ScriptedDeviceManager {
  const images: Record<Platform, DeviceInfo[]> = { android: [], ios: [], watchos: [] };
  const booted: Record<Platform, BootedDevice[]> = { android: [], ios: [], watchos: [] };
  const failing = new Set<Platform>();
  const androidBooted = async (): Promise<BootedDevice[]> => {
    if (failing.has("android")) {
      throw new Error("adb devices failed");
    }
    return booted.android;
  };
  const manager = new MultiPlatformDeviceManager(
    new FakeAdbClient(),
    fakeDeviceManagerSimctl({
      isAvailable: async () => true,
      listSimulatorImages: async () => images.ios,
      getBootedSimulators: async () => booted.ios,
      getBootedSimulatorsChecked: async () => booted.ios,
      deleteSimulator: async (deviceId: string) => {
        images.ios = images.ios.filter((image) => image.deviceId !== deviceId);
      },
    }),
    createFakeAndroidEmulator({
      listAvds: async () => images.android.map((image) => ({ ...image, isRunning: false })),
      getBootedDevices: androidBooted,
      getBootedDevicesChecked: androidBooted,
    }),
    { physicalIosDevices: { listConnectedDevices: async () => ({ devices: [], complete: true }) } },
  );
  return {
    manager,
    setImages: (platform, list) => {
      images[platform] = list;
    },
    setBooted: (platform, list) => {
      booted[platform] = list;
    },
    failBootedDiscovery: (platform) => {
      failing.add(platform);
    },
  };
}

runDeviceManagerContract("FakeDeviceUtils", scriptedFake);
runDeviceManagerContract("MultiPlatformDeviceManager (stubbed seams)", scriptedReal);

function scriptedFakeManager(): ScriptedDeviceManager {
  const fake = new FakeDeviceManager();
  const replace = <T extends { platform: Platform }>(list: T[], platform: Platform, next: T[]) => [
    ...list.filter((item) => item.platform !== platform),
    ...next,
  ];
  return {
    manager: fake,
    setImages: (platform, images) => {
      fake.deviceImages = replace(fake.deviceImages, platform, images);
    },
    setBooted: (platform, devices) => {
      fake.bootedDevices = replace(fake.bootedDevices, platform, devices);
    },
    failBootedDiscovery: (platform) => fake.failedPlatforms.add(platform),
  };
}

runImageIdentityContract("FakeDeviceUtils", scriptedFake);
runImageIdentityContract("FakeDeviceManager", scriptedFakeManager);
runImageIdentityContract("MultiPlatformDeviceManager (stubbed seams)", scriptedReal);
