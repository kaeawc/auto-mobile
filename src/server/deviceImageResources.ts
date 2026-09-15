import { errorMessage } from "../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import {
  type DeviceImageDiscovery,
  MultiPlatformDeviceManager,
  PlatformDeviceManager,
} from "../utils/deviceUtils";
import { AvdManagerService } from "../utils/android-cmdline-tools/AvdManagerService";
import { AvdManager } from "../utils/android-cmdline-tools/interfaces/AvdManager";
import { logger } from "../utils/logger";
import { DeviceInfo, Platform } from "../models";
import {
  AvdInfo,
  type DeviceProfile,
  type SystemImage,
} from "../utils/android-cmdline-tools/avdmanager";
import {
  SimCtlClient,
  type AppleDeviceRuntime,
  type AppleDeviceType,
} from "../utils/ios-cmdline-tools/SimCtlClient";
import {
  buildAndroidAvdCapabilityInventory,
  iosSimulatorCapabilityInventory,
  type VirtualDeviceCapabilityInventory,
} from "../features/device-control/virtualDeviceCapabilities";
import {
  compareSimctlVersions,
  decodeSimctlVersion,
  parseSimctlVersion,
  type SimctlVersionTuple,
} from "../utils/ios-cmdline-tools/simctlVersion";

/**
 * Wall-clock budget for the COMPLETE Android resource path — the device-image
 * listing (avdmanager `list avd`) AND the installed-only provisioning-catalog
 * enumeration (sdkmanager + avdmanager `list device`). This operation-specific
 * resource budget returns an explicit incomplete diagnostic when the host
 * toolchain stalls.
 * The deadline is armed BEFORE the first Android await so a stall in the
 * device-image listing is bounded too, and its AbortSignal cancels every
 * in-flight avdmanager/sdkmanager child on timeout.
 */
export const ANDROID_PROVISIONING_CATALOG_BUDGET_MS = 9_000;

// Resource URIs
export const DEVICE_IMAGE_RESOURCE_URIS = {
  ALL_IMAGES: "automobile:devices/images",
  PLATFORM_TEMPLATE: "automobile:devices/images/{platform}",
} as const;

// Device image info for resource response
export interface DeviceImageInfo {
  /** Exact AVD name on Android; exact simulator UDID on iOS. */
  stableId: string;
  name: string;
  platform: Platform;
  deviceId?: string;
  source: "local";
  // Extended info from AVD Manager (Android only)
  path?: string;
  target?: string;
  basedOn?: string;
  error?: string;
  // iOS simulator metadata (iOS only)
  state?: string;
  isAvailable?: boolean;
  availabilityError?: string;
  iosVersion?: string;
  deviceType?: string;
  runtime?: string;
  model?: string;
  architecture?: string;
  /**
   * Versioned hardware feature inventory for this startable virtual device.
   * Android entries are derived from its AVD config; iOS entries model the
   * simulator platform independently of a started session.
   */
  capabilityInventory: VirtualDeviceCapabilityInventory;
}

interface ProvisioningRuntime {
  platform: Platform;
  id: string;
  name: string;
  version?: string;
  availability: ProvisioningAvailability;
}

