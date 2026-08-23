import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { BootedDevice } from "../models";
import { logger } from "../utils/logger";
import type { PreferenceFile, KeyValueEntry } from "../features/storage/storageTypes";

// Resource URI templates
const STORAGE_RESOURCE_TEMPLATES = {
  FILES: "automobile:devices/{deviceId}/storage/{packageName}/files",
  ENTRIES: "automobile:devices/{deviceId}/storage/{packageName}/{fileName}/entries",
} as const;

// Cache entries for change detection
interface StorageFilesCacheEntry {
  files: PreferenceFile[];
  lastUpdated: string;
  hash: string;
}

interface StorageEntriesCacheEntry {
  entries: KeyValueEntry[];
  lastUpdated: string;
  hash: string;
}

interface StorageCache {
  files: Map<string, StorageFilesCacheEntry>; // key: `${deviceId}:${packageName}`
  entries: Map<string, StorageEntriesCacheEntry>; // key: `${deviceId}:${packageName}:${fileName}`
}

const cache: StorageCache = {
  files: new Map(),
  entries: new Map(),
};

/**
 * Generate a simple hash for change detection
 */
function generateHash(data: unknown): string {
  const str = JSON.stringify(data);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Find a booted device by ID across both platforms
 */
async function findBootedDevice(deviceId: string): Promise<BootedDevice | null> {
  try {
    const manager = PlatformDeviceManagerFactory.getInstance();
    // Try Android first
    const androidDevices = await manager.getBootedDevices("android");
    const android = androidDevices.find((d) => d.deviceId === deviceId);
    if (android) {
      return android;
    }

    // Try iOS
    const iosDevices = await manager.getBootedDevices("ios");
    const ios = iosDevices.find((d) => d.deviceId === deviceId);
    if (ios) {
      return ios;
    }

    return null;
  } catch (error) {
    logger.warn(`[StorageResources] Failed to find device ${deviceId}: ${error}`);
    return null;
  }
}

/**
 * List preference files using the platform-appropriate client
 */
async function listPreferenceFilesForDevice(
  device: BootedDevice,
  packageName: string,
): Promise<PreferenceFile[]> {
  if (device.platform === "android") {
    const client = AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory);
    return client.listPreferenceFiles(packageName);
  } else if (device.platform === "ios") {
    const client = IOSCtrlProxyClient.getInstance(device);
    return client.listPreferenceFiles(packageName);
  }
  throw new Error(`Unsupported platform: ${device.platform}`);
}

/**
 * Get preference entries using the platform-appropriate client
 */
async function getPreferenceEntriesForDevice(
  device: BootedDevice,
  packageName: string,
  fileName: string,
): Promise<KeyValueEntry[]> {
  if (device.platform === "android") {
    const client = AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory);
    return client.getPreferenceEntries(packageName, fileName);
  } else if (device.platform === "ios") {
    const client = IOSCtrlProxyClient.getInstance(device);
    return client.getPreferenceEntries(packageName, fileName);
  }
  throw new Error(`Unsupported platform: ${device.platform}`);
}

/**
 * Get cache key for storage files
 */
function getFilesCacheKey(deviceId: string, packageName: string): string {
  return `${deviceId}:${packageName}`;
}

/**
 * Get cache key for storage entries
 */
function getEntriesCacheKey(deviceId: string, packageName: string, fileName: string): string {
  return `${deviceId}:${packageName}:${fileName}`;
}

/**
 * Build resource URI for storage files
 */
function buildFilesUri(deviceId: string, packageName: string): string {
  return `automobile:devices/${deviceId}/storage/${encodeURIComponent(packageName)}/files`;
}

/**
 * Build resource URI for storage entries
 */
function buildEntriesUri(deviceId: string, packageName: string, fileName: string): string {
  return `automobile:devices/${deviceId}/storage/${encodeURIComponent(packageName)}/${encodeURIComponent(fileName)}/entries`;
}

/**
 * Get storage files resource content
 */
