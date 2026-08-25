import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { isIosSimulatorUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import { serverConfig } from "../utils/ServerConfig";
import { BootedDevice } from "../models";
import { logger } from "../utils/logger";
import {
  computeStorageCapabilities,
  STORAGE_CAPABILITIES_SCHEMA_VERSION,
  type StorageCapabilityContext,
  type StorageDeviceType,
} from "../features/storage/storageCapabilities";

// Single RFC 6570 template; the optional {?appId} query variant matches both the
// bare capabilities URI and the app-scoped form (issue #4933 ordering note: a
// query template with an optional suffix subsumes the base, so only one is needed).
const STORAGE_CAPABILITIES_TEMPLATE = "automobile:devices/{deviceId}/storage/capabilities{?appId}";

/**
 * Find a booted device by ID across both platforms.
 */
async function findBootedDevice(deviceId: string): Promise<BootedDevice | null> {
  try {
    const manager = PlatformDeviceManagerFactory.getInstance();
    const androidDevices = await manager.getBootedDevices("android");
    const android = androidDevices.find((d) => d.deviceId === deviceId);
    if (android) {
      return android;
    }
    const iosDevices = await manager.getBootedDevices("ios");
    const ios = iosDevices.find((d) => d.deviceId === deviceId);
    if (ios) {
      return ios;
    }
    return null;
  } catch (error) {
    // Best-effort discovery: an unavailable device manager is reported to the
    // caller as "device not found" rather than surfaced as a capability fault.
    logger.warn(`[StorageCapabilityResources] Failed to find device ${deviceId}: ${error}`);
    return null;
  }
}

/**
 * Classify a booted device as emulator, simulator, or physical from its identity.
 */
export function resolveDeviceType(device: BootedDevice): StorageDeviceType {
  if (device.platform === "ios") {
    return isIosSimulatorUdid(device.deviceId) ? "simulator" : "physical";
  }
  // Android AVDs report an `emulator-<port>` serial; everything else is physical.
  return device.deviceId.startsWith("emulator-") ? "emulator" : "physical";
}

/**
 * Resolve the capability context from a booted device plus server configuration.
 * Runtime prerequisites the descriptor cannot cheaply verify (debuggable build,
 * authorization, active profile, opt-in iOS integration) are left undefined so the
 * model reports them as prerequisites rather than over-claiming availability.
 */
export function resolveStorageCapabilityContext(
  device: BootedDevice,
  appId?: string,
): StorageCapabilityContext {
  return {
    platform: device.platform,
    deviceType: resolveDeviceType(device),
    embeddedSdk: serverConfig.isEmbeddedSdkEnabled(),
    // A resolved booted device implies a live runner session for the SDK path.
    sessionActive: true,
    appId,
  };
}

function buildUri(deviceId: string, appId?: string): string {
  const base = `automobile:devices/${deviceId}/storage/capabilities`;
  return appId ? `${base}?appId=${encodeURIComponent(appId)}` : base;
}

/**
 * Storage-capabilities resource handler.
 */
export async function getStorageCapabilitiesResource(
  params: Record<string, string>,
): Promise<ResourceContent> {
  const { deviceId } = params;
  // The resource registry already percent-decodes query params via URLSearchParams
  // (resourceRegistry.ts), so appId arrives decoded. Decoding again here would be a
  // double-decode: it corrupts %-bearing ids and throws URIError on a literal `%`
  // (which, being outside the try/catch, would bypass the JSON error envelope). See #5686.
  const appId = params.appId ? params.appId : undefined;
  const uri = buildUri(deviceId, appId);

  try {
    const device = await findBootedDevice(deviceId);
    if (!device) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            error: `Device not found or not booted: ${deviceId}`,
            schemaVersion: STORAGE_CAPABILITIES_SCHEMA_VERSION,
          },
          null,
          2,
        ),
      };
    }

    const report = computeStorageCapabilities(resolveStorageCapabilityContext(device, appId));

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ deviceId, ...report }, null, 2),
    };
  } catch (error) {
    logger.error(`[StorageCapabilityResources] Failed to compute capabilities: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Failed to compute storage capabilities: ${error}`,
          schemaVersion: STORAGE_CAPABILITIES_SCHEMA_VERSION,
        },
        null,
        2,
      ),
    };
  }
}

/**
 * Register the storage-capabilities resource (issue #5602).
 */
export function registerStorageCapabilityResources(): void {
  ResourceRegistry.registerTemplate(
    STORAGE_CAPABILITIES_TEMPLATE,
    "Storage Capabilities",
    "Versioned descriptor of which storage operations (list, read, write, namespace reset, media indexing, observation) are available per logical domain (app containers, user-visible files, media library, key-value state, databases, secure state) for a device and optional app context. Clients negotiate capabilities instead of inferring them from platform names.",
    "application/json",
    getStorageCapabilitiesResource,
  );

  logger.info("[StorageCapabilityResources] Registered storage capability resources");
}
