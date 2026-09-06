import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  invalidateInstalledAppsCache,
  queryInstalledApps,
  setListInstalledAppsFactoryForTests,
} from "../../src/server/appResources";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { BootedDevice } from "../../src/models";

const device: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 8",
  platform: "android",
};

describe("queryInstalledApps honest-failure contract (#6155)", () => {
  let fakeDeviceUtils: FakeDeviceUtils;

  beforeEach(() => {
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [device]);
    fakeDeviceUtils.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
  });

  afterEach(() => {
    setListInstalledAppsFactoryForTests(null);
    PlatformDeviceManagerFactory.setInstance(null);
    invalidateInstalledAppsCache(device.deviceId);
  });

  test("a failed listing command (successful:false) rejects instead of reporting an empty success", async () => {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => ({
        apps: { profiles: {}, system: [] },
        successful: false,
      }),
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));

    await expect(queryInstalledApps({ deviceId: device.deviceId })).rejects.toThrow(
      `Failed to list installed apps for device ${device.deviceId}`,
    );
  });

  test("a successful listing with zero apps installed is reported as success, not an error", async () => {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => ({
        apps: { profiles: {}, system: [] },
        successful: true,
      }),
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));

    const content = await queryInstalledApps({ deviceId: device.deviceId });
    expect(content.observationComplete).toBe(true);
    expect(content.totalCount).toBe(0);
  });
});
