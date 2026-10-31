import type { Platform } from "../models";
import type { AppleDeviceRuntime, AppleDeviceType } from "../utils/ios-cmdline-tools/SimCtlSupport";
import {
  deviceTypeRuntimeBounds,
  evaluateRuntimeCompatibility,
} from "../utils/ios-cmdline-tools/runtimeCompatibility";
import { logger } from "../utils/logger";

interface ProvisioningRuntime {
  platform: Platform;
  id: string;
  name: string;
  version?: string;
  availability: ProvisioningAvailability;
}

/**
 * Per-model runtime compatibility. `known` carries inclusive normalized bounds
 * (`maxRuntimeVersion: null` is an unbounded maximum) and the installed,
 * available runtimes inside them; an empty `compatibleRuntimeIds` is an
 * authoritative "none". `unknown` means the evidence was missing or malformed
 * and says nothing about which runtimes work.
 */
type ProvisioningRuntimeCompatibility =
  | {
      knowledge: "known";
      minRuntimeVersion: string;
      maxRuntimeVersion: string | null;
      compatibleRuntimeIds: string[];
    }
  | { knowledge: "unknown"; reason: string };

interface ProvisioningDeviceType {
  platform: Platform;
  id: string;
  name: string;
  family?: string;
  availability: ProvisioningAvailability;
  runtimeCompatibility?: ProvisioningRuntimeCompatibility;
}

interface ProvisioningAvailability {
  available: boolean;
  reason?: string;
}

interface ProvisioningSystemImage {
  platform: "android";
  id: string;
  name: string;
  apiLevel: number;
  tag: string;
  abi: string;
  version: string;
}

interface ProvisioningProfile {
  platform: "android";
  id: string;
  name: string;
  manufacturer?: string;
}

export interface ProvisioningCatalog {
  runtimes: ProvisioningRuntime[];
  deviceTypes: ProvisioningDeviceType[];
  systemImages: ProvisioningSystemImage[];
  profiles: ProvisioningProfile[];
}

export function buildSimulatorProvisioningCatalogEntries(
  platform: "ios" | "watchos" | "tvos",
  runtimes: AppleDeviceRuntime[],
  deviceTypes: AppleDeviceType[],
): ProvisioningCatalog {
  const runtimeEntries = runtimes.map((runtime) => {
    let availability: ProvisioningAvailability;
    try {
      const availabilityError = runtime.availabilityError?.trim();
      availability = runtime.isAvailable
        ? { available: true }
        : availabilityError
          ? { available: false, reason: `runtime-unavailable: ${availabilityError}` }
          : { available: false, reason: "runtime-not-installed" };
    } catch (error) {
      logger.debug(
        `[DeviceImageResources] Failed to derive iOS runtime availability for ${runtime.identifier}: ${error}`,
      );
      availability = { available: false, reason: "unknown" };
    }
    return { runtime, availability };
  });

  const provisioningDeviceTypes = deviceTypes.map((deviceType) => {
    let availability: ProvisioningAvailability;
    try {
      availability = iosDeviceTypeAvailability(deviceType, runtimeEntries);
    } catch (error) {
      logger.debug(
        `[DeviceImageResources] Failed to derive iOS device type availability for ${deviceType.identifier}: ${error}`,
      );
      availability = { available: false, reason: "unknown" };
    }
    return {
      platform,
      id: deviceType.identifier,
      name: deviceType.name,
      family: deviceType.productFamily,
      availability,
      runtimeCompatibility: iosRuntimeCompatibility(deviceType, runtimeEntries),
    };
  });

  return {
    runtimes: runtimeEntries.map(({ runtime, availability }) => ({
      platform,
      id: runtime.identifier,
      name: runtime.name,
      version: runtime.version,
      availability,
    })),
    deviceTypes: provisioningDeviceTypes,
    systemImages: [],
    profiles: [],
  };
}

function iosRuntimeCompatibility(
  deviceType: AppleDeviceType,
  runtimeEntries: IosRuntimeEntry[],
): ProvisioningRuntimeCompatibility {
  const bounds = deviceTypeRuntimeBounds(deviceType);
  if (!bounds) {
    return {
      knowledge: "unknown",
      reason: evaluateRuntimeCompatibility(deviceType, undefined).reason ?? "unknown",
    };
  }
  return {
    knowledge: "known",
    minRuntimeVersion: bounds.minVersion,
    maxRuntimeVersion: bounds.maxVersion,
    compatibleRuntimeIds: runtimeEntries
      .filter(
        ({ runtime, availability }) =>
          availability.available &&
          evaluateRuntimeCompatibility(deviceType, runtime.version).status === "supported",
      )
      .map(({ runtime }) => runtime.identifier),
  };
}

interface IosRuntimeEntry {
  runtime: AppleDeviceRuntime;
  availability: ProvisioningAvailability;
}

function iosDeviceTypeAvailability(
  deviceType: AppleDeviceType,
  runtimeEntries: IosRuntimeEntry[],
): ProvisioningAvailability {
  if (!deviceTypeRuntimeBounds(deviceType)) {
    throw new Error("device type has an invalid runtime version range");
  }
  const matchingRuntimes = runtimeEntries.filter(
    ({ runtime }) =>
      evaluateRuntimeCompatibility(deviceType, runtime.version).status === "supported",
  );
  const availableRuntime = matchingRuntimes.find(({ availability }) => availability.available);
  const unavailableRuntime = matchingRuntimes[0];
  return availableRuntime
    ? { available: true }
    : unavailableRuntime
      ? {
          available: false,
          reason: `runtime-not-installed: ${unavailableRuntime.runtime.name}`,
        }
      : { available: false, reason: "unsupported-device-type" };
}