interface ProvisioningDeviceType {
  platform: Platform;
  id: string;
  name: string;
  family?: string;
  availability: ProvisioningAvailability;
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

interface ProvisioningCatalog {
  runtimes: ProvisioningRuntime[];
  deviceTypes: ProvisioningDeviceType[];
  systemImages: ProvisioningSystemImage[];
  profiles: ProvisioningProfile[];
}

interface ProvisioningCatalogObservation {
  catalogComplete: boolean;
  error?: {
    code: "unavailable" | "failed" | "timeout";
    message: string;
  };
}

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

// Resource content schema
export interface DeviceImagesResourceContent {
  totalCount: number;
  androidCount: number;
  iosCount: number;
  lastUpdated: string; // ISO 8601
  catalogComplete: boolean;
  catalogObservations: Partial<Record<Platform, ProvisioningCatalogObservation>>;
  provisioningCatalog: ProvisioningCatalog;
  configuredInventory: ConfiguredDeviceInventoryContract;
  images: DeviceImageInfo[];
}

// Dependencies interface for dependency injection
interface DeviceImageResourcesDependencies {
  deviceManager: PlatformDeviceManager;
  avdManager: AvdManager;
  simctl: Pick<SimCtlClient, "getDeviceTypesChecked" | "getRuntimesChecked">;
  timer: Timer;
  androidCatalogBudgetMs: number;
}

/**
 * Create a DeviceImageResourcesHandler with injected dependencies.
 * Constructor injection is the single DI seam for this resource handler:
 * production wiring passes real implementations, tests pass fakes.
 */
export function createDeviceImageResourcesHandler(
  deps?: Partial<DeviceImageResourcesDependencies>,
): {
  getAllDeviceImages: () => Promise<ResourceContent>;
  getDeviceImagesByPlatform: (params: Record<string, string>) => Promise<ResourceContent>;
  getDeviceImagesForPlatforms: (platforms: Platform[]) => Promise<DeviceImagesResourceContent>;
} {
  const deviceManager = deps?.deviceManager ?? new MultiPlatformDeviceManager();
  const avdManager = deps?.avdManager ?? new AvdManagerService();
  // Tests often inject only the Android/device seam. Avoid creating a real simctl
  // client in those partial fakes; production construction always includes it.
  const simctl = deps?.simctl ?? (deps ? undefined : new SimCtlClient());
  const timer = deps?.timer ?? defaultTimer;
  const androidCatalogBudgetMs =
    deps?.androidCatalogBudgetMs ?? ANDROID_PROVISIONING_CATALOG_BUDGET_MS;

  const getDeviceImagesForPlatformsImpl = async (
    platforms: Platform[],
  ): Promise<DeviceImagesResourceContent> => {
    const images: DeviceImageInfo[] = [];
    const provisioningCatalog: ProvisioningCatalog = {
      runtimes: [],
      deviceTypes: [],
      systemImages: [],
      profiles: [],
    };
    const catalogObservations: Partial<Record<Platform, ProvisioningCatalogObservation>> = {};
    const configuredInventoryObservations: Partial<
      Record<Platform, ConfiguredDeviceInventoryObservation>
    > = {};
    let androidCount = 0;
    if (platforms.includes("android")) {
      const android = await generateAndroidResource(
        deviceManager,
        avdManager,
        images,
        provisioningCatalog,
        timer,
        androidCatalogBudgetMs,
      );
      androidCount = android.androidCount;
      catalogObservations.android = android.catalogObservation;
      configuredInventoryObservations.android = android.inventoryObservation;
    }

    let iosCount = 0;
    if (platforms.includes("ios")) {
      const ios = await appendIosImages(deviceManager, images);
      iosCount = ios.iosCount;
      configuredInventoryObservations.ios = ios.observation;
      catalogObservations.ios = await buildIosProvisioningCatalog(simctl, provisioningCatalog);
    }

    return {
      totalCount: images.length,
      androidCount,
      iosCount,
      lastUpdated: new Date().toISOString(),
      catalogComplete: platforms.every(
        (platform) => catalogObservations[platform]?.catalogComplete === true,
      ),
      catalogObservations,
      provisioningCatalog,
      configuredInventory: createConfiguredInventoryContract(
        platforms,
        configuredInventoryObservations,
      ),
      images,
    };
  };

  const getAllDeviceImagesImpl = async (): Promise<ResourceContent> => {
    const result = await getDeviceImagesForPlatformsImpl(["android", "ios"]);
    return {
      uri: DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES,
      mimeType: "application/json",
      text: JSON.stringify(result, null, 2),
    };
  };

  const getDeviceImagesByPlatformImpl = async (
    params: Record<string, string>,
  ): Promise<ResourceContent> => {
    const platform = params.platform;

    // Validate platform parameter
    if (platform !== "android" && platform !== "ios") {
      return {
        uri: `automobile:devices/images/${platform}`,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            error: `Invalid platform: ${platform}. Must be 'android' or 'ios'.`,
          },
          null,
          2,
        ),
      };
    }

    const result = await getDeviceImagesForPlatformsImpl([platform as Platform]);
    return {
      uri: `automobile:devices/images/${platform}`,
      mimeType: "application/json",
      text: JSON.stringify(result, null, 2),
    };
  };

  return {
    getAllDeviceImages: getAllDeviceImagesImpl,
    getDeviceImagesByPlatform: getDeviceImagesByPlatformImpl,
    getDeviceImagesForPlatforms: getDeviceImagesForPlatformsImpl,
  };
}

