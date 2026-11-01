import {
  DEVICE_IMAGE_RESOURCE_URIS,
  ANDROID_INVENTORY_RETRY_AFTER_MS,
} from "../constants/deviceResourceUris";
export { DEVICE_IMAGE_RESOURCE_URIS, ANDROID_INVENTORY_RETRY_AFTER_MS };
import { registerAndroidInventoryCatalogInvalidator } from "../utils/AndroidInventoryInvalidation";
import { registerDeviceResourceInvalidation } from "../daemon/deviceResourceInvalidation";
export { invalidateAndroidInventoryProvenanceAndCatalog } from "../utils/AndroidInventoryInvalidation";
import { errorMessage } from "../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { getAbortSignal, runWithAbortSignal } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { resetAndroidInventoryEnrichmentCache } from "../utils/android-cmdline-tools/AndroidEmulatorClient";
import { AndroidAvdProvenanceCache } from "../utils/AndroidAvdProvenanceCache";
import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { PlatformDeviceManager } from "../devices/deviceUtils";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { AvdManagerService } from "../utils/android-cmdline-tools/AvdManagerService";
import { AvdManager } from "../utils/android-cmdline-tools/interfaces/AvdManager";
import { logger } from "../utils/logger";
import { Platform } from "../models";
import {
  AvdInfo,
  type DeviceProfile,
  type SystemImage,
} from "../utils/android-cmdline-tools/avdmanager";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { AppleTvSimulatorInventory } from "../utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import { WatchSimulatorInventory } from "../utils/ios-cmdline-tools/WatchSimulatorInventory";
import {
  isIosDeviceType,
  isIosSimulatorRuntime,
} from "../utils/ios-cmdline-tools/simulatorRuntimeFamily";
import { describeDevice as describeImageDevice } from "../utils/deviceDescriptionProjection";
import {
  buildSimulatorProvisioningCatalogEntries,
  type ProvisioningCatalog,
} from "./simulatorProvisioningCatalog";
import {
  createConfiguredInventoryContract,
  failedConfiguredInventoryObservation,
  projectConfiguredDeviceInventory,
  type ConfiguredDeviceInventoryContract,
  type ConfiguredDeviceInventoryObservation,
  type StableConfiguredDeviceImage,
} from "../utils/configuredDeviceInventory";
import {
  describeDevice,
  projectConfiguredImage,
  type ConfiguredImage,
} from "../daemon/deviceDescription";
import { TTLCache } from "../utils/cache/Cache";
import { SingleFlight } from "../utils/cache/SingleFlight";

/** Per-read response budget; the shared fetch has its own lifecycle and hard cap. */
export const ANDROID_PROVISIONING_CATALOG_BUDGET_MS = 9_000;
export const ANDROID_INVENTORY_BACKGROUND_CAP_MS = 30_000;
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

registerDeviceResourceInvalidation({ resetAndroidDeviceImageResourceCache });

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
  /** Present when the read covers watchOS (`automobile:devices/images/watchos`). */
  watchosCount?: number;
  /** Present only when the read covers tvOS. */
  tvosCount?: number;
  lastUpdated: string; // ISO 8601
  catalogComplete: boolean;
  catalogObservations: Partial<Record<Platform, ProvisioningCatalogObservation>>;
  provisioningCatalog: ProvisioningCatalog;
  configuredInventory: ConfiguredDeviceInventoryContract;
  images: DeviceImageInfo[];
}

/** The slice of the platform device manager the resource reads; fakes implement just this. */
type DeviceImageDiscoveryManager = Pick<PlatformDeviceManager, "getDeviceImagesDetailed">;

/** The slice of the AVD manager the resource reads; fakes implement just this. */
type DeviceImageAvdManager = Pick<
  AvdManager,
  "listDeviceImages" | "listInstalledSystemImages" | "listDevices"
>;

