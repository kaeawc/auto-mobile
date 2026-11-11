import { describe, expect, test } from "bun:test";
import { listAppleSimulatorFamilyImages } from "../../src/devices/appleSimulatorFamilyImages";
import { DeviceBootService } from "../../src/devices/deviceBootService";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { ActionableError, type DeviceInfo } from "../../src/models";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";

// The #16836 acceptance run (#18053): a provisioned watch, an iPhone booted, iOS images only.
const WATCH_UDID = "AEC5C81F-B29B-4A0C-976A-6081F3617E1C";
const BOOTED_IPHONE = "18A2D9B1-CDFA-445A-93AA-A532EA4B5498";
const watch: DeviceInfo = {
  name: "l16836-watch",
  platform: "watchos",
  deviceId: WATCH_UDID,
  isRunning: false,
};
const iosImages: DeviceInfo[] = ["proto-clone-probe", "iPad Pro 11-inch (M5)", "iPhone 17e"].map(
  (name, index) => ({
    name,
    platform: "ios",
    deviceId: `IOS-IMAGE-${index}`,
    isRunning: false,
  }),
);

function inventory(watches: DeviceInfo[] = [watch]): FakeDeviceUtils {
  const devices = new FakeDeviceUtils();
  devices.setBootedDevices("ios", [
    { name: "iPhone 18 Pro", platform: "ios", deviceId: BOOTED_IPHONE },
  ]);
  devices.setDeviceImages("ios", iosImages);
  devices.setDeviceImages("watchos", watches);
  devices.setDeviceImages("tvos", []);
  devices.setDeviceImages("visionos", []);
  return devices;
}

function service(devices: FakeDeviceUtils): DeviceBootService {
  return new DeviceBootService({
    deviceManager: devices,
    deviceMatcher: new FakeDeviceMatcher(),
    deviceCreationGate: { isCreationAllowed: () => false, describeSource: () => "test" },
    deviceProvisioner: {
      provision: async () => {
        throw new Error("unexpected provision");
      },
    },
    matchingStrategy: "LATEST",
    timer: new FakeTimer(),
    invalidateAndroidDeviceList: () => {},
  });
}

async function startFailure(
  devices: FakeDeviceUtils,
  request: Parameters<DeviceBootService["boot"]>[0],
) {
  const failure = await service(devices)
    .boot(request)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ActionableError);
  return failure instanceof Error ? failure.message : "";
}

describe("startDevice names the platform of a non-iOS simulator UDID (#18053)", () => {
  test("a watch UDID requested as ios says it is a watchOS simulator and to pass watchos", async () => {
    const message = await startFailure(inventory(), { platform: "ios", deviceId: WATCH_UDID });
    expect(message).toBe(
      `Device '${WATCH_UDID}' is a watchOS simulator, not an iOS simulator. ` +
        'Call startDevice with platform: "watchos" and the same deviceId.',
    );
  });

  test("an Apple TV UDID requested as ios names tvos", async () => {
    const devices = inventory([]);
    devices.setDeviceImages("tvos", [
      { ...watch, name: "TV", platform: "tvos", deviceId: "TV-UDID" },
    ]);
    const message = await startFailure(devices, { platform: "ios", deviceId: "TV-UDID" });
    expect(message).toContain(
      'is a tvOS simulator, not an iOS simulator. Call startDevice with platform: "tvos"',
    );
  });

  test("an unknown UDID lists the supported platforms and how to start and provision a watch", async () => {
    const message = await startFailure(inventory([]), { platform: "ios", deviceId: WATCH_UDID });
    expect(message).toStartWith(
      `Device '${WATCH_UDID}' not found. Available booted: ${BOOTED_IPHONE}. ` +
        "Available images: proto-clone-probe, iPad Pro 11-inch (M5), iPhone 17e.",
    );
    expect(message).toContain("startDevice platforms: android, ios, watchos, tvos, visionos.");
    expect(message).toContain('start a watch with platform: "watchos"');
    expect(message).toContain(
      '"platform":"watchos" with a watchOS runtime and Apple Watch device type',
    );
    expect(message).toContain("deleteDevice");
  });

  test("an unreadable watch inventory still reports the device as not found", async () => {
    const devices = inventory([]);
    devices.listDeviceImages = async (platform) => {
      if (platform === "watchos") {
        throw new Error("simctl list failed");
      }
      return platform === "ios" ? iosImages : [];
    };
    const message = await startFailure(devices, { platform: "ios", deviceId: WATCH_UDID });
    expect(message).toStartWith(`Device '${WATCH_UDID}' not found.`);
  });

  test("an Android miss keeps its message and never reads Apple inventories", async () => {
    const devices = new FakeDeviceUtils();
    const message = await startFailure(devices, { platform: "android", deviceId: "emulator-5604" });
    expect(message).toBe(
      "Device 'emulator-5604' not found. Available booted: none. Available images: none.",
    );
    expect(devices.getListDeviceImagesCalls().map(({ platform }) => platform)).toEqual(["android"]);
  });
});

describe("watchOS device images", () => {
  test("listDeviceImages lists every watch simulator from the watch inventory", async () => {
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient(),
      fakeDeviceManagerSimctl(),
      createFakeAndroidEmulator(),
    ).withWatchSimulators({ listWatchSimulators: async () => [watch] });
    expect(await manager.listDeviceImages("watchos")).toEqual([watch]);
  });

  test("a family without an inventory is refused as unavailable", async () => {
    await expect(listAppleSimulatorFamilyImages("watchos", {})).rejects.toThrow(
      "Apple Watch simulator inventory is unavailable on this host.",
    );
  });
});
