import { isIosDuoDeviceType } from "./iosDeviceType";
import type { AppleDeviceType } from "./SimCtlSupport";

const IOS_RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.iOS-";
const WATCH_OS_RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.watchOS-";
const TV_OS_RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.tvOS-";
const APPLE_TV_PRODUCT_FAMILY = "Apple TV";
const APPLE_WATCH_PRODUCT_FAMILY = "Apple Watch";
const IOS_PRODUCT_FAMILIES: ReadonlySet<string> = new Set(["iPhone", "iPad"]);

/**
 * Whether a CoreSimulator runtime identifier is an iOS runtime. The iOS listing is an allowlist:
 * Apple Watch, Apple TV and Vision Pro runtimes share `simctl list` but are never iOS devices.
 */
export function isIosSimulatorRuntime(runtimeId: string): boolean {
  return runtimeId.startsWith(IOS_RUNTIME_PREFIX);
}

/**
 * Whether a `simctl list devicetypes` entry is an iPhone or iPad model (the iPhone Duo included,
 * matched by its identifier). Apple Watch, Apple TV and Vision Pro models are not iOS images.
 */
export function isIosDeviceType(
  deviceType: Pick<AppleDeviceType, "identifier" | "productFamily">,
): boolean {
  return (
    IOS_PRODUCT_FAMILIES.has(deviceType.productFamily) || isIosDuoDeviceType(deviceType.identifier)
  );
}

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

/** Whether a CoreSimulator runtime identifier is a tvOS runtime. */
export function isTvOsSimulatorRuntime(runtimeId: string): boolean {
  return runtimeId.startsWith(TV_OS_RUNTIME_PREFIX);
}

/** The tvOS version in a runtime identifier: `...SimRuntime.tvOS-26-5` is `26.5`. */
export function tvOsVersionFromRuntimeId(runtimeId: string): string | undefined {
  if (!isTvOsSimulatorRuntime(runtimeId)) {
    return undefined;
  }
  const version = runtimeId.slice(TV_OS_RUNTIME_PREFIX.length);
  return /^\d+(?:-\d+)*$/.test(version) ? version.replace(/-/g, ".") : undefined;
}

/** Whether a `simctl list devicetypes` entry is an Apple TV model. */
export function isAppleTvDeviceType(deviceType: Pick<AppleDeviceType, "productFamily">): boolean {
  return deviceType.productFamily === APPLE_TV_PRODUCT_FAMILY;
}
