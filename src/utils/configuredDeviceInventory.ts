import type { BootedDevice, DeviceInfo, Platform } from "../models";
import type { DeviceImageDiscovery } from "./deviceUtils";
import { isAndroidEmulatorSerial } from "./androidSerial";
import {
  describeDevice,
  projectConfiguredImage,
  type ConfiguredImage,
} from "../server/deviceDescription";

export const CONFIGURED_DEVICE_INVENTORY_SCHEMA_VERSION = 1 as const;

export type ConfiguredDeviceInventoryErrorCode = "unavailable" | "failed" | "timeout";

export interface ConfiguredDeviceInventoryError {
  code: ConfiguredDeviceInventoryErrorCode;
  message: string;
}

export type ConfiguredDeviceInventoryObservation =
  | { complete: true; error?: never }
  | { complete: false; error: ConfiguredDeviceInventoryError };

export interface ConfiguredDeviceInventoryContract {
  schemaVersion: typeof CONFIGURED_DEVICE_INVENTORY_SCHEMA_VERSION;
  complete: boolean;
  observations: Partial<Record<Platform, ConfiguredDeviceInventoryObservation>>;
}

export type StableConfiguredDeviceImage = DeviceInfo & {
  stableId: string;
  /** Android AVD source-image metadata from `avdmanager list avd`, when available. */
  image?: {
    path?: string;
    target?: string;
    basedOn?: string;
  };
};

export interface ConfiguredDeviceInventoryProjection {
  /** Public description projection shared by listDeviceImages and the resource. */
  images: ConfiguredImage[];
  /** Discovery records retained only for resource-only AVD provenance enrichment. */
  sourceImages: StableConfiguredDeviceImage[];
  observation: ConfiguredDeviceInventoryObservation;
}

/**
 * Indexes a complete configured-device observation by the stable identity the
 * canonical description uses for booted-device configuration fallback.
 */
export function configuredImagesByStableId(
  platform: Platform,
  discovery: DeviceImageDiscovery,
): ReadonlyMap<string, StableConfiguredDeviceImage> {
  const projection = projectConfiguredDeviceInventory(platform, discovery);
  return new Map(
    projection.sourceImages.map((image) => [configuredImageKey(platform, image.stableId), image]),
  );
}

/** Returns the configured image for a booted virtual device, when its inventory completed. */
export function configuredImageForBootedDevice(
  device: BootedDevice,
  configuredImages: ReadonlyMap<string, StableConfiguredDeviceImage>,
): StableConfiguredDeviceImage | undefined {
  if (device.platform === "android" && !isAndroidEmulatorSerial(device.deviceId)) {
    return undefined;
  }
  const stableId = device.platform === "android" ? device.name : device.deviceId;
  return configuredImages.get(configuredImageKey(device.platform, stableId));
}

function configuredImageKey(platform: Platform, stableId: string): string {
  return `${platform}:${stableId}`;
}

export function projectConfiguredDeviceInventory(
  platform: Platform,
  discovery: DeviceImageDiscovery,
): ConfiguredDeviceInventoryProjection {
  const observation = configuredInventoryObservation(platform, discovery);
  if (!observation.complete) {
    return { images: [], sourceImages: [], observation };
  }

  const devices = discovery.devices.filter((device) => device.platform === platform);
  const missingStableIdentity =
    platform === "ios" ? devices.find((device) => !device.deviceId?.trim()) : undefined;
  if (missingStableIdentity) {
    return {
      images: [],
      sourceImages: [],
      observation: failedConfiguredInventoryObservation(
        "failed",
        `iOS configured-device inventory contained simulator '${missingStableIdentity.name}' without a UDID.`,
      ),
    };
  }

  const sourceImages = devices.map((device) => ({
    ...device,
    stableId: device.platform === "android" ? device.name : device.deviceId!,
  }));
  return {
    images: sourceImages.map((image) =>
      projectConfiguredImage(describeDevice({ kind: "image", image })),
    ),
    sourceImages,
    observation,
  };
}

export function createConfiguredInventoryContract(
  platforms: Platform[],
  observations: Partial<Record<Platform, ConfiguredDeviceInventoryObservation>>,
): ConfiguredDeviceInventoryContract {
  return {
    schemaVersion: CONFIGURED_DEVICE_INVENTORY_SCHEMA_VERSION,
    complete: platforms.every((platform) => observations[platform]?.complete === true),
    observations,
  };
}

export function failedConfiguredInventoryObservation(
  code: ConfiguredDeviceInventoryErrorCode,
  message: string,
): ConfiguredDeviceInventoryObservation {
  return {
    complete: false,
    error: { code, message },
  };
}

function configuredInventoryObservation(
  platform: Platform,
  discovery: DeviceImageDiscovery,
): ConfiguredDeviceInventoryObservation {
  if (discovery.succeededPlatforms.has(platform)) {
    return { complete: true };
  }
  const error = discovery.discoveryErrors?.[platform];
  return failedConfiguredInventoryObservation(
    error?.code ?? "failed",
    error?.message ??
      `${platform === "ios" ? "iOS" : "Android"} configured-device inventory did not complete.`,
  );
}
