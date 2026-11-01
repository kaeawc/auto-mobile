import type {
  AppleDevice,
  AppleDeviceRuntime,
} from "../../src/utils/ios-cmdline-tools/SimCtlSupport";

// Apple TV and Vision Pro rows in simctl's `--json` shapes. No tvOS or visionOS runtime capture is
// checked in yet, so these follow the field layout of the captured iOS rows; the device-type
// identifiers match the Xcode 26.6 capture (test/fixtures/ios-devicetype-order).

export const TVOS_RUNTIME_ID = "com.apple.CoreSimulator.SimRuntime.tvOS-18-0";
export const XROS_RUNTIME_ID = "com.apple.CoreSimulator.SimRuntime.xrOS-2-0";
export const APPLE_TV_DEVICE_TYPE_ID =
  "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-4K";
export const VISION_PRO_DEVICE_TYPE_ID = "com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro";

/** `simctl list runtimes --json` entry for tvOS 18.0. */
export const TVOS_RUNTIME: AppleDeviceRuntime = {
  bundlePath:
    "/Library/Developer/CoreSimulator/Volumes/tvOS_22J356/Library/Developer/CoreSimulator/Profiles/Runtimes/tvOS 18.0.simruntime",
  buildversion: "22J356",
  runtimeRoot:
    "/Library/Developer/CoreSimulator/Volumes/tvOS_22J356/Library/Developer/CoreSimulator/Profiles/Runtimes/tvOS 18.0.simruntime/Contents/Resources/RuntimeRoot",
  identifier: TVOS_RUNTIME_ID,
  version: "18.0",
  isAvailable: true,
  name: "tvOS 18.0",
};

/** `simctl list runtimes --json` entry for visionOS 2.0 (CoreSimulator calls it xrOS). */
export const XROS_RUNTIME: AppleDeviceRuntime = {
  bundlePath:
    "/Library/Developer/CoreSimulator/Volumes/xrOS_22N320/Library/Developer/CoreSimulator/Profiles/Runtimes/xrOS 2.0.simruntime",
  buildversion: "22N320",
  runtimeRoot:
    "/Library/Developer/CoreSimulator/Volumes/xrOS_22N320/Library/Developer/CoreSimulator/Profiles/Runtimes/xrOS 2.0.simruntime/Contents/Resources/RuntimeRoot",
  identifier: XROS_RUNTIME_ID,
  version: "2.0",
  isAvailable: true,
  name: "visionOS 2.0",
};

/** `simctl list devices --json` row for an Apple TV simulator. */
export function appleTvDevice(overrides: Partial<AppleDevice> = {}): AppleDevice {
  return {
    udid: "7C2E4D1A-0000-4000-8000-0000000A77C1",
    name: "Apple TV 4K (3rd generation)",
    state: "Shutdown",
    isAvailable: true,
    deviceTypeIdentifier: APPLE_TV_DEVICE_TYPE_ID,
    ...overrides,
  };
}

/** `simctl list devices --json` row for a Vision Pro simulator. */
export function visionProDevice(overrides: Partial<AppleDevice> = {}): AppleDevice {
  return {
    udid: "8D3F5E2B-0000-4000-8000-00000000F150",
    name: "Apple Vision Pro",
    state: "Shutdown",
    isAvailable: true,
    deviceTypeIdentifier: VISION_PRO_DEVICE_TYPE_ID,
    ...overrides,
  };
}
