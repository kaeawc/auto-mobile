import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AppleTvSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
  SimulatorList,
} from "../../src/utils/ios-cmdline-tools/SimCtlSupport";
import {
  isAppleTvDeviceType,
  isTvOsSimulatorRuntime,
  tvOsVersionFromRuntimeId,
} from "../../src/utils/ios-cmdline-tools/simulatorRuntimeFamily";
import { FakeAppleTvSimctl } from "../fakes/FakeAppleTvSimctl";

const TV_RUNTIME_ID = "com.apple.CoreSimulator.SimRuntime.tvOS-26-5";
const OTHER_RUNTIME_IDS = ["iOS", "watchOS", "xrOS"].map(
  (family) => `com.apple.CoreSimulator.SimRuntime.${family}-26-5`,
);
const fixture: SimulatorList & {
  runtimes: AppleDeviceRuntime[];
  devicetypes: AppleDeviceType[];
} = JSON.parse(
  readFileSync(
    path.join(import.meta.dir, "..", "..", "test/fixtures/ios-simctl/list-all-appletv-26-5.json"),
    "utf8",
  ),
);

function capturedSimctl(): FakeAppleTvSimctl {
  const simctl = new FakeAppleTvSimctl();
  simctl.listing = structuredClone(fixture);
  simctl.runtimes = structuredClone(fixture.runtimes);
  simctl.deviceTypes = structuredClone(fixture.devicetypes);
  return simctl;
}

function inventoryWith(simctl: FakeAppleTvSimctl): AppleTvSimulatorInventory {
  return new AppleTvSimulatorInventory(simctl, "arm64");
}

describe("AppleTvSimulatorInventory", () => {
  test("lists exactly the captured Apple TV simulators as tvos", async () => {
    const listed = await inventoryWith(capturedSimctl()).listAppleTvSimulators();
    const captured = fixture.devices[TV_RUNTIME_ID];
    expect(captured).toHaveLength(4);
    expect(captured.every((device) => device.os_version === undefined)).toBe(true);
    expect(listed.map((device) => device.deviceId)).toEqual(
      captured.map((device) => device.udid).sort((a, b) => a.localeCompare(b)),
    );
    for (const device of listed) {
      expect(device).toMatchObject({
        platform: "tvos",
        formFactor: "tv",
        osVersion: "26.5",
        runtimeId: TV_RUNTIME_ID,
        runtime: TV_RUNTIME_ID,
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

  test("an iPhone, watch and visionOS listing yields none", async () => {
    const simctl = capturedSimctl();
    simctl.listing.devices = Object.fromEntries(
      OTHER_RUNTIME_IDS.map((runtime) => [runtime, simctl.listing.devices[runtime]]),
    );
    for (const runtime of OTHER_RUNTIME_IDS) {
      expect(simctl.listing.devices[runtime].length).toBeGreaterThan(0);
    }
    expect(await inventoryWith(simctl).listAppleTvSimulators()).toEqual([]);
  });

  test("an empty host lists none", async () => {
    expect(await inventoryWith(new FakeAppleTvSimctl()).listAppleTvSimulators()).toEqual([]);
  });

  test("a listing failure propagates instead of returning none", async () => {
    const simctl = capturedSimctl();
    simctl.listingError = new Error("simctl list timed out");
    await expect(inventoryWith(simctl).listAppleTvSimulators()).rejects.toThrow(
      "simctl list timed out",
    );
  });

  test("the captured catalog keeps only tvOS and Apple TV device types", async () => {
    const catalog = await inventoryWith(capturedSimctl()).readCatalog();
    expect(catalog.runtimes.map((runtime) => runtime.identifier)).toEqual([TV_RUNTIME_ID]);
    expect(catalog.deviceTypes).toHaveLength(7);
    expect(catalog.deviceTypes.every((deviceType) => deviceType.productFamily === "Apple TV")).toBe(
      true,
    );
    expect(catalog.deviceTypes.map((deviceType) => deviceType.identifier)).toEqual([
      "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-4K",
      "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-1080p",
      "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-2nd-generation-4K",
      "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-2nd-generation-1080p",
      "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-4K",
      "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-1080p",
      "com.apple.CoreSimulator.SimDeviceType.Apple-TV-1080p",
    ]);
  });

  test("catalog failures propagate", async () => {
    const simctl = capturedSimctl();
    simctl.catalogError = new Error("simctl catalog failed");
    await expect(inventoryWith(simctl).readCatalog()).rejects.toThrow("simctl catalog failed");
  });

  test("skips templates and sorts captured and synthetic entries by udid", async () => {
    const simctl = capturedSimctl();
    const devices = simctl.listing.devices[TV_RUNTIME_ID];
    // Synthetic entries extend the capture without changing its bytes.
    devices.push(
      { ...devices[0], udid: "Z", name: "Synthetic TV Z" },
      { ...devices[0], udid: "T", name: "automobile-template-0123abcd" },
      { ...devices[0], udid: "A", name: "Synthetic TV A" },
    );
    const listed = await inventoryWith(simctl).listAppleTvSimulators();
    expect(listed.map((device) => device.deviceId)).toEqual(
      [...fixture.devices[TV_RUNTIME_ID].map((device) => device.udid), "A", "Z"].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  });

  test("preserves synthetic availability and model fields and trims the reported version", async () => {
    const simctl = capturedSimctl();
    Object.assign(simctl.listing.devices[TV_RUNTIME_ID][0], {
      state: "Booted",
      isAvailable: false,
      availabilityError: "runtime profile not found",
      os_version: " 26.6 ",
      model: "Synthetic TV model",
    });
    const listed = await inventoryWith(simctl).listAppleTvSimulators();
    expect(
      listed.find((device) => device.deviceId === fixture.devices[TV_RUNTIME_ID][0].udid),
    ).toMatchObject({
      isRunning: true,
      isAvailable: false,
      availabilityError: "runtime profile not found",
      osVersion: "26.6",
      model: "Synthetic TV model",
    });
  });
});

describe("tvOS simulator runtime family", () => {
  test("recognizes tvOS runtimes only", () => {
    expect(isTvOsSimulatorRuntime(TV_RUNTIME_ID)).toBe(true);
    for (const runtime of OTHER_RUNTIME_IDS) {
      expect(isTvOsSimulatorRuntime(runtime)).toBe(false);
    }
  });

  test("reads the tvOS version from a runtime identifier", () => {
    expect(tvOsVersionFromRuntimeId(TV_RUNTIME_ID)).toBe("26.5");
    expect(tvOsVersionFromRuntimeId("com.apple.CoreSimulator.SimRuntime.tvOS-26-5-1")).toBe(
      "26.5.1",
    );
    for (const runtime of OTHER_RUNTIME_IDS) {
      expect(tvOsVersionFromRuntimeId(runtime)).toBeUndefined();
    }
    expect(
      tvOsVersionFromRuntimeId("com.apple.CoreSimulator.SimRuntime.tvOS-beta"),
    ).toBeUndefined();
  });

  test("recognizes Apple TV device types by product family", () => {
    expect(isAppleTvDeviceType({ productFamily: "Apple TV" })).toBe(true);
    expect(isAppleTvDeviceType({ productFamily: "iPhone" })).toBe(false);
    expect(isAppleTvDeviceType({ productFamily: "Apple Watch" })).toBe(false);
  });
});
