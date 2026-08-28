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

  test("reports biometrics as unsupported for a non-iOS runtime", () => {
    const report = computeIosSimulatorCapabilities({
      deviceType: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-10-46mm",
      runtime: "com.apple.CoreSimulator.SimRuntime.watchOS-11-0",
    });

    expect(report.selection).toEqual({
      valid: false,
      reason:
        'Device type "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-10-46mm" has no BiometricKit support.',
    });
    for (const capability of report.capabilities) {
      expect(capability.state).toBe("unsupported");
    }
  });

  test("reports biometrics as unsupported when the device family and runtime disagree", () => {
    const report = computeIosSimulatorCapabilities({
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      runtime: "com.apple.CoreSimulator.SimRuntime.tvOS-18-0",
    });

    expect(report.selection.valid).toBe(false);
    expect(findIosSimulatorCapability(report, "biometrics.enrollment")).toMatchObject({
      state: "unsupported",
    });
    expect(findIosSimulatorCapability(report, "biometrics.match")).toMatchObject({
      state: "unsupported",
    });
  });

  test("reports biometrics as unsupported for an unrecognized selection", () => {
    const report = computeIosSimulatorCapabilities({ deviceType: "nonsense", runtime: "nonsense" });

    expect(report.selection.valid).toBe(false);
    expect(findIosSimulatorCapability(report, "biometrics.enrollment")).toMatchObject({
      state: "unsupported",
    });
  });

  test("accepts an iPad on an iOS runtime", () => {
    const report = computeIosSimulatorCapabilities({
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
    });

    expect(report.selection.valid).toBe(true);
    expect(findIosSimulatorCapability(report, "biometrics.enrollment")).toMatchObject({
      state: "supported",
    });
  });

  test("accepts bare device-type and runtime names without the CoreSimulator prefix", () => {
    const report = computeIosSimulatorCapabilities({
      deviceType: "iPhone-16",
      runtime: "iOS-18-6",
    });

    expect(report.selection.valid).toBe(true);
  });
});
