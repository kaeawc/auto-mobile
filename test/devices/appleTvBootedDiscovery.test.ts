import { bootedSweepsFor } from "../../src/devices/bootedDiscoveryAppend";
import { resolveBootedAppleTvForCall } from "../../src/daemon/readiness/appleTvReadiness";
import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/ios-simctl/list-all-appletv-26-5.json";
import { FakeAppleTvSimctl } from "../fakes/FakeAppleTvSimctl";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import { AppleTvSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { discoverySourceFor, incompleteDiscoverySources } from "../../src/utils/discoverySource";

const runtimeId = "com.apple.CoreSimulator.SimRuntime.tvOS-26-5";
function host() {
  const simctl = new FakeAppleTvSimctl();
  simctl.listing = structuredClone(fixture);
  const manager = new MultiPlatformDeviceManager(
    new FakeAdbClient(),
    fakeDeviceManagerSimctl(),
    createFakeAndroidEmulator(),
  ).withAppleTvSimulators(new AppleTvSimulatorInventory(simctl, "arm64"));
  return { simctl, manager };
}
describe("booted Apple TV discovery", () => {
  test("lists booted TVs only as tvos with a fresh source", async () => {
    const { simctl, manager } = host();
    const tv = simctl.listing.devices[runtimeId][0];
    tv.state = "Booted";
    const missingId = simctl.listing.devices[runtimeId][1];
    missingId.state = "Booted";
    missingId.udid = "";
    const result = await manager.getBootedDevicesDetailed("tvos");
    expect(result.devices).toEqual([{ name: tv.name, deviceId: tv.udid, platform: "tvos" }]);
    expect(result.succeededPlatforms).toEqual(new Set(["tvos"]));
    expect(result.succeededSources).toEqual(new Set(["tvos-simulator"]));
    expect(result.freshDeviceIds).toEqual(new Set([tv.udid]));
    expect(discoverySourceFor("tvos", tv.udid)).toBe("tvos-simulator");
  });
  test("an unqualified discovery never sweeps Apple TVs", () => {
    expect(bootedSweepsFor("either", {}).tvos).toBe(false);
    expect(bootedSweepsFor("either", { includeWatchOs: true }).tvos).toBe(false);
    expect(bootedSweepsFor("tvos", {}).tvos).toBe(true);
  });
  test("explicit TV readiness uses fresh simctl discovery and no automation preparation", async () => {
    const { simctl, manager } = host();
    const tv = simctl.listing.devices[runtimeId][0];
    tv.state = "Booted";
    expect(await resolveBootedAppleTvForCall(manager, tv.udid, undefined)).toEqual({
      deviceId: tv.udid,
      name: tv.name,
      platform: "tvos",
    });
    tv.state = "Shutdown";
    await expect(resolveBootedAppleTvForCall(manager, tv.udid, undefined)).rejects.toThrow(
      "No booted Apple TV",
    );
    simctl.listingError = new Error("simctl unavailable");
    await expect(resolveBootedAppleTvForCall(manager, tv.udid, undefined)).rejects.toThrow(
      "discovery failed",
    );
  });
  test("an empty host is complete", async () => {
    const { simctl, manager } = host();
    simctl.listing = { devices: {} };
    const result = await manager.getBootedDevicesDetailed("tvos");
    expect(result.devices).toEqual([]);
    expect(incompleteDiscoverySources(result, ["tvos"])).toEqual([]);
  });
  test("failed listing stays incomplete", async () => {
    const { simctl, manager } = host();
    simctl.listingError = new Error("listing failed");
    const result = await manager.getBootedDevicesDetailed("tvos");
    expect(result.devices).toEqual([]);
    expect(result.discoveryErrors?.tvos?.code).toBe("failed");
    expect(incompleteDiscoverySources(result, ["tvos"])).toEqual(["tvos-simulator"]);
  });
  test("cancellation propagates", async () => {
    const { simctl, manager } = host();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    simctl.listingError = new Error("listing failed");
    await expect(
      manager.getBootedDevicesDetailed("tvos", { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
  });
});
