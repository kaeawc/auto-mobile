import { probeDebuggableBuild } from "../features/storage/debuggableBuildProbe";
import {
  getAppFileService,
  describeDefaultAppFileProviderCoverage,
  type AppFileProviderCoverageReader,
} from "./appFileService";
import {
  getSharedStorageReadService,
  type SharedStorageReadCoverage,
} from "./sharedStorageReadService";
import type { Platform } from "../models";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import type {
  KeystoreDiscovery,
  KeystoreDiscoveryState,
} from "../features/storage/keystoreDiscovery";
import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
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
    return resolveIosDeviceKind({ deviceId: device.deviceId });
  }
  // Android AVDs report an `emulator-<port>` serial; everything else is physical.
  return device.deviceId.startsWith("emulator-") ? "emulator" : "physical";
}

/** Narrow seam for the Android user target resolver. */
export interface StorageCapabilityUserResolver {
  resolve(request: UserTargetRequest): Promise<ResolvedUserTarget>;
}

export interface StorageCapabilityDependencies {
  appFileCoverage?: AppFileProviderCoverageReader;
  sharedStorageReadCoverage?: (
    platform: Platform,
    domain?: "user_files" | "media_library",
  ) => SharedStorageReadCoverage;
  adbFactory?: AdbClientFactory;
  probeDebuggableBuild?: (adb: AdbExecutor, appId: string) => Promise<boolean | undefined>;
  createKeystoreDiscovery?: (device: BootedDevice) => KeystoreDiscovery;
  createUserResolver?: (adb: AdbExecutor) => StorageCapabilityUserResolver;
}

/** Build the context from device configuration and the probed prerequisite signals. */
export function resolveStorageCapabilityContext(
  device: BootedDevice,
  appId?: string,
  activeUserProfile?: boolean,
  debuggableBuild?: boolean,
): StorageCapabilityContext {
  return {
    platform: device.platform,
    deviceType: resolveDeviceType(device),
    embeddedSdk: serverConfig.isEmbeddedSdkEnabled(),
    // A resolved booted device implies a live runner session for the SDK path.
    sessionActive: true,
    activeUserProfile,
    ...(debuggableBuild === undefined ? {} : { debuggableBuild }),
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

async function resolveDebuggableBuild(
  device: BootedDevice,
  appId: string | undefined,
  dependencies: StorageCapabilityDependencies,
): Promise<boolean | undefined> {
  if (device.platform !== "android" || resolveDeviceType(device) !== "physical" || !appId) {
    return undefined;
  }
  try {
    const adb = (dependencies.adbFactory ?? defaultAdbClientFactory).create(device);
    return await (dependencies.probeDebuggableBuild ?? probeDebuggableBuild)(adb, appId);
  } catch (error) {
    logger.warn("[StorageCapabilityResources] Debuggable Android build probe failed", error);
    return undefined;
  }
}

async function resolveKeystoreDiscovery(
  device: BootedDevice,
  appId: string,
  dependencies: StorageCapabilityDependencies,
): Promise<KeystoreDiscoveryState> {
  try {
    const discovery =
      dependencies.createKeystoreDiscovery?.(device) ?? AndroidCtrlProxyClient.getInstance(device);
    return await discovery.discoverKeystore(appId);
  } catch (error) {
    logger.warn("[StorageCapabilityResources] Keystore discovery unavailable", error);
    return {
      schemaVersion: 1,
      capability: "storage.keystore",
      outcome: "unavailable",
      reason: "BRIDGE_UNAVAILABLE",
      bridgeAvailable: false,
      metadata: "supported",
      mutation: "declared_unsupported",
      deviceLocked: "unknown",
      scopes: [],
    };
  }
}

function buildUri(deviceId: string, appId?: string): string {
  const base = `automobile:devices/${deviceId}/storage/capabilities`;
  return appId ? `${base}?appId=${encodeURIComponent(appId)}` : base;
}

function resolveProviderCoverage(dependencies: StorageCapabilityDependencies) {
  return dependencies.appFileCoverage
    ? dependencies.appFileCoverage.describeProviderCoverage()
    : (getAppFileService().describeProviderCoverage?.() ??
        describeDefaultAppFileProviderCoverage());
}

function resolveSharedReadCoverage(
  dependencies: StorageCapabilityDependencies,
  platform: Platform,
  domain: "user_files" | "media_library" = "user_files",
) {
  return dependencies.sharedStorageReadCoverage
    ? dependencies.sharedStorageReadCoverage(platform, domain)
    : getSharedStorageReadService().describeReadCoverage?.(platform, domain);
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

    const [activeUserProfile, debuggableBuild] = await Promise.all([
      resolveActiveUserProfile(device, dependencies),
      resolveDebuggableBuild(device, appId, dependencies),
    ]);
    const context = resolveStorageCapabilityContext(
      device,
      appId,
      activeUserProfile,
      debuggableBuild,
    );
    context.providerCoverage = resolveProviderCoverage(dependencies);
    context.sharedStorageReadCoverage = resolveSharedReadCoverage(dependencies, device.platform);
    context.mediaLibraryReadCoverage = resolveSharedReadCoverage(
      dependencies,
      device.platform,
      "media_library",
    );
    if (device.platform === "android" && appId && context.embeddedSdk) {
      context.keystore = await resolveKeystoreDiscovery(device, appId, dependencies);
    }
    const report = computeStorageCapabilities(context);

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
