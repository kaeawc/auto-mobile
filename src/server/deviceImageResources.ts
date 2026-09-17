import { errorMessage } from "../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { MultiPlatformDeviceManager, PlatformDeviceManager } from "../utils/deviceUtils";
import { AvdManagerService } from "../utils/android-cmdline-tools/AvdManagerService";
import { AvdManager } from "../utils/android-cmdline-tools/interfaces/AvdManager";
import { logger } from "../utils/logger";
import { Platform } from "../models";
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
import {
  createConfiguredInventoryContract,
  failedConfiguredInventoryObservation,
  projectConfiguredDeviceInventory,
  type ConfiguredDeviceInventoryContract,
  type ConfiguredDeviceInventoryObservation,
  type StableConfiguredDeviceImage,
} from "../utils/configuredDeviceInventory";

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

interface PlatformResourceResult {
  platform: Platform;
  images: DeviceImageInfo[];
  provisioningCatalog: ProvisioningCatalog;
  catalogObservation: ProvisioningCatalogObservation;
  inventoryObservation: ConfiguredDeviceInventoryObservation;
}

interface AndroidConfiguredInventoryResult {
  images: DeviceImageInfo[];
  observation: ConfiguredDeviceInventoryObservation;
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
    const platformResults: PlatformResourceResult[] = [];
    for (const platform of platforms) {
      platformResults.push(
        platform === "android"
          ? await generateAndroidResource(deviceManager, avdManager, timer, androidCatalogBudgetMs)
          : await buildIosResourceResult(deviceManager, simctl),
      );
    }
    const images = platformResults.flatMap((result) => result.images);
    const provisioningCatalog = combineProvisioningCatalogs(
      ...platformResults.map((result) => result.provisioningCatalog),
    );
    const catalogObservations = Object.fromEntries(
      platformResults.map((result) => [result.platform, result.catalogObservation]),
    );
    const configuredInventoryObservations = Object.fromEntries(
      platformResults.map((result) => [result.platform, result.inventoryObservation]),
    );

