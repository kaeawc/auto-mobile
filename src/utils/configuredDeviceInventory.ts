import type { DeviceInfo, Platform } from "../models";
import type { DeviceImageDiscovery } from "./deviceUtils";

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

export type StableConfiguredDeviceImage = DeviceInfo & { stableId: string };

export interface ConfiguredDeviceInventoryProjection {
  images: StableConfiguredDeviceImage[];
  observation: ConfiguredDeviceInventoryObservation;
}

export function projectConfiguredDeviceInventory(
  platform: Platform,
  discovery: DeviceImageDiscovery,
): ConfiguredDeviceInventoryProjection {
  const observation = configuredInventoryObservation(platform, discovery);
  if (!observation.complete) {
    return { images: [], observation };
  }

  const devices = discovery.devices.filter((device) => device.platform === platform);
  const missingStableIdentity =
    platform === "ios" ? devices.find((device) => !device.deviceId?.trim()) : undefined;
  if (missingStableIdentity) {
    return {
      images: [],
      observation: failedConfiguredInventoryObservation(
        "failed",
        `iOS configured-device inventory contained simulator '${missingStableIdentity.name}' without a UDID.`,
      ),
    };
  }

  return {
    images: devices.map((device) => ({
      ...device,
      stableId: device.platform === "android" ? device.name : device.deviceId!,
    })),
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
