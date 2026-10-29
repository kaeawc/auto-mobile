import type { BootedDevice, Platform } from "../models";
import type { DeviceDiscoveryError } from "../models/DeviceDiscoveryError";
import type { TransitionalSimulator } from "../models/TransitionalSimulator";
import type { DiscoverySource } from "../utils/discoverySource";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { WatchSimulatorInventory } from "../utils/ios-cmdline-tools/WatchSimulatorInventory";
import { type BootedDeviceDiscovery, iosSucceededSources } from "./deviceDiscoveryContracts";

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
