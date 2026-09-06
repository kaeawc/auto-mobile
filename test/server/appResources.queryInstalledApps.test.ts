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

describe("queryInstalledApps rejects an unsupported type filter on a physical iOS device (#6216 review, round 5)", () => {
  // A physical-device UDID (8 hex + '-' + 16 hex) so isIosPhysicalUdid routes
  // through the devicectl path, which reports no ApplicationType-equivalent
  // field — see isIosApplicationTypeUnclassified.
  const physicalIosDevice: BootedDevice = {
    deviceId: "00008130-001C2D3E1234567A",
    name: "Jason's iPhone",
    platform: "ios",
  };

  beforeEach(() => {
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setBootedDevices("ios", [physicalIosDevice]);
    PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        throw new Error("not exercised on iOS");
      },
      executeIosDetailedResult: async () => ({
        apps: [
          { bundleIdentifier: "com.example.myapp", name: "My App" },
          { bundleIdentifier: "com.apple.mobilesafari", name: "Safari" },
        ],
        successful: true,
      }),
    }));
  });

  afterEach(() => {
    setListInstalledAppsFactoryForTests(null);
    PlatformDeviceManagerFactory.setInstance(null);
    invalidateInstalledAppsCache(physicalIosDevice.deviceId);
  });

  test("an explicit type=system is rejected rather than silently returning an empty result", async () => {
    await expect(
      queryInstalledApps({ deviceId: physicalIosDevice.deviceId, type: "system" }),
    ).rejects.toThrow(/classification is not available on this transport/);
  });

  test("an explicit type=user is also rejected (classification, not just 'system', is unreliable)", async () => {
    await expect(
      queryInstalledApps({ deviceId: physicalIosDevice.deviceId, type: "user" }),
    ).rejects.toThrow(/classification is not available on this transport/);
  });

  test("type=all still returns every app (no rejection)", async () => {
    const content = await queryInstalledApps({
      deviceId: physicalIosDevice.deviceId,
      type: "all",
    });
    expect(content.totalCount).toBe(2);
  });

  test("an omitted type filter also still returns every app (no rejection)", async () => {
    // Every unclassified physical-device app already defaults to "user"
    // (round 4), so the documented "user" default is a no-op filter here —
    // over-inclusive, not misleadingly empty — and must not be rejected.
    const content = await queryInstalledApps({ deviceId: physicalIosDevice.deviceId });
    expect(content.totalCount).toBe(2);
  });

  test('an omitted type filter reports query.type as "all", not the misleading "user" default (#6216 review, round 6)', async () => {
    // devicectl's --include-all-apps listing (DeviceAppManager) already
    // includes system records, and every unclassified app defaults to type
    // "user" (round 4) — so applying the normal "user" default filter here
    // would let system apps straight through while the response still
    // claimed `query.type: "user"`. That is the over-inclusive-but-mislabeled
    // result Codex flagged: report the effective type honestly as "all".
    const content = await queryInstalledApps({ deviceId: physicalIosDevice.deviceId });
    expect(content.query.type).toBe("all");
    expect(content.totalCount).toBe(2);
  });
});

describe("queryInstalledApps still honors type filters on the iOS simulator (#6216 review, round 5)", () => {
  // A simulator UDID (standard 8-4-4-4-12 UUID) so isIosPhysicalUdid is false
  // and simctl's ApplicationType classification is trusted normally.
  const simulatorDevice: BootedDevice = {
    deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    name: "iPhone 15 Simulator",
    platform: "ios",
  };

  beforeEach(() => {
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setBootedDevices("ios", [simulatorDevice]);
    PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        throw new Error("not exercised on iOS");
      },
      executeIosDetailedResult: async () => ({
        apps: [
          { bundleIdentifier: "com.example.myapp", ApplicationType: "User" },
          { bundleIdentifier: "com.apple.mobilesafari", ApplicationType: "System" },
        ],
        successful: true,
      }),
    }));
  });

  afterEach(() => {
    setListInstalledAppsFactoryForTests(null);
    PlatformDeviceManagerFactory.setInstance(null);
    invalidateInstalledAppsCache(simulatorDevice.deviceId);
  });

  test("an explicit type=system is honored, not rejected, when classification is reliable", async () => {
    const content = await queryInstalledApps({
      deviceId: simulatorDevice.deviceId,
      type: "system",
    });
    expect(content.totalCount).toBe(1);
  });

  test('an omitted type filter still reports and applies the documented "user" default (#6216 review, round 6)', async () => {
    // Control case: reliable classification (simulator ApplicationType) must
    // keep the existing "user" default behavior — only the physical-device,
    // unreliable-classification case reports "all".
    const content = await queryInstalledApps({ deviceId: simulatorDevice.deviceId });
    expect(content.query.type).toBe("user");
    expect(content.totalCount).toBe(1);
  });
});
