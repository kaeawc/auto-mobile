import type { Platform } from "../models";
import { NON_IOS_APPLE_PLATFORM_LABELS, type NonIosApplePlatform } from "../models/Platform";
import type { AppleDeviceRuntime, AppleDeviceType } from "../utils/ios-cmdline-tools/SimCtlSupport";
import {
  deviceTypeRuntimeBounds,
  evaluateDeviceTypeOnRuntime,
  evaluateRuntimeCompatibility,
} from "../utils/ios-cmdline-tools/runtimeCompatibility";
import { errorMessage } from "../utils/describeUnknownError";
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

/** Whether a platform's provisioning catalog was read; a failed read says why. */
export interface ProvisioningCatalogObservation {
  catalogComplete: boolean;
  error?: {
    code: "unavailable" | "failed" | "timeout" | "superseded";
    message: string;
    retryable?: boolean;
    retryAfterMs?: number;
    missing?: Array<"catalog" | "configuredInventory">;
  };
}

/** `label` is the platform as messages name it ("Android", "iOS", "watchOS", ...). */
export function failedCatalogObservation(
  label: string,
  error: unknown,
): ProvisioningCatalogObservation {
  return {
    catalogComplete: false,
    error: {
      code: "failed",
      message: `${label} provisioning catalog failed: ${errorMessage(error)}`,
    },
  };
}

export function emptyProvisioningCatalog(): ProvisioningCatalog {
  return {
    runtimes: [],
    deviceTypes: [],
    systemImages: [],
    profiles: [],
  };
}

/** The simctl catalog read of one non-iOS Apple platform's simulator inventory. */
export interface AppleSimulatorCatalogSource {
  readCatalog(
    signal?: AbortSignal,
  ): Promise<{ runtimes: AppleDeviceRuntime[]; deviceTypes: AppleDeviceType[] }>;
}

/**
 * A non-iOS Apple platform's runtimes and device types as provisioning catalog entries. A failed
 * read is logged and returns an empty catalog with a failed observation, so a listing that carries
 * the catalog still answers: the images resource, and `listDeviceImages` for watchOS (#19186).
 */
export async function readAppleSimulatorProvisioningCatalog(
  platform: NonIosApplePlatform,
  read: () => ReturnType<AppleSimulatorCatalogSource["readCatalog"]>,
): Promise<{ catalog: ProvisioningCatalog; observation: ProvisioningCatalogObservation }> {
  const label = NON_IOS_APPLE_PLATFORM_LABELS[platform];
  try {
    const { runtimes, deviceTypes } = await read();
    return {
      catalog: buildSimulatorProvisioningCatalogEntries(platform, runtimes, deviceTypes),
      observation: { catalogComplete: true },
    };
  } catch (error) {
    logger.warn(`Failed to build ${label} provisioning catalog: ${errorMessage(error)}`, error);
    return {
      catalog: emptyProvisioningCatalog(),
      observation: failedCatalogObservation(label, error),
    };
  }
}

export function buildSimulatorProvisioningCatalogEntries(
  platform: "ios" | "watchos" | "tvos" | "visionos",
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
          evaluateDeviceTypeOnRuntime(deviceType, runtime).status === "supported",
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
    ({ runtime }) => evaluateDeviceTypeOnRuntime(deviceType, runtime).status === "supported",
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
