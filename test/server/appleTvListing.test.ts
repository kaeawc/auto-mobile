import { afterEach, describe, expect, test } from "bun:test";
import fixture from "../fixtures/ios-simctl/list-all-appletv-26-5.json";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { AppleTvSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import { createListingHandlers } from "../../src/server/deviceToolsListing";
import {
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { FakeAppleTvSimctl } from "../fakes/FakeAppleTvSimctl";
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
  const simctl = new FakeAppleTvSimctl();
  simctl.listing = structuredClone(fixture);
  const manager = new MultiPlatformDeviceManager(
    new FakeAdbClient(),
    fakeDeviceManagerSimctl(),
    createFakeAndroidEmulator(),
  ).withAppleTvSimulators(new AppleTvSimulatorInventory(simctl, "arm64"));
  setDeviceToolsDependencies({
    deviceManagerFactory: () => manager,
    avdManagerFactory: () => new FakeAvdManager(),
    timer: new FakeTimer(),
    bootCapacityReporters: {},
  });
  return { simctl, manager, handlers: createListingHandlers() };
}
afterEach(() => resetDeviceToolsDependencies());
describe("tvOS listing tools", () => {
  test("listDevices lists only booted Apple TVs under tvos", async () => {
    const { simctl, handlers } = host();
    const tv = simctl.listing.devices["com.apple.CoreSimulator.SimRuntime.tvOS-26-5"][0];
    tv.state = "Booted";
    const result = toolJson(await handlers.listDevicesHandler({ platform: "tvos" }));
    expect(result).toMatchObject({
      count: 1,
      discovery: { complete: true },
      devices: [{ platform: "tvos" }],
    });
  });
  test("a failed listDevices inventory reports incomplete", async () => {
    const { simctl, handlers } = host();
    simctl.listingError = new Error("simctl failed");
    expect(toolJson(await handlers.listDevicesHandler({ platform: "tvos" }))).toMatchObject({
      count: 0,
      discovery: { complete: false, failedPlatforms: ["tvos"], failedSources: ["tvos-simulator"] },
    });
  });
  test("an empty host lists no devices with complete evidence", async () => {
    const { simctl, handlers } = host();
    simctl.listing = { devices: {} };
    expect(toolJson(await handlers.listDevicesHandler({ platform: "tvos" }))).toMatchObject({
      count: 0,
      discovery: { complete: true },
    });
  });
  test("resource read status marks tvos scanned only on successful discovery", async () => {
    const restore = snapshotPlatformDeviceManagerFactory();
    try {
      const { manager, simctl } = host();
      PlatformDeviceManagerFactory.setInstance(manager);
      expect(await listBootedDevicesForReadWithStatus("tvos", "test")).toMatchObject({
        scanned: { android: false, ios: false, watchos: false, tvos: true },
      });
      simctl.listingError = new Error("listing failed");
      expect(await listBootedDevicesForReadWithStatus("tvos", "test")).toMatchObject({
        scanned: { android: false, ios: false, watchos: false, tvos: false },
        discoveryErrors: { tvos: { code: "failed" } },
      });
    } finally {
      restore();
    }
  });
  test("listDeviceImages exposes Apple TVs as tvos", async () => {
    const { handlers } = host();
    const result = toolJson(await handlers.listDeviceImagesHandler({ platform: "tvos" }));
    expect(result).toMatchObject({
      count: 4,
      platform: "tvos",
      configuredInventory: { complete: true },
    });
  });
});