    return {
      totalCount: images.length,
      androidCount: images.filter((image) => image.platform === "android").length,
      iosCount: images.filter((image) => image.platform === "ios").length,
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

async function buildAndroidImages(
  deviceManager: PlatformDeviceManager,
  avdManager: AvdManager,
  signal?: AbortSignal,
): Promise<AndroidConfiguredInventoryResult> {
  try {
    const discovery = await deviceManager.getDeviceImagesDetailed("android", { signal });
    if (signal?.aborted) {
      return {
        images: [],
        observation: failedConfiguredInventoryObservation(
          "timeout",
          "Android configured-device inventory discovery was cancelled.",
        ),
      };
    }
    const projection = projectConfiguredDeviceInventory("android", discovery);
    if (!projection.observation.complete) {
      return { images: [], observation: projection.observation };
    }
    const avdInfoList = await readAvdInfo(avdManager, signal);
    const avdInfoByName = new Map(avdInfoList.map((avd) => [avd.name, avd]));
    return {
      images: projection.images.map((device) =>
        toDeviceImageInfo(device, avdInfoByName.get(device.name)),
      ),
      observation: projection.observation,
    };
  } catch (error) {
    logger.warn(`[DeviceImageResources] Failed to list Android configured devices: ${error}`);
    return {
      images: [],
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

async function buildIosImages(
  deviceManager: PlatformDeviceManager,
): Promise<{ images: DeviceImageInfo[]; observation: ConfiguredDeviceInventoryObservation }> {
  try {
    const discovery = await deviceManager.getDeviceImagesDetailed("ios", {
      bypassIosDeviceListCache: true,
    });
    const projection = projectConfiguredDeviceInventory("ios", discovery);
    if (!projection.observation.complete) {
      return { images: [], observation: projection.observation };
    }
    return {
      images: projection.images.map((device) => toDeviceImageInfo(device)),
      observation: projection.observation,
    };
  } catch (error) {
    logger.warn(`[DeviceImageResources] Failed to list iOS configured devices: ${error}`);
    return {
      images: [],
      observation: failedConfiguredInventoryObservation(
        "failed",
        `iOS configured-device inventory failed: ${errorMessage(error)}`,
      ),
    };
  }
}

async function buildIosResourceResult(
  deviceManager: PlatformDeviceManager,
  simctl: Pick<SimCtlClient, "getDeviceTypesChecked" | "getRuntimesChecked"> | undefined,
): Promise<PlatformResourceResult> {
  const images = await buildIosImages(deviceManager);
  const catalog = await buildIosProvisioningCatalog(simctl);
  return {
    platform: "ios",
    images: images.images,
    provisioningCatalog: catalog.catalog,
    catalogObservation: catalog.observation,
    inventoryObservation: images.observation,
  };
}

async function generateAndroidResource(
  deviceManager: PlatformDeviceManager,
  avdManager: AvdManager,
  timer: Timer,
  budgetMs: number,
): Promise<PlatformResourceResult> {
  // Bound the COMPLETE Android path under ONE deadline: the device-image
  // listing (buildAndroidImages -> avdmanager `list avd`) AND the
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
  let completedInventory: AndroidConfiguredInventoryResult | undefined;
  try {
    return await Promise.race([
      buildAndroidResourceResult(deviceManager, avdManager, controller.signal, (inventory) => {
        completedInventory = inventory;
      }),
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
  } catch (error) {
    if (timedOut) {
      logger.warn(
        `[DeviceImageResources] Android device-image resource generation timed out after ${budgetMs}ms; returning incomplete catalog`,
      );
      return {
        platform: "android",
        images: completedInventory?.images ?? [],
        provisioningCatalog: emptyProvisioningCatalog(),
        catalogObservation: {
          catalogComplete: false,
          error: {
            code: "timeout",
            message: `Android device-image resource generation exceeded the ${budgetMs}ms budget; catalog is incomplete.`,
          },
        },
        inventoryObservation:
          completedInventory?.observation ??
          failedConfiguredInventoryObservation(
            "timeout",
            `Android configured-device inventory exceeded the ${budgetMs}ms resource budget.`,
          ),
      };
    }
    logger.warn(`[DeviceImageResources] Failed to build Android provisioning catalog: ${error}`);
    return {
      platform: "android",
      images: [],
      provisioningCatalog: emptyProvisioningCatalog(),
      catalogObservation: failedCatalogObservation("Android", error),
      inventoryObservation: failedConfiguredInventoryObservation(
        "failed",
        "Android configured-device inventory did not complete.",
      ),
    };
  } finally {
    if (timeoutHandle) {
      timer.clearTimeout(timeoutHandle);
    }
  }
}

async function buildAndroidResourceResult(
  deviceManager: PlatformDeviceManager,
  avdManager: AvdManager,
  signal: AbortSignal,
  onInventoryComplete: (inventory: AndroidConfiguredInventoryResult) => void,
): Promise<PlatformResourceResult> {
  const android = await buildAndroidImages(deviceManager, avdManager, signal);
  onInventoryComplete(android);
  try {
    const [installedSystemImages, profiles] = await Promise.all([
      avdManager.listInstalledSystemImages(undefined, signal),
      avdManager.listDevices(signal),
    ]);
    const systemImages = new Map(installedSystemImages.map((image) => [image.packageName, image]));
    return {
      platform: "android",
      images: android.images,
      provisioningCatalog: buildAndroidProvisioningCatalog([...systemImages.values()], profiles),
      catalogObservation: { catalogComplete: true },
      inventoryObservation: android.observation,
    };
  } catch (error) {
    signal.throwIfAborted();
    logger.warn(`[DeviceImageResources] Failed to build Android provisioning catalog: ${error}`);
    return {
      platform: "android",
      images: android.images,
      provisioningCatalog: emptyProvisioningCatalog(),
      catalogObservation: failedCatalogObservation("Android", error),
      inventoryObservation: android.observation,
    };
  }
}

async function buildIosProvisioningCatalog(
  simctl: Pick<SimCtlClient, "getDeviceTypesChecked" | "getRuntimesChecked"> | undefined,
): Promise<{ catalog: ProvisioningCatalog; observation: ProvisioningCatalogObservation }> {
  if (!simctl) {
    return {
      catalog: emptyProvisioningCatalog(),
      observation: {
        catalogComplete: false,
        error: {
          code: "unavailable",
          message: "iOS provisioning catalog is unavailable.",
        },
      },
    };
  }

  try {
    const [runtimes, deviceTypes] = await Promise.all([
      simctl.getRuntimesChecked(),
      simctl.getDeviceTypesChecked(),
    ]);
    return {
      catalog: buildIosProvisioningCatalogEntries(runtimes, deviceTypes),
      observation: { catalogComplete: true },
    };
  } catch (error) {
    logger.warn(`[DeviceImageResources] Failed to build iOS provisioning catalog: ${error}`);
    return {
      catalog: emptyProvisioningCatalog(),
      observation: failedCatalogObservation("iOS", error),
    };
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

function emptyProvisioningCatalog(): ProvisioningCatalog {
  return {
    runtimes: [],
    deviceTypes: [],
    systemImages: [],
    profiles: [],
  };
}

function combineProvisioningCatalogs(
  ...catalogs: Array<ProvisioningCatalog | undefined>
): ProvisioningCatalog {
  const present = catalogs.filter(
    (catalog): catalog is ProvisioningCatalog => catalog !== undefined,
  );
  return {
    runtimes: present.flatMap((catalog) => catalog.runtimes),
    deviceTypes: present.flatMap((catalog) => catalog.deviceTypes),
    systemImages: present.flatMap((catalog) => catalog.systemImages),
    profiles: present.flatMap((catalog) => catalog.profiles),
  };
}

function buildAndroidProvisioningCatalog(
  systemImages: SystemImage[],
  profiles: DeviceProfile[],
): ProvisioningCatalog {
  return {
    runtimes: systemImages.map((image) => ({
      platform: "android",
      id: image.packageName,
      name: image.versionInfo,
      version: image.apiIdentifier,
      availability: { available: true },
    })),
    deviceTypes: profiles.map((profile) => ({
      platform: "android",
      id: profile.id,
      name: profile.name ?? profile.id,
      ...(profile.oem ? { family: profile.oem } : {}),
      availability: { available: true },
    })),
    systemImages: systemImages.map((image) => ({
      platform: "android",
      id: image.packageName,
      name: image.versionInfo,
      apiLevel: image.apiLevel,
      tag: image.tag,
      abi: image.abi,
      version: image.apiIdentifier,
    })),
    profiles: profiles.map((profile) => ({
      platform: "android",
      id: profile.id,
      name: profile.name ?? profile.id,
      ...(profile.oem ? { manufacturer: profile.oem } : {}),
    })),
  };
}

function buildIosProvisioningCatalogEntries(
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
      platform: "ios" as const,
      id: deviceType.identifier,
      name: deviceType.name,
      family: deviceType.productFamily,
      availability,
    };
  });

  return {
    runtimes: runtimeEntries.map(({ runtime, availability }) => ({
      platform: "ios",
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

function iosDeviceTypeAvailability(
  deviceType: AppleDeviceType,
  runtimeEntries: Array<{
    runtime: AppleDeviceRuntime;
    availability: ProvisioningAvailability;
  }>,
): ProvisioningAvailability {
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
  return availableRuntime
    ? { available: true }
    : unavailableRuntime
      ? {
          available: false,
          reason: `runtime-not-installed: ${unavailableRuntime.runtime.name}`,
        }
      : { available: false, reason: "unsupported-device-type" };
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