async function getStorageFilesResource(params: Record<string, string>): Promise<ResourceContent> {
  const { deviceId, packageName } = params;
  const decodedPackage = decodeURIComponent(packageName);
  const uri = buildFilesUri(deviceId, decodedPackage);

  logger.info(
    `[StorageResources] getStorageFilesResource: deviceId=${deviceId}, packageName=${decodedPackage}`,
  );

  try {
    const device = await findBootedDevice(deviceId);
    if (!device) {
      logger.warn(`[StorageResources] Device not found: ${deviceId}`);
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: `Device not found or not booted: ${deviceId}` }, null, 2),
      };
    }

    logger.info(
      `[StorageResources] Found device: ${device.deviceId} (${device.platform}), calling listPreferenceFiles`,
    );
    const files = await listPreferenceFilesForDevice(device, decodedPackage);
    logger.info(`[StorageResources] listPreferenceFiles returned ${files.length} files`);
    const lastUpdated = new Date().toISOString();
    const hash = generateHash(files);

    // Check for changes and notify
    const cacheKey = getFilesCacheKey(deviceId, decodedPackage);
    const cached = cache.files.get(cacheKey);
    if (cached && cached.hash !== hash) {
      logger.info(`[StorageResources] Storage files changed for ${decodedPackage} on ${deviceId}`);
      void ResourceRegistry.notifyResourceUpdated(uri);
    }

    // Update cache
    cache.files.set(cacheKey, { files, lastUpdated, hash });

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          deviceId,
          packageName: decodedPackage,
          platform: device.platform,
          files,
          totalCount: files.length,
          lastUpdated,
        },
        null,
        2,
      ),
    };
  } catch (error) {
    logger.error(`[StorageResources] Failed to list storage files: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Failed to list storage files: ${error}` }, null, 2),
    };
  }
}

/**
 * Get storage entries resource content
 */
async function getStorageEntriesResource(params: Record<string, string>): Promise<ResourceContent> {
  const { deviceId, packageName, fileName } = params;
  const decodedPackage = decodeURIComponent(packageName);
  const decodedFileName = decodeURIComponent(fileName);
  const uri = buildEntriesUri(deviceId, decodedPackage, decodedFileName);

  try {
    const device = await findBootedDevice(deviceId);
    if (!device) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: `Device not found or not booted: ${deviceId}` }, null, 2),
      };
    }

    const entries = await getPreferenceEntriesForDevice(device, decodedPackage, decodedFileName);
    const lastUpdated = new Date().toISOString();
    const hash = generateHash(entries);

    // Check for changes and notify
    const cacheKey = getEntriesCacheKey(deviceId, decodedPackage, decodedFileName);
    const cached = cache.entries.get(cacheKey);
    if (cached && cached.hash !== hash) {
      logger.info(
        `[StorageResources] Storage entries changed for ${decodedPackage}/${decodedFileName} on ${deviceId}`,
      );
      void ResourceRegistry.notifyResourceUpdated(uri);
    }

    // Update cache
    cache.entries.set(cacheKey, { entries, lastUpdated, hash });

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          deviceId,
          packageName: decodedPackage,
          fileName: decodedFileName,
          platform: device.platform,
          entries,
          totalCount: entries.length,
          lastUpdated,
        },
        null,
        2,
      ),
    };
  } catch (error) {
    logger.error(`[StorageResources] Failed to get storage entries: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Failed to get storage entries: ${error}` }, null, 2),
    };
  }
}

/**
 * Register storage resources
 */
export function registerStorageResources(): void {
  // Register template for listing storage files
  ResourceRegistry.registerTemplate(
    STORAGE_RESOURCE_TEMPLATES.FILES,
    "App Storage Files",
    "List all storage files in an app (Android SharedPreferences or iOS UserDefaults suites). Requires app to have AutoMobile SDK with storage inspection enabled.",
    "application/json",
    getStorageFilesResource,
  );

  // Register template for getting storage entries
  ResourceRegistry.registerTemplate(
    STORAGE_RESOURCE_TEMPLATES.ENTRIES,
    "Storage File Entries",
    "Get all key-value entries from a storage file (Android SharedPreferences or iOS UserDefaults suite).",
    "application/json",
    getStorageEntriesResource,
  );

  logger.info("[StorageResources] Registered storage resources");
}
