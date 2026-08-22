import { errorMessage } from "../utils/describeUnknownError";
import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { MultiPlatformDeviceManager, PlatformDeviceManager } from "../utils/deviceUtils";
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

// Resource URIs
export const DEVICE_IMAGE_RESOURCE_URIS = {
  ALL_IMAGES: "automobile:devices/images",
  PLATFORM_TEMPLATE: "automobile:devices/images/{platform}"
} as const;

// Device image info for resource response
interface DeviceImageInfo {
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
}

interface ProvisioningRuntime {
  platform: Platform;
  id: string;
  name: string;
  version?: string;
  available?: boolean;
}

interface ProvisioningDeviceType {
  platform: Platform;
  id: string;
  name: string;
  family?: string;
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
    code: "unavailable" | "failed";
    message: string;
  };
}

// Resource content schema
export interface DeviceImagesResourceContent {
  totalCount: number;
  androidCount: number;
  iosCount: number;
  lastUpdated: string;  // ISO 8601
  catalogComplete: boolean;
  catalogObservations: Partial<Record<Platform, ProvisioningCatalogObservation>>;
  provisioningCatalog: ProvisioningCatalog;
  images: DeviceImageInfo[];
}

// Dependencies interface for dependency injection
interface DeviceImageResourcesDependencies {
  deviceManager: PlatformDeviceManager;
  avdManager: AvdManager;
  simctl: Pick<SimCtlClient, "getDeviceTypesChecked" | "getRuntimesChecked">;
}

/**
 * Create a DeviceImageResourcesHandler with injected dependencies.
 * Constructor injection is the single DI seam for this resource handler:
 * production wiring passes real implementations, tests pass fakes.
 */
export function createDeviceImageResourcesHandler(
  deps?: Partial<DeviceImageResourcesDependencies>
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

  const getDeviceImagesForPlatformsImpl = async (platforms: Platform[]): Promise<DeviceImagesResourceContent> => {
    const images: DeviceImageInfo[] = [];
    const provisioningCatalog: ProvisioningCatalog = {
      runtimes: [],
      deviceTypes: [],
      systemImages: [],
      profiles: [],
    };
    const catalogObservations: Partial<Record<Platform, ProvisioningCatalogObservation>> = {};
    const androidCount = platforms.includes("android")
      ? await appendAndroidImages(deviceManager, avdManager, images)
      : 0;
    if (platforms.includes("android")) {
      catalogObservations.android = await buildAndroidProvisioningCatalog(
        avdManager,
        provisioningCatalog
      );
    }

    const iosCount = platforms.includes("ios")
      ? await appendIosImages(deviceManager, images)
      : 0;
    if (platforms.includes("ios")) {
      catalogObservations.ios = await buildIosProvisioningCatalog(simctl, provisioningCatalog);
    }

    return {
      totalCount: images.length,
      androidCount,
      iosCount,
      lastUpdated: new Date().toISOString(),
      catalogComplete: platforms.every(platform => catalogObservations[platform]?.catalogComplete === true),
      catalogObservations,
      provisioningCatalog,
      images
    };
  };

  const getAllDeviceImagesImpl = async (): Promise<ResourceContent> => {
    const result = await getDeviceImagesForPlatformsImpl(["android", "ios"]);
    return {
      uri: DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES,
      mimeType: "application/json",
      text: JSON.stringify(result, null, 2)
    };
  };

  const getDeviceImagesByPlatformImpl = async (params: Record<string, string>): Promise<ResourceContent> => {
    const platform = params.platform;

    // Validate platform parameter
    if (platform !== "android" && platform !== "ios") {
      return {
        uri: `automobile:devices/images/${platform}`,
        mimeType: "application/json",
        text: JSON.stringify({
          error: `Invalid platform: ${platform}. Must be 'android' or 'ios'.`
        }, null, 2)
      };
    }

    const result = await getDeviceImagesForPlatformsImpl([platform as Platform]);
    return {
      uri: `automobile:devices/images/${platform}`,
      mimeType: "application/json",
      text: JSON.stringify(result, null, 2)
    };
  };

  return {
    getAllDeviceImages: getAllDeviceImagesImpl,
    getDeviceImagesByPlatform: getDeviceImagesByPlatformImpl,
    getDeviceImagesForPlatforms: getDeviceImagesForPlatformsImpl
  };
}

async function appendAndroidImages(
  deviceManager: PlatformDeviceManager,
  avdManager: AvdManager,
  images: DeviceImageInfo[]
): Promise<number> {
  try {
    const [androidDevices, avdInfoList] = await Promise.all([
      deviceManager.listDeviceImages("android"),
      readAvdInfo(avdManager),
    ]);
    const avdInfoByName = new Map(avdInfoList.map(avd => [avd.name, avd]));
    for (const device of androidDevices) {
      images.push(toDeviceImageInfo(device, avdInfoByName.get(device.name)));
    }
    return androidDevices.length;
  } catch (error) {
    logger.warn(`[DeviceImageResources] Failed to list Android device images: ${error}`);
    return 0;
  }
}

