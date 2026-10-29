import type { AppleDeviceType } from "./SimCtlSupport";

const WATCH_OS_RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.watchOS-";
const APPLE_WATCH_PRODUCT_FAMILY = "Apple Watch";

/**
 * Whether a CoreSimulator runtime identifier (a `simctl list devices --json` key) is an Apple
 * Watch runtime. Watch simulators are `platform: "watchos"`, never iOS
 * (docs/decisions/watchos-platform.md).
 */
export function isWatchOsSimulatorRuntime(runtimeId: string): boolean {
  return runtimeId.startsWith(WATCH_OS_RUNTIME_PREFIX);
}

/** The watchOS version in a runtime identifier: `...SimRuntime.watchOS-11-0` is `11.0`. */
export function watchOsVersionFromRuntimeId(runtimeId: string): string | undefined {
  if (!isWatchOsSimulatorRuntime(runtimeId)) {
    return undefined;
  }
  const version = runtimeId.slice(WATCH_OS_RUNTIME_PREFIX.length);
  return /^\d+(?:-\d+)*$/.test(version) ? version.replace(/-/g, ".") : undefined;
}

/** Whether a `simctl list devicetypes` entry is an Apple Watch model. */
export function isAppleWatchDeviceType(
  deviceType: Pick<AppleDeviceType, "productFamily">,
): boolean {
  return deviceType.productFamily === APPLE_WATCH_PRODUCT_FAMILY;
}
