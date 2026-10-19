import { afterEach, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import type { BootedDevice } from "../../src/models";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createHarnessServer } from "../daemon/helpers/UnixSocketServerHarness";

// Inventory contract: an unknown never fails open. iOS has two discovery sources (simctl and
// devicectl); the ide/* lookup refuses an absent serial only when the aggregate iOS platform
// failed, so a physical serial absent because devicectl failed (simctl fine) reads as a plain
// "Device not found" instead of the retryable discovery_incomplete refusal (#11122).

const simulator: BootedDevice = {
  platform: "ios",
  name: "iPhone 16",
  deviceId: "11111111-2222-3333-4444-555555555555",
};

afterEach(() => PlatformDeviceManagerFactory.setInstance(null));

test("a physical iOS serial absent from a devicectl-failed sweep is refused as discovery_incomplete", async () => {
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("ios", [simulator]);
  manager.failedSources.add("ios-physical");
  PlatformDeviceManagerFactory.setInstance(manager);

  await expect(lookup("ios", "00008110-001A2B3C4D5E6F78")).rejects.toMatchObject({
    code: "discovery_incomplete",
  });
});

const lookup = (platform: "android" | "ios", serial: string): Promise<BootedDevice[]> =>
  createHarnessServer(
    "unused",
    DaemonState.getInstance(),
    new FakeTimer(),
  ).lookupBootedDevicesForIde(platform, serial);

test("an Android serial absent from a failed adb sweep is refused as discovery_incomplete", async () => {
  const manager = new FakeDeviceUtils();
  manager.setAndroidDiscoveryIncomplete();
  PlatformDeviceManagerFactory.setInstance(manager);

  await expect(lookup("android", "emulator-5554")).rejects.toMatchObject({
    code: "discovery_incomplete",
    retryable: true,
    platform: "android",
  });
});

test("a serial genuinely absent from COMPLETE discovery is not refused", async () => {
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("ios", [simulator]);
  manager.setBootedDevices("android", []);
  PlatformDeviceManagerFactory.setInstance(manager);

  expect(await lookup("ios", "00008110-001A2B3C4D5E6F78")).toEqual([simulator]);
  expect(await lookup("android", "emulator-5554")).toEqual([]);
});

test("a simulator UUID absent while only devicectl failed is not refused", async () => {
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("ios", [simulator]);
  manager.failedSources.add("ios-physical");
  PlatformDeviceManagerFactory.setInstance(manager);

  expect(await lookup("ios", "99999999-2222-3333-4444-555555555555")).toEqual([simulator]);
});

test("an observed serial is returned even when the other iOS source failed", async () => {
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("ios", [simulator]);
  manager.failedSources.add("ios-physical");
  PlatformDeviceManagerFactory.setInstance(manager);

  expect(await lookup("ios", simulator.deviceId)).toEqual([simulator]);
});
