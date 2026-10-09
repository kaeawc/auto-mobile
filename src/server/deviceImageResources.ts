import { registerAndroidInventoryCatalogInvalidator } from "../utils/AndroidInventoryInvalidation";
export { invalidateAndroidInventoryProvenanceAndCatalog } from "../utils/AndroidInventoryInvalidation";
import { errorMessage } from "../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { getAbortSignal, runWithAbortSignal } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { resetAndroidInventoryEnrichmentCache } from "../utils/android-cmdline-tools/AndroidEmulatorClient";
import { AndroidAvdProvenanceCache } from "../utils/AndroidAvdProvenanceCache";
import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { MultiPlatformDeviceManager, PlatformDeviceManager } from "../devices/deviceUtils";
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
  deviceTypeRuntimeBounds,
  evaluateRuntimeCompatibility,
} from "../utils/ios-cmdline-tools/runtimeCompatibility";
import {
  createConfiguredInventoryContract,
  failedConfiguredInventoryObservation,
  projectConfiguredDeviceInventory,
  type ConfiguredDeviceInventoryContract,
  type ConfiguredDeviceInventoryObservation,
  type StableConfiguredDeviceImage,
} from "../utils/configuredDeviceInventory";
import { describeDevice, projectConfiguredImage, type ConfiguredImage } from "./deviceDescription";
import { TTLCache } from "../utils/cache/Cache";
import { SingleFlight } from "../utils/cache/SingleFlight";

/** Per-read response budget; the shared fetch has its own lifecycle and hard cap. */
export const ANDROID_PROVISIONING_CATALOG_BUDGET_MS = 9_000;
export const ANDROID_INVENTORY_BACKGROUND_CAP_MS = 30_000;
export const ANDROID_INVENTORY_RETRY_AFTER_MS = 1_000;
// The stage includes configured images, so it uses the same 2.5s freshness bound.
export const ANDROID_INVENTORY_STAGE_TTL_MS = 2_500;

const ANDROID_DEVICE_IMAGE_RESOURCE_CACHE_TTL_MS = 2_500; // Stay below adb's ~5s device-list cache.
interface AndroidBackgroundFetch {
  promise: Promise<PlatformResourceResult>;
  controller: AbortController;
  inventory?: AndroidConfiguredInventoryResult;
}
interface AndroidImageCacheState {
  background?: AndroidBackgroundFetch;
  stage?: TTLCache<string, PlatformResourceResult>;
  cache: TTLCache<string, PlatformResourceResult> | null;
  singleFlight: SingleFlight<string, PlatformResourceResult>;
  generation: number;
}

// The production registration has one handler; tests and embedded callers may have more.
// Weak references let the process-wide invalidation reach live handlers without retaining them.
const androidImageCacheStates = new Set<WeakRef<AndroidImageCacheState>>();

function resetAndroidImageCacheState(state: AndroidImageCacheState): void {
  state.stage?.clear();
  state.cache = null;
  state.singleFlight = new SingleFlight();
}

function getAndroidDeviceImageResourceCache(
  state: AndroidImageCacheState,
  timer: Timer,
): TTLCache<string, PlatformResourceResult> {
  if (!state.cache) {
    state.cache = new TTLCache(timer, {
      ttlMs: ANDROID_DEVICE_IMAGE_RESOURCE_CACHE_TTL_MS,
    });
  }
  return state.cache;
}

export function resetAndroidDeviceImageResourceCache(): void {
  resetAndroidInventoryEnrichmentCache();
  resetAndroidResourceCacheStates();
}

function resetAndroidResourceCacheStates(): void {
  for (const reference of androidImageCacheStates) {
    const state = reference.deref();
    if (state) {
      resetAndroidImageCacheState(state);
    } else {
      androidImageCacheStates.delete(reference);
    }
  }
}

// Resource URIs
export const DEVICE_IMAGE_RESOURCE_URIS = {
  ALL_IMAGES: "automobile:devices/images",
  PLATFORM_TEMPLATE: "automobile:devices/images/{platform}",
} as const;

// Device image info for resource response
export type DeviceImageInfo = ConfiguredImage;

registerAndroidInventoryCatalogInvalidator(() => {
  resetAndroidResourceCacheStates();
  for (const reference of androidImageCacheStates) {
    const state = reference.deref();
    if (state) {
      state.generation++;
      state.background?.controller.abort(
        new Error("Android inventory fetch superseded by invalidation"),
      );
      state.background = undefined;
    }
  }
});

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