async function appendAndroidImages(
  deviceManager: PlatformDeviceManager,
  avdManager: AvdManager,
  images: DeviceImageInfo[],
  signal?: AbortSignal,
): Promise<{
  androidCount: number;
  observation: ConfiguredDeviceInventoryObservation;
}> {
  try {
    const discovery = await deviceManager.getDeviceImagesDetailed("android", { signal });
    // The deadline may have fired while the primary discovery was in flight
    // (e.g. an all-platform request still awaiting iOS). Do not mutate the
    // shared images array once androidCount was finalized as incomplete: a late
    // append would add images the caller already reported as absent.
    if (signal?.aborted) {
      return {
        androidCount: 0,
        observation: failedConfiguredInventoryObservation(
          "timeout",
          "Android configured-device inventory discovery was cancelled.",
        ),
      };
    }
    const projection = projectConfiguredDeviceInventory("android", discovery);
    if (!projection.observation.complete) {
      return { androidCount: 0, observation: projection.observation };
    }
    const avdInfoList = await readAvdInfo(avdManager, signal);
    const avdInfoByName = new Map(avdInfoList.map((avd) => [avd.name, avd]));
    for (const device of projection.images) {
      images.push(toDeviceImageInfo(device, avdInfoByName.get(device.name)));
    }
    return {
      androidCount: projection.images.length,
      observation: projection.observation,
    };
  } catch (error) {
    logger.warn(`[DeviceImageResources] Failed to list Android configured devices: ${error}`);
    return {
      androidCount: 0,
      observation: failedConfiguredInventoryObservation(
        "failed",
        `Android configured-device inventory failed: ${errorMessage(error)}`,
      ),
    };
  }
}

async function readAvdInfo(avdManager: AvdManager, signal?: AbortSignal): Promise<AvdInfo[]> {
  try {
    return await avdManager.listDeviceImages(signal);
  } catch (error) {
    logger.warn(`[DeviceImageResources] Failed to get extended AVD info: ${error}`);
    return [];
  }
}

async function appendIosImages(
  deviceManager: PlatformDeviceManager,
  images: DeviceImageInfo[],
): Promise<{ iosCount: number; observation: ConfiguredDeviceInventoryObservation }> {
  try {
    const discovery = await deviceManager.getDeviceImagesDetailed("ios", {
      bypassIosDeviceListCache: true,
    });
    const projection = projectConfiguredDeviceInventory("ios", discovery);
    if (!projection.observation.complete) {
      return { iosCount: 0, observation: projection.observation };
    }
    for (const device of projection.images) {
      images.push(toDeviceImageInfo(device));
    }
    return { iosCount: projection.images.length, observation: projection.observation };
  } catch (error) {
    logger.warn(`[DeviceImageResources] Failed to list iOS configured devices: ${error}`);
    return {
      iosCount: 0,
      observation: failedConfiguredInventoryObservation(
        "failed",
        `iOS configured-device inventory failed: ${errorMessage(error)}`,
      ),
    };
  }
}

