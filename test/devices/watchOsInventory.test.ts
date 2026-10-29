import { describe, expect, test } from "bun:test";
import { WatchSimulatorInventory } from "../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import {
  isAppleWatchDeviceType,
  isWatchOsSimulatorRuntime,
  watchOsVersionFromRuntimeId,
} from "../../src/utils/ios-cmdline-tools/simulatorRuntimeFamily";
import {
  FakeWatchSimctl,
  IOS_RUNTIME_ID,
  WATCH_DEVICE_TYPE,
  WATCH_RUNTIME,
  WATCH_RUNTIME_ID,
  watchDevice,
} from "../fakes/FakeWatchSimctl";

const IPHONE = {
  udid: "BCC31307-1A19-4D67-A7F0-44FC98F78921",
  name: "iPhone 16",
  state: "Booted",
  isAvailable: true,
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};

function inventoryWith(simctl: FakeWatchSimctl): WatchSimulatorInventory {
  return new WatchSimulatorInventory(simctl, "arm64");
}

describe("WatchSimulatorInventory", () => {
  test("lists watch simulators as watchos and never lists iPhones", async () => {
    const simctl = new FakeWatchSimctl();
    simctl.listing = {
      devices: {
        [IOS_RUNTIME_ID]: [IPHONE],
        [WATCH_RUNTIME_ID]: [watchDevice({ state: "Booted" })],
      },
    };

    expect(await inventoryWith(simctl).listWatchSimulators()).toEqual([
      {
        name: "Apple Watch Series 10 (46mm)",
        platform: "watchos",
        deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
        isRunning: true,
        state: "Booted",
        isAvailable: true,
        osVersion: "11.0",
        formFactor: "watch",
        deviceType: WATCH_DEVICE_TYPE.identifier,
        runtimeId: WATCH_RUNTIME_ID,
        runtime: WATCH_RUNTIME_ID,
        architecture: "arm64",
      },
    ]);
  });

  test("keeps availability errors and prefers a reported OS version", async () => {
    const simctl = new FakeWatchSimctl();
    simctl.listing = {
      devices: {
        [WATCH_RUNTIME_ID]: [
          watchDevice({
            isAvailable: false,
            availabilityError: "runtime profile not found",
            os_version: "11.1",
          }),
        ],
      },
    };

    const [watch] = await inventoryWith(simctl).listWatchSimulators();

    expect(watch).toMatchObject({
      isRunning: false,
      isAvailable: false,
      availabilityError: "runtime profile not found",
      osVersion: "11.1",
    });
  });

  test("skips simulator templates and sorts by udid", async () => {
    const simctl = new FakeWatchSimctl();
    simctl.listing = {
      devices: {
        [WATCH_RUNTIME_ID]: [
          watchDevice({ udid: "B", name: "Watch B" }),
          watchDevice({ udid: "T", name: "automobile-template-0123abcd" }),
          watchDevice({ udid: "A", name: "Watch A" }),
        ],
      },
    };

    const listed = await inventoryWith(simctl).listWatchSimulators();

    expect(listed.map((device) => device.deviceId)).toEqual(["A", "B"]);
  });

  test("a host without watches lists none", async () => {
    const simctl = new FakeWatchSimctl();
    simctl.listing = { devices: { [IOS_RUNTIME_ID]: [IPHONE] } };

    expect(await inventoryWith(simctl).listWatchSimulators()).toEqual([]);
  });

  test("a listing failure propagates instead of reading as no watches", async () => {
    const simctl = new FakeWatchSimctl();
    simctl.listingError = new Error("simctl list timed out");

    await expect(inventoryWith(simctl).listWatchSimulators()).rejects.toThrow(
      "simctl list timed out",
    );
  });

  test("the catalog keeps only watchOS runtimes and Apple Watch device types", async () => {
    const simctl = new FakeWatchSimctl();
    const iosRuntime = { ...WATCH_RUNTIME, identifier: IOS_RUNTIME_ID, name: "iOS 18.6" };
    const iphoneType = { ...WATCH_DEVICE_TYPE, productFamily: "iPhone", identifier: "iPhone-16" };
    simctl.runtimes = [iosRuntime, WATCH_RUNTIME];
    simctl.deviceTypes = [iphoneType, WATCH_DEVICE_TYPE];

    expect(await inventoryWith(simctl).readCatalog()).toEqual({
      runtimes: [WATCH_RUNTIME],
      deviceTypes: [WATCH_DEVICE_TYPE],
    });
  });
});

describe("simulator runtime family", () => {
  test("recognizes watchOS runtimes only", () => {
    expect(isWatchOsSimulatorRuntime(WATCH_RUNTIME_ID)).toBe(true);
    expect(isWatchOsSimulatorRuntime(IOS_RUNTIME_ID)).toBe(false);
    expect(isWatchOsSimulatorRuntime("com.apple.CoreSimulator.SimRuntime.tvOS-18-0")).toBe(false);
  });

  test("reads the watchOS version from a runtime identifier", () => {
    expect(watchOsVersionFromRuntimeId(WATCH_RUNTIME_ID)).toBe("11.0");
    expect(watchOsVersionFromRuntimeId("com.apple.CoreSimulator.SimRuntime.watchOS-10-5-1")).toBe(
      "10.5.1",
    );
    expect(watchOsVersionFromRuntimeId(IOS_RUNTIME_ID)).toBeUndefined();
    expect(
      watchOsVersionFromRuntimeId("com.apple.CoreSimulator.SimRuntime.watchOS-beta"),
    ).toBeUndefined();
  });

  test("recognizes Apple Watch device types by product family", () => {
    expect(isAppleWatchDeviceType(WATCH_DEVICE_TYPE)).toBe(true);
    expect(isAppleWatchDeviceType({ productFamily: "iPhone" })).toBe(false);
  });
});
