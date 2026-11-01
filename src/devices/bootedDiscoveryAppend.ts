import type { BootedDevice, Platform, SomePlatform } from "../models";
import type { DeviceDiscoveryError } from "../models/DeviceDiscoveryError";
import type { TransitionalSimulator } from "../models/TransitionalSimulator";
import type { DiscoverySource } from "../utils/discoverySource";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { AppleTvSimulatorInventory } from "../utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import type { WatchSimulatorInventory } from "../utils/ios-cmdline-tools/WatchSimulatorInventory";
import {
  type BootedDeviceDiscovery,
  type BootedDeviceDiscoveryOptions,
  iosSucceededSources,
} from "./deviceDiscoveryContracts";

/** The mutable result one booted-device sweep assembles, source by source. */
export type BootedDiscoveryAccumulator = BootedDeviceDiscovery & {
  succeededSources: Set<DiscoverySource>;
  freshDeviceIds: Set<string>;
  sourceErrors: Partial<Record<DiscoverySource, DeviceDiscoveryError>>;
  discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>>;
};

export interface IosBootedSweep {
  devices: BootedDevice[];
  simulatorsSucceeded: boolean;
  physicalSucceeded: boolean;
  transitionalSimulators?: TransitionalSimulator[];
  freshDeviceIds: Set<string>;
  error?: DeviceDiscoveryError;
  physicalError?: DeviceDiscoveryError;
}

export function appendAndroidBootedDiscovery(
  android: { devices: BootedDevice[]; error?: DeviceDiscoveryError },
  result: BootedDiscoveryAccumulator,
): void {
  result.devices.push(...android.devices);
  if (android.error) {
    result.discoveryErrors.android = android.error;
    return;
  }
  result.succeededPlatforms.add("android");
  result.succeededSources.add("android");
  // adb has no retention replay: a listed device was listed just now.
  for (const emulator of android.devices) {
    result.freshDeviceIds.add(emulator.deviceId);
  }
}

export function appendIosBootedDiscovery(
  ios: IosBootedSweep,
  result: BootedDiscoveryAccumulator,
): void {
  if (ios.physicalError) {
    result.sourceErrors["ios-physical"] = ios.physicalError;
  }
  // Physical devices confirmed by devicectl survive simulator discovery failure.
  result.devices.push(...ios.devices);
  for (const source of iosSucceededSources(ios)) {
    result.succeededSources.add(source);
  }
  if (ios.simulatorsSucceeded) {
    result.succeededPlatforms.add("ios");
  } else if (ios.error) {
    result.discoveryErrors.ios = ios.error;
  }
  for (const deviceId of ios.freshDeviceIds) {
    result.freshDeviceIds.add(deviceId);
  }
}

/** Which sweeps a booted-device read runs. "Either" is Android and iOS unless the caller opts in. */
export function bootedSweepsFor(
  platform: SomePlatform,
  options: Pick<BootedDeviceDiscoveryOptions, "includeWatchOs">,
): Record<Platform, boolean> {
  const either = platform === "either";
  return {
    android: either || platform === "android",
    ios: either || platform === "ios",
    // Only the pool's own readers ask an "either" read for watches (#14908).
    watchos: platform === "watchos" || (either && options.includeWatchOs === true),
    tvos: platform === "tvos",
  };
}

/** Booted Apple Watch simulators, or the typed reason the watch sweep has no answer (#14908). */
export async function discoverBootedWatches(
  watches: Pick<WatchSimulatorInventory, "listWatchSimulators"> | undefined,
  signal: AbortSignal | undefined,
): Promise<{ devices: BootedDevice[]; error?: DeviceDiscoveryError }> {
  if (!watches) {
    return {
      devices: [],
      error: { code: "unavailable", message: "watchOS simulator discovery is unavailable." },
    };
  }
  try {
    const listed = await watches.listWatchSimulators(signal);
    return {
      devices: listed.flatMap((watch) =>
        watch.isRunning && watch.deviceId
          ? [{ name: watch.name, platform: "watchos" as const, deviceId: watch.deviceId }]
          : [],
      ),
    };
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`watchOS simulator discovery failed: ${errorMessage(error)}`, error);
    return {
      devices: [],
      error: {
        code: "failed",
        message: `watchOS simulator discovery failed: ${errorMessage(error)}`,
      },
    };
  }
}

export function appendWatchBootedDiscovery(
  watch: { devices: BootedDevice[]; error?: DeviceDiscoveryError },
  result: BootedDiscoveryAccumulator,
): void {
  if (watch.error) {
    result.discoveryErrors.watchos = watch.error;
    return;
  }
  result.devices.push(...watch.devices);
  result.succeededPlatforms.add("watchos");
  result.succeededSources.add("watchos-simulator");
  for (const device of watch.devices) {
    result.freshDeviceIds.add(device.deviceId);
  }
}

/** Booted Apple TV simulators, or the typed reason the tvOS sweep has no answer. */
export async function discoverBootedAppleTvs(
  appleTvs: Pick<AppleTvSimulatorInventory, "listAppleTvSimulators"> | undefined,
  signal: AbortSignal | undefined,
): Promise<{ devices: BootedDevice[]; error?: DeviceDiscoveryError }> {
  signal?.throwIfAborted();
  if (!appleTvs) {
    return {
      devices: [],
      error: { code: "unavailable", message: "tvOS simulator discovery is unavailable." },
    };
  }
  try {
    const listed = await appleTvs.listAppleTvSimulators(signal);
    signal?.throwIfAborted();
    return {
      devices: listed.flatMap((tv) =>
        tv.isRunning && tv.deviceId
          ? [{ name: tv.name, platform: "tvos" as const, deviceId: tv.deviceId }]
          : [],
      ),
    };
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`tvOS simulator discovery failed: ${errorMessage(error)}`, error);
    return {
      devices: [],
      error: {
        code: "failed",
        message: `tvOS simulator discovery failed: ${errorMessage(error)}`,
      },
    };
  }
}

export function appendTvOsBootedDiscovery(
  tv: { devices: BootedDevice[]; error?: DeviceDiscoveryError },
  result: BootedDiscoveryAccumulator,
): void {
  if (tv.error) {
    result.discoveryErrors.tvos = tv.error;
    return;
  }
  result.devices.push(...tv.devices);
  result.succeededPlatforms.add("tvos");
  result.succeededSources.add("tvos-simulator");
  for (const device of tv.devices) {
    result.freshDeviceIds.add(device.deviceId);
  }
}