async function readAvdInfo(avdManager: AvdManager): Promise<AvdInfo[]> {
  try {
    return await avdManager.listDeviceImages();
  } catch (error) {
    logger.warn(`[DeviceImageResources] Failed to get extended AVD info: ${error}`);
    return [];
  }
}

async function appendIosImages(
  deviceManager: PlatformDeviceManager,
  images: DeviceImageInfo[]
): Promise<number> {
  try {
    const iosDevices = await deviceManager.listDeviceImages("ios");
    for (const device of iosDevices) {
      images.push(toDeviceImageInfo(device));
    }
    return iosDevices.length;
  } catch (error) {
    logger.warn(`[DeviceImageResources] Failed to list iOS simulator images: ${error}`);
    return 0;
  }
}

async function buildAndroidProvisioningCatalog(
  avdManager: AvdManager,
  catalog: ProvisioningCatalog
): Promise<ProvisioningCatalogObservation> {
  try {
    const [availableSystemImages, installedSystemImages, profiles] = await Promise.all([
      avdManager.listSystemImages(),
      avdManager.listInstalledSystemImages(),
      avdManager.listDevices(),
    ]);
    const systemImages = new Map(
      [...availableSystemImages, ...installedSystemImages]
        .map(image => [image.packageName, image])
    );
    appendAndroidProvisioningCatalog(catalog, [...systemImages.values()], profiles);
    return { catalogComplete: true };
  } catch (error) {
    logger.warn(`[DeviceImageResources] Failed to build Android provisioning catalog: ${error}`);
    return failedCatalogObservation("Android", error);
  }
}

async function buildIosProvisioningCatalog(
  simctl: Pick<SimCtlClient, "getDeviceTypesChecked" | "getRuntimesChecked"> | undefined,
  catalog: ProvisioningCatalog
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
  error: unknown
): ProvisioningCatalogObservation {
  return {
    catalogComplete: false,
    error: {
      code: "failed",
      message: `${platform} provisioning catalog failed: ${errorMessage(error)}`,
    },
  };
}

function appendAndroidProvisioningCatalog(
  catalog: ProvisioningCatalog,
  systemImages: SystemImage[],
  profiles: DeviceProfile[]
): void {
  for (const image of systemImages) {
    catalog.runtimes.push({
      platform: "android",
      id: image.packageName,
      name: image.versionInfo,
      version: String(image.apiLevel),
      available: true,
    });
    catalog.systemImages.push({
      platform: "android",
      id: image.packageName,
      name: image.versionInfo,
      apiLevel: image.apiLevel,
      tag: image.tag,
      abi: image.abi,
      version: String(image.apiLevel),
    });
  }

  for (const profile of profiles) {
    const name = profile.name ?? profile.id;
    catalog.deviceTypes.push({
      platform: "android",
      id: profile.id,
      name,
      ...(profile.oem ? { family: profile.oem } : {}),
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
  deviceTypes: AppleDeviceType[]
): void {
  for (const runtime of runtimes) {
    catalog.runtimes.push({
      platform: "ios",
      id: runtime.identifier,
      name: runtime.name,
      version: runtime.version,
      available: runtime.isAvailable,
    });
  }

  for (const deviceType of deviceTypes) {
    catalog.deviceTypes.push({
      platform: "ios",
      id: deviceType.identifier,
      name: deviceType.name,
      family: deviceType.productFamily,
    });
  }
}

// Convert DeviceInfo to DeviceImageInfo, merging with AvdInfo for Android
function toDeviceImageInfo(device: DeviceInfo, avdInfo?: AvdInfo): DeviceImageInfo {
  return {
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
    architecture: device.architecture
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
    "List of all available device images (AVDs and simulators) that can be used to start devices.",
    "application/json",
    handler.getAllDeviceImages
  );

  // Register the platform-specific template
  ResourceRegistry.registerTemplate(
    DEVICE_IMAGE_RESOURCE_URIS.PLATFORM_TEMPLATE,
    "Platform-specific Device Images",
    "List of available device images for a specific platform (android or ios).",
    "application/json",
    handler.getDeviceImagesByPlatform
  );

  logger.info("[DeviceImageResources] Registered device image resources");
}

export async function notifyDeviceImageResourcesUpdated(): Promise<void> {
  await ResourceRegistry.notifyResourcesUpdated([
    DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/android`,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/ios`
  ]);
}