interface ProvisioningCatalog {
  runtimes: ProvisioningRuntime[];
  deviceTypes: ProvisioningDeviceType[];
  systemImages: ProvisioningSystemImage[];
  profiles: ProvisioningProfile[];
}

interface ProvisioningCatalogObservation {
  catalogComplete: boolean;
  error?: {
    code: "unavailable" | "failed" | "timeout" | "superseded";
    message: string;
    retryable?: boolean;
    retryAfterMs?: number;
    missing?: Array<"catalog" | "configuredInventory">;
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
  const androidCacheState: AndroidImageCacheState = {
    cache: null,
    singleFlight: new SingleFlight(),
    generation: 0,
  };
  androidImageCacheStates.add(new WeakRef(androidCacheState));

  const getDeviceImagesForPlatformsImpl = async (
    platforms: Platform[],
  ): Promise<DeviceImagesResourceContent> => {
    const platformResults: PlatformResourceResult[] = [];
    for (const platform of platforms) {
      platformResults.push(
        platform === "android"
          ? await generateAndroidResource(
              androidCacheState,
              deviceManager,
              avdManager,
              timer,
              androidCatalogBudgetMs,
            )
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
  timer: Timer,
  signal?: AbortSignal,
): Promise<AndroidConfiguredInventoryResult> {
  try {
    const discovery = await deviceManager.getDeviceImagesDetailed("android", {
      signal,
      coalesceInventoryEnrichment: true,
    });
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
    const avdInfoByName = await readAvdInfo(avdManager, timer);
    return {
      images: projection.sourceImages.map((device) =>
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

async function readAvdInfo(
  avdManager: AvdManager,
  timer: Timer,
): Promise<ReadonlyMap<string, AvdInfo>> {
  return AndroidAvdProvenanceCache.getInstance().getByName(avdManager, timer);
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
      images: projection.sourceImages.map((device) => toDeviceImageInfo(device)),
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
  state: AndroidImageCacheState,
  deviceManager: PlatformDeviceManager,
  avdManager: AvdManager,
  timer: Timer,
  budgetMs: number,
): Promise<PlatformResourceResult> {
  const cacheKey = "android";
  const cached = getAndroidDeviceImageResourceCache(state, timer).get(cacheKey);
  if (cached) {
    return cached;
  }

  return await state.singleFlight.run(
    cacheKey,
    () =>
      runWithAbortSignal(undefined, async () => {
        const generation = state.generation;
        const result = await computeAndroidResource({
          state,
          deviceManager,
          avdManager,
          timer,
          budgetMs,
        });
        if (generation === state.generation && result.catalogObservation.catalogComplete) {
          getAndroidDeviceImageResourceCache(state, timer).set(cacheKey, result);
        }
        return result;
      }),
    getAbortSignal(),
  );
}

function startAndroidBackgroundFetch({
  state,
  deviceManager,
  avdManager,
  timer,
}: {
  state: AndroidImageCacheState;
  deviceManager: PlatformDeviceManager;
  avdManager: AvdManager;
  timer: Timer;
}): AndroidBackgroundFetch {
  const controller = new AbortController();
  const generation = state.generation;
  let hardCapExpired = false;
  const fetch: AndroidBackgroundFetch = {
    controller,
    promise: runWithAbortSignal(undefined, async () => {
      await Promise.resolve();
      try {
        const result = await raceWithDeadline(
          () =>
            buildAndroidResourceResult({
              deviceManager,
              avdManager,
              timer,
              signal: controller.signal,
              onInventoryComplete: (inventory) => {
                fetch.inventory = inventory;
              },
            }),
          {
            timer,
            timeoutMs: ANDROID_INVENTORY_BACKGROUND_CAP_MS,
            signal: controller.signal,
            label: "Android inventory background fetch",
            onTimeout: () => {
              hardCapExpired = true;
              controller.abort(new Error("Android inventory background hard cap elapsed"));
            },
          },
        );
        if (generation === state.generation && result.catalogObservation.catalogComplete) {
          state.stage ??= new TTLCache(timer, { ttlMs: ANDROID_INVENTORY_STAGE_TTL_MS });
          state.stage.set("android", result);
        }
        return result;
      } catch (error) {
        if (hardCapExpired) {
          logger.warn("Android inventory background fetch reached its 30000ms hard cap", error);
          return incompleteAndroidResource(fetch.inventory, ANDROID_INVENTORY_BACKGROUND_CAP_MS);
        }
        if (controller.signal.aborted) {
          // Lifecycle invalidation supersedes this observation; callers can retry the replacement.
          logger.debug(`Android inventory background fetch superseded: ${errorMessage(error)}`);
          return supersededAndroidResource(fetch.inventory);
        }
        logger.warn(`Android inventory background fetch failed: ${errorMessage(error)}`, error);
        return {
          platform: "android",
          images: fetch.inventory?.images ?? [],
          provisioningCatalog: emptyProvisioningCatalog(),
          catalogObservation: failedCatalogObservation("Android", error),
          inventoryObservation:
            fetch.inventory?.observation ??
            failedConfiguredInventoryObservation(
              "failed",
              `Android configured-device inventory failed: ${errorMessage(error)}`,
            ),
        };
      } finally {
        if (state.background === fetch) {
          state.background = undefined;
        }
      }
    }),
  };
  state.background = fetch;
  return fetch;
}

function supersededAndroidResource(
  inventory: AndroidConfiguredInventoryResult | undefined,
): PlatformResourceResult {
  const message =
    "Android inventory fetch was superseded by lifecycle invalidation or shutdown; retry inventory discovery.";
  return {
    platform: "android",
    images: inventory?.images ?? [],
    provisioningCatalog: emptyProvisioningCatalog(),
    catalogObservation: {
      catalogComplete: false,
      error: {
        code: "superseded",
        message,
        retryable: true,
        retryAfterMs: ANDROID_INVENTORY_RETRY_AFTER_MS,
      },
    },
    inventoryObservation:
      inventory?.observation ?? failedConfiguredInventoryObservation("unavailable", message),
  };
}

function incompleteAndroidResource(
  inventory: AndroidConfiguredInventoryResult | undefined,
  budgetMs: number,
): PlatformResourceResult {
  const observation =
    inventory?.observation ??
    failedConfiguredInventoryObservation(
      "timeout",
      `Android configured-device inventory exceeded the ${budgetMs}ms resource budget.`,
    );
  return {
    platform: "android",
    images: inventory?.images ?? [],
    provisioningCatalog: emptyProvisioningCatalog(),
    catalogObservation: {
      catalogComplete: false,
      error: {
        code: "timeout",
        message: `Android device-image resource generation exceeded the ${budgetMs}ms budget; catalog is incomplete.`,
        retryable: true,
        retryAfterMs: ANDROID_INVENTORY_RETRY_AFTER_MS,
        missing: observation.complete ? ["catalog"] : ["catalog", "configuredInventory"],
      },
    },
    inventoryObservation: observation.complete
      ? observation
      : {
          ...observation,
          error: {
            ...observation.error,
            retryable: true,
            retryAfterMs: ANDROID_INVENTORY_RETRY_AFTER_MS,
            missing: ["configuredInventory"],
          },
        },
  };
}

async function computeAndroidResource(options: {
  state: AndroidImageCacheState;
  deviceManager: PlatformDeviceManager;
  avdManager: AvdManager;
  timer: Timer;
  budgetMs: number;
}): Promise<PlatformResourceResult> {
  const { state, timer, budgetMs } = options;
  const staged = state.stage?.get("android");
  if (staged) {
    return staged;
  }
  const background = state.background ?? startAndroidBackgroundFetch(options);
  try {
    return await raceWithDeadline(background.promise, {
      timer,
      timeoutMs: budgetMs,
      label: "Android device-image resource generation",
    });
  } catch (error) {
    logger.warn(
      `[DeviceImageResources] Android device-image resource generation exceeded ${budgetMs}ms; returning retryable incomplete catalog`,
      error,
    );
    return incompleteAndroidResource(background.inventory, budgetMs);
  }
}

async function buildAndroidResourceResult({
  deviceManager,
  avdManager,
  timer,
  signal,
  onInventoryComplete,
}: {
  deviceManager: PlatformDeviceManager;
  avdManager: AvdManager;
  timer: Timer;
  signal: AbortSignal;
  onInventoryComplete: (inventory: AndroidConfiguredInventoryResult) => void;
}): Promise<PlatformResourceResult> {
  const android = await buildAndroidImages(deviceManager, avdManager, timer, signal);
  onInventoryComplete(android);
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
      runtimeCompatibility: iosRuntimeCompatibility(deviceType, runtimeEntries),
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

// Convert DeviceInfo to DeviceImageInfo, merging with AvdInfo for Android
function toDeviceImageInfo(
  device: StableConfiguredDeviceImage,
  avdInfo?: AvdInfo,
): DeviceImageInfo {
  const description = describeDevice({ kind: "image", image: device, androidProvenance: avdInfo });
  return projectConfiguredImage(description);
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
  resetAndroidDeviceImageResourceCache();
  await ResourceRegistry.notifyResourcesUpdated([
    DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/android`,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/ios`,
  ]);
}
