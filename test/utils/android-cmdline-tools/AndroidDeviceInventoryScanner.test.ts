import { beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DefaultAndroidDeviceInventoryScanner,
  resetAndroidInventoryEnrichmentCache,
  type AndroidDeviceInventoryDeps,
} from "../../../src/utils/android-cmdline-tools/AndroidDeviceInventoryScanner";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";

const physicalPhone = (): BootedDevice => ({
  deviceId: "R58M123ABC",
  name: "R58M123ABC",
  platform: "android",
});

describe("DefaultAndroidDeviceInventoryScanner physical devices", () => {
  let adb: FakeAdbClient;
  let scanner: DefaultAndroidDeviceInventoryScanner;

  beforeEach(() => {
    resetAndroidInventoryEnrichmentCache();
    adb = new FakeAdbClient();
    adb.setCommandResult("shell getprop ro.product.model", "Pixel 9\n");
    adb.setCommandResult("shell getprop ro.product.cpu.abi", "arm64-v8a\n");
    const timer = new FakeTimer();
    const deps: AndroidDeviceInventoryDeps = {
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(adb),
      observationSequence: () => ({ next: () => 1 }),
      avdConfigReader: () => ({ readConfig: async () => null }),
      getRunningAvdName: async () => ({ name: "" }),
      isUnknownEmulatorName: (name, deviceId) => name === `Unknown (${deviceId})`,
      unknownEmulatorName: (deviceId) => `Unknown (${deviceId})`,
      throwIfAborted: () => {},
    };
    scanner = new DefaultAndroidDeviceInventoryScanner(deps);
  });

  test("describes a handset with its model and CPU architecture", async () => {
    const scan = await scanner.getBootedDevicesWithDiagnostics(false, {
      devices: [physicalPhone()],
      readinessOnly: true,
      timeoutMs: 5_000,
    });

    expect(scan.devices).toHaveLength(1);
    expect(scan.devices[0]).toMatchObject({
      deviceId: "R58M123ABC",
      model: "Pixel 9",
      architecture: "arm64-v8a",
    });
  });

  test("a serial-only scan never asks the handset for metadata", async () => {
    const scan = await scanner.getBootedDevicesWithDiagnostics(false, {
      devices: [physicalPhone()],
      readinessOnly: true,
      skipNameEnrichment: true,
      timeoutMs: 5_000,
    });

    expect(scan.devices.map((device) => device.deviceId)).toEqual(["R58M123ABC"]);
    expect(scan.devices[0].model).toBeUndefined();
    expect(adb.getInteractionLog()).toEqual([]);
  });
});
