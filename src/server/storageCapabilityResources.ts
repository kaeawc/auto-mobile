import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
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
import { findBootedDeviceForResource } from "./resourceDeviceResolver";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  AndroidUserTargetResolver,
  AndroidUserTargetUnavailableError,
  type ResolvedUserTarget,
  type UserTargetRequest,
} from "../utils/android-cmdline-tools/AndroidUserTargetResolver";

// Single RFC 6570 template; the optional {?appId} query variant matches both the
// bare capabilities URI and the app-scoped form (issue #4933 ordering note: a
// query template with an optional suffix subsumes the base, so only one is needed).
const STORAGE_CAPABILITIES_TEMPLATE = "automobile:devices/{deviceId}/storage/capabilities{?appId}";

/**
 * Find a booted device by ID across both platforms.
 */
async function findBootedDevice(deviceId: string): Promise<BootedDevice | null> {
  return findBootedDeviceForResource(deviceId, "StorageCapabilityResources");
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

/** Narrow seam for the Android user target resolver. */
export interface StorageCapabilityUserResolver {
  resolve(request: UserTargetRequest): Promise<ResolvedUserTarget>;
}

export interface StorageCapabilityDependencies {
  adbFactory?: AdbClientFactory;
  createUserResolver?: (adb: AdbExecutor) => StorageCapabilityUserResolver;
}

/** Build the context from device configuration and the probed profile signal. */
export function resolveStorageCapabilityContext(
  device: BootedDevice,
  appId?: string,
  activeUserProfile?: boolean,
): StorageCapabilityContext {
  return {
    platform: device.platform,
    deviceType: resolveDeviceType(device),
    embeddedSdk: serverConfig.isEmbeddedSdkEnabled(),
    // A resolved booted device implies a live runner session for the SDK path.
    sessionActive: true,
    activeUserProfile,
    appId,
  };
}

async function resolveActiveUserProfile(
  device: BootedDevice,
  dependencies: StorageCapabilityDependencies,
): Promise<boolean | undefined> {
  let activeUserProfile: boolean | undefined;
  if (device.platform === "android") {
    try {
      const adb = (dependencies.adbFactory ?? defaultAdbClientFactory).create(device);
      const resolver = (
        dependencies.createUserResolver ??
        ((executor: AdbExecutor) => new AndroidUserTargetResolver(executor))
      )(adb);
      await resolver.resolve({ currentUser: true });
      activeUserProfile = true;
    } catch (error) {
      if (error instanceof AndroidUserTargetUnavailableError) {
        // A resolved absence or ambiguous target is an expected unavailable state.
        logger.debug(`[StorageCapabilityResources] No selectable Android profile: ${error}`);
        activeUserProfile = false;
      } else {
        // A failed device probe cannot establish whether a profile is active.
        logger.warn(`[StorageCapabilityResources] Active Android profile probe failed: ${error}`);
      }
    }
  }
  return activeUserProfile;
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
  dependencies: StorageCapabilityDependencies = {},
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

    const activeUserProfile = await resolveActiveUserProfile(device, dependencies);
    const report = computeStorageCapabilities(
      resolveStorageCapabilityContext(device, appId, activeUserProfile),
    );

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
export function registerStorageCapabilityResources(
  dependencies: StorageCapabilityDependencies = {},
): void {
  ResourceRegistry.registerTemplate(
    STORAGE_CAPABILITIES_TEMPLATE,
    "Storage Capabilities",
    "Versioned descriptor of which storage operations (list, read, write, namespace reset, media indexing, observation) are available per logical domain (app containers, user-visible files, media library, key-value state, databases, secure state) for a device and optional app context. Clients negotiate capabilities instead of inferring them from platform names.",
    "application/json",
    (params) => getStorageCapabilitiesResource(params, dependencies),
  );

  logger.info("[StorageCapabilityResources] Registered storage capability resources");
}