async function generateAndroidResource(
  deviceManager: PlatformDeviceManager,
  avdManager: AvdManager,
  images: DeviceImageInfo[],
  catalog: ProvisioningCatalog,
  timer: Timer,
  budgetMs: number,
): Promise<{
  androidCount: number;
  catalogObservation: ProvisioningCatalogObservation;
  inventoryObservation: ConfiguredDeviceInventoryObservation;
}> {
  // Bound the COMPLETE Android path under ONE deadline: the device-image
  // listing (appendAndroidImages -> avdmanager `list avd`) AND the
  // provisioning-catalog enumeration. The deadline is armed before the first
  // Android await, so a stall in the preceding listing is bounded too — not
  // just the catalog enumeration — and its AbortSignal cancels every in-flight
  // avdmanager/sdkmanager child on timeout instead of leaving them to their own
  // independent 60s timeouts.
  //
  // The catalog enumerates ONLY installed system images: they are the exact
  // source provisionDevice validates against (DeviceProvisioner.provisionAndroid
  // reads listInstalledSystemImages before createAvd), so the catalog cannot
  // drift into offering available-to-download packages that fail with "Package
  // path is not valid". Device profiles come from `avdmanager list device`,
  // which are the profile ids AVD creation accepts.
  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timedOut = false;
  let androidCount = 0;
  let inventoryObservation = failedConfiguredInventoryObservation(
    "failed",
    "Android configured-device inventory did not complete.",
  );
  try {
    const generate = (async () => {
      const android = await appendAndroidImages(
        deviceManager,
        avdManager,
        images,
        controller.signal,
      );
      androidCount = android.androidCount;
      inventoryObservation = android.observation;
      const [installedSystemImages, profiles] = await Promise.all([
        avdManager.listInstalledSystemImages(undefined, controller.signal),
        avdManager.listDevices(controller.signal),
      ]);
      const systemImages = new Map(
        installedSystemImages.map((image) => [image.packageName, image]),
      );
      appendAndroidProvisioningCatalog(catalog, [...systemImages.values()], profiles);
    })();
    await Promise.race([
      generate,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = timer.setTimeout(() => {
          timedOut = true;
          const error = new Error(
            `Android device-image resource generation exceeded ${budgetMs}ms`,
          );
          // Cancel every in-flight avdmanager/sdkmanager child so none keep running.
          controller.abort(error);
          reject(error);
        }, budgetMs);
      }),
    ]);
    return {
      androidCount,
      catalogObservation: { catalogComplete: true },
      inventoryObservation,
    };
  } catch (error) {
    if (timedOut) {
      logger.warn(
        `[DeviceImageResources] Android device-image resource generation timed out after ${budgetMs}ms; returning incomplete catalog`,
      );
      return {
        androidCount,
        catalogObservation: {
          catalogComplete: false,
          error: {
            code: "timeout",
            message: `Android device-image resource generation exceeded the ${budgetMs}ms budget; catalog is incomplete.`,
          },
        },
        inventoryObservation: inventoryObservation.complete
          ? inventoryObservation
          : failedConfiguredInventoryObservation(
              "timeout",
              `Android configured-device inventory exceeded the ${budgetMs}ms resource budget.`,
            ),
      };
    }
    logger.warn(`[DeviceImageResources] Failed to build Android provisioning catalog: ${error}`);
    return {
      androidCount,
      catalogObservation: failedCatalogObservation("Android", error),
      inventoryObservation,
    };
  } finally {
    if (timeoutHandle) {
      timer.clearTimeout(timeoutHandle);
    }
  }
}

async function buildIosProvisioningCatalog(
  simctl: Pick<SimCtlClient, "getDeviceTypesChecked" | "getRuntimesChecked"> | undefined,
  catalog: ProvisioningCatalog,
): Promise<ProvisioningCatalogObservation> {
  if (!simctl) {
    return {
      catalogComplete: false,
      error: {
        code: "unavailable",
        message: "iOS provisioning catalog is unavailable.",
      },
    };
  }

  try {
    const [runtimes, deviceTypes] = await Promise.all([
      simctl.getRuntimesChecked(),
      simctl.getDeviceTypesChecked(),
    ]);
    appendIosProvisioningCatalog(catalog, runtimes, deviceTypes);
    return { catalogComplete: true };
  } catch (error) {
    logger.warn(`[DeviceImageResources] Failed to build iOS provisioning catalog: ${error}`);
    return failedCatalogObservation("iOS", error);
  }
}

