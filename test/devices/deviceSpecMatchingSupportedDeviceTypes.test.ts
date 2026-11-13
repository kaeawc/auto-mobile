import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateIosPairCompatibility } from "../../src/devices/deviceSpecMatching";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../src/utils/ios-cmdline-tools/SimCtlSupport";

// #18287: exact-pair matching honours a runtime's `supportedDeviceTypes`, not only the device
// type's bounds. The verbatim Xcode 26.6 capture has iOS 27.1 (24A94401) shipping only the
// iPhone Duo, while the iPad Pro 11-inch (M4) bounds (17.4.0 to unbounded) include 27.1.
const fixtures = join(import.meta.dir, "../fixtures/ios-devicetype-order");
const runtimes = (
  JSON.parse(readFileSync(join(fixtures, "xcode-26.6-runtimes.json"), "utf8")) as {
    runtimes: AppleDeviceRuntime[];
  }
).runtimes;
const deviceTypes = (
  JSON.parse(readFileSync(join(fixtures, "xcode-26.6-devicetypes.json"), "utf8")) as {
    devicetypes: AppleDeviceType[];
  }
).devicetypes;
/** Derived, not captured: the same runtimes as older simctl output without the list. */
const runtimesWithoutLists = runtimes.map(({ supportedDeviceTypes: _omitted, ...rest }) => rest);

const DUO = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
const IPAD_PRO_M4 = "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4-8GB";
const runtimeId = (version: string) =>
  `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace(".", "-")}`;
const M4_RUNTIMES = ["17.5", "18.0", "18.6", "26.2", "26.5", "27.0"].map((version) => ({
  id: runtimeId(version),
  version,
}));

describe("evaluateIosPairCompatibility with runtime supportedDeviceTypes (#18287)", () => {
  test("a runtime inside the bounds that does not list the model is incompatible", () => {
    const result = evaluateIosPairCompatibility(
      { deviceType: IPAD_PRO_M4, runtime: runtimeId("27.1") },
      runtimes,
      deviceTypes,
    );

    expect(result?.unavailable).toBe(false);
    expect(result?.runtime.identifier).toBe(runtimeId("27.1"));
    expect(result?.bounds).toEqual({ minVersion: "17.4.0", maxVersion: null });
    expect(result?.compatibleRuntimes).toEqual(M4_RUNTIMES);
  });

  test("compatible alternatives leave out a runtime that does not list the model", () => {
    const result = evaluateIosPairCompatibility(
      { deviceType: IPAD_PRO_M4, runtime: runtimeId("16.4") },
      runtimes,
      deviceTypes,
    );

    expect(result?.compatibleRuntimes).toEqual(M4_RUNTIMES);
  });

  test("a listed pair stays compatible", () => {
    expect(
      evaluateIosPairCompatibility(
        { deviceType: DUO, runtime: runtimeId("27.1") },
        runtimes,
        deviceTypes,
      ),
    ).toBeUndefined();
    expect(
      evaluateIosPairCompatibility(
        { deviceType: IPAD_PRO_M4, runtime: runtimeId("27.0") },
        runtimes,
        deviceTypes,
      ),
    ).toBeUndefined();
  });

  test("derived: without the runtime list, the bounds decide as before", () => {
    expect(
      evaluateIosPairCompatibility(
        { deviceType: IPAD_PRO_M4, runtime: runtimeId("27.1") },
        runtimesWithoutLists,
        deviceTypes,
      ),
    ).toBeUndefined();
    expect(
      evaluateIosPairCompatibility(
        { deviceType: IPAD_PRO_M4, runtime: runtimeId("16.4") },
        runtimesWithoutLists,
        deviceTypes,
      )?.compatibleRuntimes.map(({ id }) => id),
    ).toEqual([...M4_RUNTIMES.map(({ id }) => id), runtimeId("27.1")]);
  });
});
