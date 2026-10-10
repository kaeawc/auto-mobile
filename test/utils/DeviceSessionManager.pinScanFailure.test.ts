import { describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import { AdbUnavailableError } from "../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../fakes/FakeSimctl";

describe("DeviceSessionManager platform scan status", () => {
  const android: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel",
    platform: "android",
  };
  const ios: BootedDevice = {
    deviceId: "ios-device",
    name: "iPhone",
    platform: "ios",
  };

  test.each(["android", "ios"] as const)(
    "preserves a %s pin when that platform scan throws",
    async (failedPlatform) => {
      const adb = new FakeAdbExecutor();
      const simctl = new FakeSimctl();
      adb.setDevices([android]);
      simctl.setBootedSimulators([ios]);
      const manager = DeviceSessionManager.createInstance(
        new FakeDeviceClientProvider(adb, new FakeDeviceUtils(), simctl as never),
      );
      const pinned = failedPlatform === "android" ? android : ios;
      manager.setExplicitDevicePin(pinned);
      const scanSpy =
        failedPlatform === "android"
          ? spyOn(adb, "getBootedAndroidDevices").mockRejectedValue(new Error("adb scan failed"))
          : spyOn(simctl, "getBootedSimulatorsChecked").mockRejectedValue(
              new Error("simctl scan failed"),
            );

      try {
        const scan = await manager.detectConnectedPlatformsWithStatus();
        expect(scan.scanned[failedPlatform]).toBe(false);
        expect(scan.scanned[failedPlatform === "android" ? "ios" : "android"]).toBe(true);
        expect(scan.devices).toEqual([failedPlatform === "android" ? ios : android]);
        expect(await manager.detectConnectedPlatforms()).toEqual(scan.devices);

        await expect(manager.ensureDeviceReady(failedPlatform, "absent-device")).rejects.toThrow(
          "not found",
        );
        expect(manager.getExplicitDevicePin()).toEqual(pinned);
      } finally {
        scanSpy.mockRestore();
      }

      if (failedPlatform === "android") {
        adb.setDevices([]);
      } else {
        simctl.setBootedSimulators([]);
      }
      await expect(manager.ensureDeviceReady(failedPlatform, "absent-device")).rejects.toThrow(
        "not found",
      );
      expect(manager.getExplicitDevicePin()).toBeUndefined();
    },
  );

  test("does not treat a missing adb binary as a complete, empty Android scan", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([android]);
    const manager = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(adb, new FakeDeviceUtils(), new FakeSimctl() as never),
    );
    manager.setExplicitDevicePin(android);
    // Mirror AdbClient: a missing binary yields [] unless the caller opts into the throw.
    const scanSpy = spyOn(adb, "getBootedAndroidDevices").mockImplementation(async (options) => {
      if (options?.throwOnMissingAdb) {
        throw new AdbUnavailableError("ADB executable is unavailable");
      }
      return [];
    });
    try {
      const scan = await manager.detectConnectedPlatformsWithStatus();
      expect(scan.scanned.android).toBe(false);
      expect(scan.scannedSources.android).toBe(false);
      await expect(manager.ensureDeviceReady("android", "absent-device")).rejects.toThrow(
        "not found",
      );
      expect(manager.getExplicitDevicePin()).toEqual(android);
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("does not treat absent simctl as a successful iOS scan", async () => {
    const manager = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils()),
    );
    const scan = await manager.detectConnectedPlatformsWithStatus();
    expect(scan.scanned).toEqual({ android: true, ios: false });
  });
});