function failedCatalogObservation(
  platform: "Android" | "iOS",
  error: unknown,
): ProvisioningCatalogObservation {
  return {
    catalogComplete: false,
    error: {
      code: "failed",
      message: `${platform} provisioning catalog failed: ${errorMessage(error)}`,
    },
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

function failedConfiguredInventoryObservation(
  code: ConfiguredDeviceInventoryErrorCode,
  message: string,
): ConfiguredDeviceInventoryObservation {
  return {
    complete: false,
    error: { code, message },
  };
}

function appendAndroidProvisioningCatalog(
  catalog: ProvisioningCatalog,
  systemImages: SystemImage[],
  profiles: DeviceProfile[],
): void {
  for (const image of systemImages) {
    catalog.runtimes.push({
      platform: "android",
      id: image.packageName,
      name: image.versionInfo,
      version: image.apiIdentifier,
      availability: { available: true },
    });
    catalog.systemImages.push({
      platform: "android",
      id: image.packageName,
      name: image.versionInfo,
      apiLevel: image.apiLevel,
      tag: image.tag,
      abi: image.abi,
      version: image.apiIdentifier,
    });
  }

  for (const profile of profiles) {
    const name = profile.name ?? profile.id;
    catalog.deviceTypes.push({
      platform: "android",
      id: profile.id,
      name,
      ...(profile.oem ? { family: profile.oem } : {}),
      availability: { available: true },
    });
    catalog.profiles.push({
      platform: "android",
      id: profile.id,
      name,
      ...(profile.oem ? { manufacturer: profile.oem } : {}),
    });
  }
}

function appendIosProvisioningCatalog(
  catalog: ProvisioningCatalog,
  runtimes: AppleDeviceRuntime[],
  deviceTypes: AppleDeviceType[],
): void {
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

  for (const { runtime, availability } of runtimeEntries) {
    catalog.runtimes.push({
      platform: "ios",
      id: runtime.identifier,
      name: runtime.name,
      version: runtime.version,
      availability,
    });
  }

  for (const deviceType of deviceTypes) {
    let availability: ProvisioningAvailability;
    try {
      const minVersion: SimctlVersionTuple | undefined =
        parseSimctlVersion(deviceType.minRuntimeVersionString) ??
        decodeSimctlVersion(deviceType.minRuntimeVersion);
      const maxVersion: SimctlVersionTuple | undefined =
        parseSimctlVersion(deviceType.maxRuntimeVersionString) ??
        decodeSimctlVersion(deviceType.maxRuntimeVersion);
      if (!minVersion || !maxVersion) {
        throw new Error("device type has an invalid runtime version range");
      }
      const matchingRuntimes = runtimeEntries.filter(({ runtime }) => {
        const version = parseSimctlVersion(runtime.version);
        return (
          version !== undefined &&
          compareSimctlVersions(version, minVersion) >= 0 &&
          compareSimctlVersions(version, maxVersion) <= 0
        );
      });
      const availableRuntime = matchingRuntimes.find(({ availability }) => availability.available);
      const unavailableRuntime = matchingRuntimes[0];
      availability = availableRuntime
        ? { available: true }
        : unavailableRuntime
          ? {
              available: false,
              reason: `runtime-not-installed: ${unavailableRuntime.runtime.name}`,
            }
          : { available: false, reason: "unsupported-device-type" };
    } catch (error) {
      logger.debug(
        `[DeviceImageResources] Failed to derive iOS device type availability for ${deviceType.identifier}: ${error}`,
      );
      availability = { available: false, reason: "unknown" };
    }
    catalog.deviceTypes.push({
      platform: "ios",
      id: deviceType.identifier,
      name: deviceType.name,
      family: deviceType.productFamily,
      availability,
    });
  }
}

// Convert DeviceInfo to DeviceImageInfo, merging with AvdInfo for Android
function toDeviceImageInfo(
  device: StableConfiguredDeviceImage,
  avdInfo?: AvdInfo,
): DeviceImageInfo {
  return {
    stableId: device.stableId,
    name: device.name,
    platform: device.platform,
    deviceId: device.deviceId,
    source: device.source || "local",
    // Extended AVD info (Android only)
    path: avdInfo?.path,
    target: avdInfo?.target,
    basedOn: avdInfo?.basedOn,
    error: avdInfo?.error,
    // iOS simulator metadata
    state: device.state,
    isAvailable: device.isAvailable,
    availabilityError: device.availabilityError,
    iosVersion: device.iosVersion,
    deviceType: device.deviceType,
    runtime: device.runtime,
    model: device.model,
    architecture: device.architecture,
    capabilityInventory:
      device.capabilityInventory ??
      (device.platform === "ios"
        ? iosSimulatorCapabilityInventory({
            isAvailable: device.isAvailable,
            availabilityError: device.availabilityError,
            runtime: device.runtime,
          })
        : buildAndroidAvdCapabilityInventory({})),
  };
}

// Register all device image resources
export function registerDeviceImageResources(): void {
  // Construct the handler with production dependencies (the single DI seam)
  const handler = createDeviceImageResourcesHandler();

  // Register the all-images resource
  ResourceRegistry.register(
    DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES,
    "Device Images",
    "Configured AVD and simulator inventory with versioned per-platform completeness evidence.",
    "application/json",
    handler.getAllDeviceImages,
  );

  // Register the platform-specific template
  ResourceRegistry.registerTemplate(
    DEVICE_IMAGE_RESOURCE_URIS.PLATFORM_TEMPLATE,
    "Platform-specific Device Images",
    "Configured device inventory and completeness evidence for android or ios.",
    "application/json",
    handler.getDeviceImagesByPlatform,
  );

  logger.info("[DeviceImageResources] Registered device image resources");
}

export async function notifyDeviceImageResourcesUpdated(): Promise<void> {
  await ResourceRegistry.notifyResourcesUpdated([
    DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/android`,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/ios`,
  ]);
}
