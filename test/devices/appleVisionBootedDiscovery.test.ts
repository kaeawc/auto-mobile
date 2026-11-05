import { bootedSweepsFor } from "../../src/devices/bootedDiscoveryAppend";
import { transitionalCandidateIds } from "../../src/daemon/deviceLossDiscovery";
import type { PooledDevice } from "../../src/daemon/devicePool";
import { resolveBootedAppleVisionForCall } from "../../src/daemon/readiness/appleVisionReadiness";
import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/ios-simctl/list-all-visionos-26-5.json";
import { FakeAppleVisionSimctl } from "../fakes/FakeAppleVisionSimctl";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import { AppleVisionSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { discoverySourceFor, incompleteDiscoverySources } from "../../src/utils/discoverySource";

const runtimeId = "com.apple.CoreSimulator.SimRuntime.xrOS-26-5";
function host() {
  const simctl = new FakeAppleVisionSimctl();
  simctl.listing = structuredClone(fixture);
  const manager = new MultiPlatformDeviceManager(
    new FakeAdbClient(),
    fakeDeviceManagerSimctl(),
    createFakeAndroidEmulator(),
  ).withAppleVisionSimulators(new AppleVisionSimulatorInventory(simctl, "arm64"));
  return { simctl, manager };
}
describe("booted Apple Vision Pro discovery", () => {
  test("lists booted headsets only as visionos with a fresh source", async () => {
    const { simctl, manager } = host();
    const headset = simctl.listing.devices[runtimeId][0];
    headset.state = "Booted";
    const missingId = simctl.listing.devices[runtimeId][1];
    missingId.state = "Booted";
    missingId.udid = "";
    const result = await manager.getBootedDevicesDetailed("visionos");
    expect(result.devices).toEqual([
      { name: headset.name, deviceId: headset.udid, platform: "visionos" },
    ]);
    expect(result.succeededPlatforms).toEqual(new Set(["visionos"]));
    expect(result.succeededSources).toEqual(new Set(["visionos-simulator"]));
    expect(result.freshDeviceIds).toEqual(new Set([headset.udid]));
    expect(discoverySourceFor("visionos", headset.udid)).toBe("visionos-simulator");
  });
  test("a headset mid-transition is reported transitional, and only a held one is kept", async () => {
    const { simctl, manager } = host();
    const headset = simctl.listing.devices[runtimeId][0];
    headset.state = "Shutting Down";
    const result = await manager.getBootedDevicesDetailed("either", {
      includeAppleSimulatorPlatforms: ["visionos"],
    });
    const device = { name: headset.name, platform: "visionos" as const, deviceId: headset.udid };
    expect(result.devices.some((listed) => listed.deviceId === headset.udid)).toBe(false);
    expect(result.transitionalSimulators).toContainEqual({ device, state: "Shutting Down" });
    const heldRow: PooledDevice = {
      id: headset.udid,
      name: headset.name,
      platform: "visionos",
      sessionId: "held",
      status: "busy",
      lastUsedAt: 0,
      assignmentCount: 1,
      errorCount: 0,
      incarnation: 1,
    };
    const pool = (sessionId: string | null) => ({
      getAssignedDevices: () => (sessionId ? [heldRow] : []),
    });
    expect(transitionalCandidateIds(pool("held"), result, {})).toEqual(new Set([headset.udid]));
    expect(transitionalCandidateIds(pool(null), result, {})).toEqual(new Set());
  });
  test("an unqualified discovery never sweeps Apple Vision Pros", () => {
    expect(bootedSweepsFor("either", {}).visionos).toBe(false);
    expect(bootedSweepsFor("either", { includeWatchOs: true }).visionos).toBe(false);
    expect(bootedSweepsFor("visionos", {}).visionos).toBe(true);
  });
  test("explicit headset readiness uses fresh simctl discovery and no automation preparation", async () => {
    const { simctl, manager } = host();
    const headset = simctl.listing.devices[runtimeId][0];
    headset.state = "Booted";
    expect(await resolveBootedAppleVisionForCall(manager, headset.udid, undefined)).toEqual({
      deviceId: headset.udid,
      name: headset.name,
      platform: "visionos",
    });
    headset.state = "Shutdown";
    await expect(resolveBootedAppleVisionForCall(manager, headset.udid, undefined)).rejects.toThrow(
      "No booted Apple Vision Pro",
    );
    simctl.listingError = new Error("simctl unavailable");
    await expect(resolveBootedAppleVisionForCall(manager, headset.udid, undefined)).rejects.toThrow(
      "discovery failed",
    );
  });
  test("an empty host is complete", async () => {
    const { simctl, manager } = host();
    simctl.listing = { devices: {} };
    const result = await manager.getBootedDevicesDetailed("visionos");
    expect(result.devices).toEqual([]);
    expect(incompleteDiscoverySources(result, ["visionos"])).toEqual([]);
  });
  test("failed listing stays incomplete", async () => {
    const { simctl, manager } = host();
    simctl.listingError = new Error("listing failed");
    const result = await manager.getBootedDevicesDetailed("visionos");
    expect(result.devices).toEqual([]);
    expect(result.discoveryErrors?.visionos?.code).toBe("failed");
    expect(incompleteDiscoverySources(result, ["visionos"])).toEqual(["visionos-simulator"]);
  });
  test("cancellation propagates", async () => {
    const { simctl, manager } = host();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    simctl.listingError = new Error("listing failed");
    await expect(
      manager.getBootedDevicesDetailed("visionos", { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
  });
});
