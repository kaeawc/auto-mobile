import { ResourceRegistry, ResourceContent, getRequestedResourceUri } from "./resourceRegistry";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { BootedDevice } from "../models";
import { ActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import type { PreferenceFile, KeyValueEntry } from "../features/storage/storageTypes";
import {
  isIosSdkEntryRedacted,
  readAndroidStorageEntries,
} from "../features/preferences/AppPreferences";
import { findBootedDeviceForResource } from "./resourceDeviceResolver";
import {
  ProviderUnavailableError,
  resourceErrorFields,
} from "../features/storage/ProviderUnavailableError";
import { errorMessage } from "../utils/describeUnknownError";
import {
  readAndroidPreferencesXml,
  resolveAndroidPreferencesUser,
  sanitizeAndroidPreferencesFileName,
} from "../features/preferences/AndroidPreferencesXmlFile";
import { isSharedPreferencesInspectionDisabledError } from "../features/storage/AndroidSharedPreferencesKeyValueFile";
import { isCtrlProxyStorageUnavailableError } from "../features/observe/android/CtrlProxyStorage";

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

type PreferenceEntrySource = "ctrlproxy" | "run-as";

interface PreferenceEntriesResult {
  entries: KeyValueEntry[];
  source: PreferenceEntrySource;
}

let adbClientFactory: AdbClientFactory = defaultAdbClientFactory;

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
  return findBootedDeviceForResource(deviceId, "StorageResources");
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
): Promise<PreferenceEntriesResult> {
  if (device.platform === "android") {
    const client = AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory);
    try {
      return {
        entries: await client.getPreferenceEntries(packageName, fileName),
        source: "ctrlproxy",
      };
    } catch (ctrlProxyError) {
      if (!isPreferenceProviderUnavailableError(ctrlProxyError)) {
        throw ctrlProxyError;
      }
      try {
        const adb = adbClientFactory.create(device);
        // A resource URI carries no user, so resolve it as the preference tools do: the user the
        // package is installed for. A URI could name a user later through a `?userId=` query
        // parameter (templates can declare `queryParamNames`) without changing the path shape; the
        // cache key would then need the user too.
        const userId = await resolveAndroidPreferencesUser(adb, packageName);
        const xml = await readAndroidPreferencesXml(
          adb,
          packageName,
          sanitizeAndroidPreferencesFileName(fileName),
          userId,
        );
        return { entries: await readAndroidStorageEntries(xml), source: "run-as" };
      } catch (runAsError) {
        throw new ActionableError(
          `Failed to read Android SharedPreferences. CtrlProxy: ${errorMessage(ctrlProxyError)}; run-as: ${errorMessage(runAsError)}`,
          { cause: ctrlProxyError },
        );
      }
    }
  } else if (device.platform === "ios") {
    const client = IOSCtrlProxyClient.getInstance(device);
    return {
      entries: await client.getPreferenceEntries(packageName, fileName),
      source: "ctrlproxy",
    };
  }
  throw new Error(`Unsupported platform: ${device.platform}`);
}

function isPreferenceProviderUnavailableError(error: unknown): boolean {
  return (
    error instanceof ProviderUnavailableError ||
    isSharedPreferencesInspectionDisabledError(error) ||
    isCtrlProxyStorageUnavailableError(error)
  );
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

// Decode a percent-encoded path segment, returning null when the encoding is
// malformed. A host-defined package or file name may contain a literal `%`
// that is not valid percent-encoding; letting decodeURIComponent's URIError
// escape would bypass the JSON diagnostic envelope, exactly the failure mode
// #5686 fixed for query params — here for path params (issue #5734).
function safeDecodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    logger.debug(`[StorageResources] Malformed URI segment '${value}': ${error}`);
    return null;
  }
}

// Structured diagnostic for a URI whose path segments are not valid
// percent-encoding, served on the originally-requested URI so the client still
// gets a typed JSON envelope rather than a raw MCP error.
function malformedUriContent(params: Record<string, string>): ResourceContent {
  return {
    uri: getRequestedResourceUri(params) ?? "",
    mimeType: "application/json",
    text: JSON.stringify(
      { error: "Malformed resource URI: a path segment is not valid percent-encoding." },
      null,
      2,
    ),
  };
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
  const decodedPackage = safeDecodeSegment(packageName);
  if (decodedPackage === null) {
    return malformedUriContent(params);
  }
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
      text: JSON.stringify(
        { error: `Failed to list storage files: ${error}`, ...resourceErrorFields(error) },
        null,
        2,
      ),
    };
  }
}

/**
 * Get storage entries resource content
 */
async function getStorageEntriesResource(params: Record<string, string>): Promise<ResourceContent> {
  const { deviceId, packageName, fileName } = params;
  const decodedPackage = safeDecodeSegment(packageName);
  const decodedFileName = safeDecodeSegment(fileName);
  if (decodedPackage === null || decodedFileName === null) {
    return malformedUriContent(params);
  }
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

    const { entries, source } = await getPreferenceEntriesForDevice(
      device,
      decodedPackage,
      decodedFileName,
    );
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
    const outputEntries =
      device.platform === "ios"
        ? entries.map((entry) => {
            return isIosSdkEntryRedacted(entry) ? { ...entry, value: null, redacted: true } : entry;
          })
        : entries;

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          deviceId,
          packageName: decodedPackage,
          fileName: decodedFileName,
          platform: device.platform,
          source,
          entries: outputEntries,
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
      text: JSON.stringify(
        {
          error: `Failed to get storage entries: ${error}`,
          ...resourceErrorFields(
            error instanceof ActionableError && error.cause instanceof ProviderUnavailableError
              ? error.cause
              : error,
          ),
        },
        null,
        2,
      ),
    };
  }
}

/** Test seam for exercising Android run-as fallback without a device. */
export function setStorageResourcesAdbClientFactoryForTesting(
  factory: AdbClientFactory | null,
): void {
  adbClientFactory = factory ?? defaultAdbClientFactory;
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
