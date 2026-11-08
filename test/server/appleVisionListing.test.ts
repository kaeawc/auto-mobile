import { afterEach, describe, expect, test } from "bun:test";
import fixture from "../fixtures/ios-simctl/list-all-visionos-26-5.json";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { AppleVisionSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import { createListingHandlers } from "../../src/server/deviceToolsListing";
import {
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { FakeAppleVisionSimctl } from "../fakes/FakeAppleVisionSimctl";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { snapshotPlatformDeviceManagerFactory } from "../helpers/platformDeviceManagerSnapshot";
import { listBootedDevicesForReadWithStatus } from "../../src/server/resourceDeviceResolver";
import { toolJson } from "../helpers/toolResponse";

function host() {
  const simctl = new FakeAppleVisionSimctl();
  simctl.listing = structuredClone(fixture);
  const manager = new MultiPlatformDeviceManager(
    new FakeAdbClient(),
    fakeDeviceManagerSimctl(),
    createFakeAndroidEmulator(),
  ).withAppleVisionSimulators(new AppleVisionSimulatorInventory(simctl, "arm64"));
  setDeviceToolsDependencies({
    deviceManagerFactory: () => manager,
    avdManagerFactory: () => new FakeAvdManager(),
    timer: new FakeTimer(),
    bootCapacityReporters: {},
  });
  return { simctl, manager, handlers: createListingHandlers() };
}
afterEach(() => resetDeviceToolsDependencies());
describe("visionOS listing tools", () => {
  test("listDevices lists only booted Apple Vision Pros under visionos", async () => {
    const { simctl, handlers } = host();
    const headset = simctl.listing.devices["com.apple.CoreSimulator.SimRuntime.xrOS-26-5"][0];
    headset.state = "Booted";
    const result = toolJson(await handlers.listDevicesHandler({ platform: "visionos" }));
    expect(result).toMatchObject({
      count: 1,
      discovery: { complete: true },
      devices: [{ platform: "visionos" }],
    });
  });
  test("a failed listDevices inventory reports incomplete", async () => {
    const { simctl, handlers } = host();
    simctl.listingError = new Error("simctl failed");
    expect(toolJson(await handlers.listDevicesHandler({ platform: "visionos" }))).toMatchObject({
      count: 0,
      discovery: {
        complete: false,
        failedPlatforms: ["visionos"],
        failedSources: ["visionos-simulator"],
      },
    });
  });
  test("an empty host lists no devices with complete evidence", async () => {
    const { simctl, handlers } = host();
    simctl.listing = { devices: {} };
    expect(toolJson(await handlers.listDevicesHandler({ platform: "visionos" }))).toMatchObject({
      count: 0,
      discovery: { complete: true },
    });
  });
  test("resource read status marks visionos scanned only on successful discovery", async () => {
    const restore = snapshotPlatformDeviceManagerFactory();
    try {
      const { manager, simctl } = host();
      PlatformDeviceManagerFactory.setInstance(manager);
      expect(await listBootedDevicesForReadWithStatus("visionos", "test")).toMatchObject({
        scanned: { android: false, ios: false, watchos: false, visionos: true },
      });
      simctl.listingError = new Error("listing failed");
      expect(await listBootedDevicesForReadWithStatus("visionos", "test")).toMatchObject({
        scanned: { android: false, ios: false, watchos: false, visionos: false },
        discoveryErrors: { visionos: { code: "failed" } },
      });
    } finally {
      restore();
    }
  });
  test("listDeviceImages exposes Apple Vision Pros as visionos", async () => {
    const { handlers } = host();
    const result = toolJson(await handlers.listDeviceImagesHandler({ platform: "visionos" }));
    expect(result).toMatchObject({
      count: 3,
      platform: "visionos",
      configuredInventory: { complete: true },
    });
  });
});
