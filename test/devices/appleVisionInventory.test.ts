import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AppleVisionSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
  SimulatorList,
} from "../../src/utils/ios-cmdline-tools/SimCtlSupport";
import {
  isAppleVisionDeviceType,
  isVisionOsSimulatorRuntime,
  visionOsVersionFromRuntimeId,
} from "../../src/utils/ios-cmdline-tools/simulatorRuntimeFamily";
import { FakeAppleVisionSimctl } from "../fakes/FakeAppleVisionSimctl";

const VISION_RUNTIME_ID = "com.apple.CoreSimulator.SimRuntime.xrOS-26-5";
const OTHER_RUNTIME_IDS = ["iOS", "watchOS", "tvOS"].map(
  (family) => `com.apple.CoreSimulator.SimRuntime.${family}-26-5`,
);
const fixture: SimulatorList & {
  runtimes: AppleDeviceRuntime[];
  devicetypes: AppleDeviceType[];
} = JSON.parse(
  readFileSync(
    path.join(import.meta.dir, "..", "..", "test/fixtures/ios-simctl/list-all-visionos-26-5.json"),
    "utf8",
  ),
);

function capturedSimctl(): FakeAppleVisionSimctl {
  const simctl = new FakeAppleVisionSimctl();
  simctl.listing = structuredClone(fixture);
  simctl.runtimes = structuredClone(fixture.runtimes);
  simctl.deviceTypes = structuredClone(fixture.devicetypes);
  return simctl;
}

function inventoryWith(simctl: FakeAppleVisionSimctl): AppleVisionSimulatorInventory {
  return new AppleVisionSimulatorInventory(simctl, "arm64");
}

describe("AppleVisionSimulatorInventory", () => {
  test("lists exactly the captured Apple Vision Pro simulators as visionos", async () => {
    const listed = await inventoryWith(capturedSimctl()).listAppleVisionSimulators();
    const captured = fixture.devices[VISION_RUNTIME_ID];
    expect(captured).toHaveLength(3);
    expect(captured.every((device) => device.os_version === undefined)).toBe(true);
    expect(listed.map((device) => device.deviceId)).toEqual(
      captured.map((device) => device.udid).sort((a, b) => a.localeCompare(b)),
    );
    for (const device of listed) {
      expect(device).toMatchObject({
        platform: "visionos",
        formFactor: "xr-headset",
        osVersion: "26.5",
        runtimeId: VISION_RUNTIME_ID,
        runtime: VISION_RUNTIME_ID,
        isRunning: false,
        state: "Shutdown",
        isAvailable: true,
        architecture: "arm64",
      });
      expect(device.deviceType).toBe(
        captured.find((entry) => entry.udid === device.deviceId)?.deviceTypeIdentifier,
      );
    }
  });

  test("an iPhone, watch and tvOS listing yields none", async () => {
    const simctl = capturedSimctl();
    simctl.listing.devices = Object.fromEntries(
      OTHER_RUNTIME_IDS.map((runtime) => [runtime, simctl.listing.devices[runtime]]),
    );
    for (const runtime of OTHER_RUNTIME_IDS) {
      expect(simctl.listing.devices[runtime].length).toBeGreaterThan(0);
    }
    expect(await inventoryWith(simctl).listAppleVisionSimulators()).toEqual([]);
  });

  test("an empty host lists none", async () => {
    expect(await inventoryWith(new FakeAppleVisionSimctl()).listAppleVisionSimulators()).toEqual(
      [],
    );
  });

  test("a listing failure propagates instead of returning none", async () => {
    const simctl = capturedSimctl();
    simctl.listingError = new Error("simctl list timed out");
    await expect(inventoryWith(simctl).listAppleVisionSimulators()).rejects.toThrow(
      "simctl list timed out",
    );
  });

  test("the captured catalog keeps only visionOS and Apple Vision Pro device types", async () => {
    const catalog = await inventoryWith(capturedSimctl()).readCatalog();
    expect(catalog.runtimes.map((runtime) => runtime.identifier)).toEqual([VISION_RUNTIME_ID]);
    expect(catalog.deviceTypes).toHaveLength(2);
    expect(
      catalog.deviceTypes.every((deviceType) => deviceType.productFamily === "Apple Vision"),
    ).toBe(true);
    expect(catalog.deviceTypes.map((type) => type.identifier)).toEqual([
      "com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro-4K",
      "com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro",
    ]);
  });

  test("catalog failures propagate", async () => {
    const simctl = capturedSimctl();
    simctl.catalogError = new Error("simctl catalog failed");
    await expect(inventoryWith(simctl).readCatalog()).rejects.toThrow("simctl catalog failed");
  });

  test("skips templates and sorts captured and synthetic entries by udid", async () => {
    const simctl = capturedSimctl();
    const devices = simctl.listing.devices[VISION_RUNTIME_ID];
    // Synthetic entries extend the capture without changing its bytes.
    devices.push(
      { ...devices[0], udid: "Z", name: "Synthetic headset Z" },
      { ...devices[0], udid: "T", name: "automobile-template-0123abcd" },
      { ...devices[0], udid: "A", name: "Synthetic headset A" },
    );
    const listed = await inventoryWith(simctl).listAppleVisionSimulators();
    expect(listed.map((device) => device.deviceId)).toEqual(
      [...fixture.devices[VISION_RUNTIME_ID].map((device) => device.udid), "A", "Z"].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  });

  test("preserves synthetic availability and model fields and trims the reported version", async () => {
    const simctl = capturedSimctl();
    Object.assign(simctl.listing.devices[VISION_RUNTIME_ID][0], {
      state: "Booted",
      isAvailable: false,
      availabilityError: "runtime profile not found",
      os_version: " 26.6 ",
      model: "Synthetic headset model",
    });
    const listed = await inventoryWith(simctl).listAppleVisionSimulators();
    expect(
      listed.find((device) => device.deviceId === fixture.devices[VISION_RUNTIME_ID][0].udid),
    ).toMatchObject({
      isRunning: true,
      isAvailable: false,
      availabilityError: "runtime profile not found",
      osVersion: "26.6",
      model: "Synthetic headset model",
    });
  });
});

describe("visionOS simulator runtime family", () => {
  test("recognizes visionOS runtimes only", () => {
    expect(isVisionOsSimulatorRuntime(VISION_RUNTIME_ID)).toBe(true);
    for (const runtime of OTHER_RUNTIME_IDS) {
      expect(isVisionOsSimulatorRuntime(runtime)).toBe(false);
    }
  });

  test("reads the visionOS version from a runtime identifier", () => {
    expect(visionOsVersionFromRuntimeId(VISION_RUNTIME_ID)).toBe("26.5");
    expect(visionOsVersionFromRuntimeId("com.apple.CoreSimulator.SimRuntime.xrOS-26-5-1")).toBe(
      "26.5.1",
    );
    for (const runtime of OTHER_RUNTIME_IDS) {
      expect(visionOsVersionFromRuntimeId(runtime)).toBeUndefined();
    }
    expect(
      visionOsVersionFromRuntimeId("com.apple.CoreSimulator.SimRuntime.xrOS-beta"),
    ).toBeUndefined();
  });

  test("recognizes Apple Vision Pro device types by product family", () => {
    expect(isAppleVisionDeviceType({ productFamily: "Apple Vision" })).toBe(true);
    expect(isAppleVisionDeviceType({ productFamily: "iPhone" })).toBe(false);
    expect(isAppleVisionDeviceType({ productFamily: "Apple Watch" })).toBe(false);
  });
});