// Dependencies interface for dependency injection
interface DeviceImageResourcesDependencies {
  deviceManager: DeviceImageDiscoveryManager;
  avdManager: DeviceImageAvdManager;
  simctl: Pick<SimCtlClient, "getDeviceTypesChecked" | "getRuntimesChecked">;
  appleTvInventory: Pick<AppleTvSimulatorInventory, "listAppleTvSimulators" | "readCatalog">;
  watchInventory: Pick<WatchSimulatorInventory, "listWatchSimulators" | "readCatalog">;
  timer: Timer;
  androidCatalogBudgetMs: number;
}

/**
 * Tests often inject only the Android/device seam. Avoid creating a real simctl client in those
 * partial fakes; production construction always includes it.
 */
function simulatorSources(deps: Partial<DeviceImageResourcesDependencies> | undefined): {
  simctl: DeviceImageResourcesDependencies["simctl"] | undefined;
  watchInventory: DeviceImageResourcesDependencies["watchInventory"] | undefined;
  appleTvInventory: DeviceImageResourcesDependencies["appleTvInventory"] | undefined;
} {
  if (deps) {
    return {
      simctl: deps.simctl,
      watchInventory: deps.watchInventory,
      appleTvInventory: deps.appleTvInventory,
    };
  }
  const simctl = new SimCtlClient();
  return {
    simctl,
    watchInventory: new WatchSimulatorInventory(simctl),
    appleTvInventory: new AppleTvSimulatorInventory(simctl),
  };
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
  const deviceManager = deps?.deviceManager ?? PlatformDeviceManagerFactory.getInstance();
  const avdManager = deps?.avdManager ?? new AvdManagerService();
  const sources = simulatorSources(deps);
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
          ? await generateAndroidResource(androidCacheState, deviceManager, avdManager, {
              timer,
              budgetMs: androidCatalogBudgetMs,
            })
          : await buildSimulatorResourceResult(platform, deviceManager, sources),
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
      ...(platforms.includes("watchos")
        ? { watchosCount: images.filter((image) => image.platform === "watchos").length }
        : {}),
      ...(platforms.includes("tvos")
        ? { tvosCount: images.filter((image) => image.platform === "tvos").length }
        : {}),
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
    if (
      platform !== "android" &&
      platform !== "ios" &&
      platform !== "watchos" &&
      platform !== "tvos"
    ) {
      return {
        uri: `automobile:devices/images/${platform}`,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            error: `Invalid platform: ${platform}. Must be 'android', 'ios', 'watchos' or 'tvos'.`,
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
  deviceManager: DeviceImageDiscoveryManager,
  avdManager: DeviceImageAvdManager,
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
  avdManager: DeviceImageAvdManager,
  timer: Timer,
): Promise<ReadonlyMap<string, AvdInfo>> {
  return AndroidAvdProvenanceCache.getInstance().getByName(avdManager, timer);
}

async function buildIosImages(
  deviceManager: DeviceImageDiscoveryManager,
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
  deviceManager: DeviceImageDiscoveryManager,
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

function buildSimulatorResourceResult(
  platform: "ios" | "watchos" | "tvos",
  deviceManager: DeviceImageDiscoveryManager,
  { simctl, watchInventory, appleTvInventory }: ReturnType<typeof simulatorSources>,
): Promise<PlatformResourceResult> {
  if (platform === "ios") {
    return buildIosResourceResult(deviceManager, simctl);
  }
  const inventory = platform === "watchos" ? watchInventory : appleTvInventory;
  const list =
    platform === "watchos"
      ? watchInventory && (() => watchInventory.listWatchSimulators())
      : appleTvInventory && (() => appleTvInventory.listAppleTvSimulators());
  return buildAppleSimulatorResourceResult(platform, list, inventory);
}

/** Non-iOS Apple simulators and their catalog are read only by explicit platform requests. */
async function buildAppleSimulatorResourceResult(
  platform: "watchos" | "tvos",
  list: (() => ReturnType<WatchSimulatorInventory["listWatchSimulators"]>) | undefined,
  inventory: Pick<WatchSimulatorInventory, "readCatalog"> | undefined,
): Promise<PlatformResourceResult> {
  const label = platform === "watchos" ? "watchOS" : "tvOS";
  if (!list || !inventory) {
    const error = { code: "unavailable" as const, message: `${label} inventory is unavailable.` };
    return {
      platform,
      images: [],
      provisioningCatalog: emptyProvisioningCatalog(),
      catalogObservation: { catalogComplete: false, error },
      inventoryObservation: { complete: false, error },
    };
  }
  const [images, catalog] = await Promise.all([
    list().then(
      (devices) => ({
        images: devices.map((device) =>
          projectConfiguredImage(
            describeImageDevice({
              kind: "image",
              image: { ...device, stableId: device.deviceId ?? device.name },
            }),
          ),
        ),
        observation: { complete: true } as ConfiguredDeviceInventoryObservation,
      }),
      (error: unknown) => {
        logger.warn(
          `[DeviceImageResources] Failed to list ${label} simulators: ${errorMessage(error)}`,
          error,
        );
        return {
          images: [],
          observation: failedConfiguredInventoryObservation(
            "failed",
            `${label} configured-device inventory failed: ${errorMessage(error)}`,
          ),
        };
      },
    ),
    inventory.readCatalog().then(
      ({ runtimes, deviceTypes }) => ({
        catalog: buildSimulatorProvisioningCatalogEntries(platform, runtimes, deviceTypes),
        observation: { catalogComplete: true },
      }),
      (error: unknown) => {
        logger.warn(
          `[DeviceImageResources] Failed to build ${label} provisioning catalog: ${errorMessage(error)}`,
          error,
        );
        return {
          catalog: emptyProvisioningCatalog(),
          observation: failedCatalogObservation(label, error),
        };
      },
    ),
  ]);
  return {
    platform,
    images: images.images,
    provisioningCatalog: catalog.catalog,
    catalogObservation: catalog.observation,
    inventoryObservation: images.observation,
  };
}

async function generateAndroidResource(
  state: AndroidImageCacheState,
  deviceManager: DeviceImageDiscoveryManager,
  avdManager: DeviceImageAvdManager,
  { timer, budgetMs }: { timer: Timer; budgetMs: number },
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
  deviceManager: DeviceImageDiscoveryManager;
  avdManager: DeviceImageAvdManager;
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
  deviceManager: DeviceImageDiscoveryManager;
  avdManager: DeviceImageAvdManager;
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
  deviceManager: DeviceImageDiscoveryManager;
  avdManager: DeviceImageAvdManager;
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
    // Only iOS runtimes and iPhone/iPad models: watch, Apple TV and Vision Pro ones are never
    // iOS images (#14901, #15885).
    return {
      catalog: buildSimulatorProvisioningCatalogEntries(
        "ios",
        runtimes.filter((runtime) => isIosSimulatorRuntime(runtime.identifier)),
        deviceTypes.filter((deviceType) => isIosDeviceType(deviceType)),
      ),
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
  platform: "Android" | "iOS" | "watchOS" | "tvOS",
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
  ResourceRegistry.register(DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES, "Device Images", {
    description:
      "Configured AVD and simulator inventory with versioned per-platform completeness evidence.",
    mimeType: "application/json",
    handler: handler.getAllDeviceImages,
  });

  // Register the platform-specific template
  ResourceRegistry.registerTemplate(
    DEVICE_IMAGE_RESOURCE_URIS.PLATFORM_TEMPLATE,
    "Platform-specific Device Images",
    {
      description:
        "Configured device inventory and completeness evidence for android, ios, watchos or tvos.",
      mimeType: "application/json",
      handler: handler.getDeviceImagesByPlatform,
    },
  );

  logger.info("[DeviceImageResources] Registered device image resources");
}

export async function notifyDeviceImageResourcesUpdated(): Promise<void> {
  resetAndroidDeviceImageResourceCache();
  await ResourceRegistry.notifyResourcesUpdated([
    DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/android`,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/ios`,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/watchos`,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/tvos`,
  ]);
}
