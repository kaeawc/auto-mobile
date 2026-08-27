import { describe, expect, test } from "bun:test";
import {
  computeIosSimulatorCapabilities,
  findIosSimulatorCapability,
  IOS_SIMULATOR_CAPABILITIES_SCHEMA_VERSION,
} from "../../../src/features/utility/iosSimulatorCapabilities";

describe("iOS Simulator capabilities", () => {
  test("reports a versioned pre-session biometric contract for the selected simulator", () => {
    const report = computeIosSimulatorCapabilities({
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
    });

    expect(report).toMatchObject({
      schemaVersion: IOS_SIMULATOR_CAPABILITIES_SCHEMA_VERSION,
      platform: "ios",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
    });
    expect(findIosSimulatorCapability(report, "biometrics.enrollment")).toMatchObject({
      state: "supported",
    });
    expect(findIosSimulatorCapability(report, "biometrics.match")).toMatchObject({
      state: "partial",
    });
    expect(findIosSimulatorCapability(report, "biometrics.cancel")).toMatchObject({
      state: "unsupported",
    });
  });

  test("produces identical reports for identical selections", () => {
    const context = {
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
    };

    expect(computeIosSimulatorCapabilities(context)).toEqual(
      computeIosSimulatorCapabilities(context),
    );
  });
});
