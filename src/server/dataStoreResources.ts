import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { serverConfig } from "../utils/ServerConfig";
import { BootedDevice } from "../models";
import { logger } from "../utils/logger";
import type { PreferenceFile, KeyValueEntry } from "../features/storage/storageTypes";
import {
  computeStorageCapabilities,
  findOperationCapability,
  type OperationCapability,
} from "../features/storage/storageCapabilities";
import { resolveStorageCapabilityContext } from "./storageCapabilityResources";

/**
 * MCP resources that project delivered Android Jetpack DataStore reads into the
 * storage resource family (issue #5603).
 *
 * DataStore lists and entries reuse the same resource-oriented workflow as
 * key-value state (`storageResources.ts`), but are keyed by the host-registered
 * adapter name rather than a file name, and are Android-only (DataStore has no
 * iOS analog). Every response carries a structured `status` so a client can
 * distinguish an available read from `unavailable` (device/adapter absent),
 * `disabled` (embedded SDK off), and `unsupported` (non-Android platform)
 * without parsing a failed operation. The `key_value` capability from the
 * storage-capabilities resource (#5602) is echoed as `capability` for the same
 * diagnostic negotiation.
 */

// Resource URI templates. The extra `/datastore/` segments keep these distinct
// from the shorter files (`.../{packageName}/files`) and entries
// (`.../{packageName}/{fileName}/entries`) templates so neither shadows the other.
const DATA_STORE_RESOURCE_TEMPLATES = {
  STORES: "automobile:devices/{deviceId}/storage/{packageName}/datastore/{adapterName}/stores",
  ENTRIES:
    "automobile:devices/{deviceId}/storage/{packageName}/datastore/{adapterName}/{storeName}/entries",
} as const;

const RESOURCE_KIND = "datastore" as const;

/**
 * Read seam for DataStore lists and entries. The default implementation routes
 * through the Android CtrlProxy client; tests inject a fake so routing, typed
 * diagnostics, and update behavior run without devices or sockets.
 */
export interface DataStoreResourceReader {
  listDataStores(
    device: BootedDevice,
    packageName: string,
    adapterName: string,
  ): Promise<PreferenceFile[]>;
  getDataStore(
    device: BootedDevice,
    packageName: string,
    adapterName: string,
    storeName: string,
  ): Promise<KeyValueEntry[]>;
}

const defaultDataStoreReader: DataStoreResourceReader = {
  listDataStores(device, packageName, adapterName) {
    const client = AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory);
    return client.listDataStores(packageName, adapterName);
  },
  getDataStore(device, packageName, adapterName, storeName) {
    const client = AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory);
    return client.getDataStore(packageName, adapterName, storeName);
  },
};

// Cache entries for change detection (mirrors storageResources.ts).
interface DataStoreCacheEntry {
  hash: string;
}

const cache = {
  stores: new Map<string, DataStoreCacheEntry>(), // key: `${deviceId}:${packageName}:${adapterName}`
  entries: new Map<string, DataStoreCacheEntry>(), // key: `${deviceId}:${packageName}:${adapterName}:${storeName}`
};

/**
 * Generate a simple hash for change detection.
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
    // Best-effort discovery: an unavailable device manager surfaces as
    // "device not found" rather than a resource fault.
    logger.warn(`[DataStoreResources] Failed to find device ${deviceId}: ${error}`);
    return null;
  }
}

function buildStoresUri(deviceId: string, packageName: string, adapterName: string): string {
  return `automobile:devices/${deviceId}/storage/${encodeURIComponent(packageName)}/datastore/${encodeURIComponent(adapterName)}/stores`;
}

function buildEntriesUri(
  deviceId: string,
  packageName: string,
  adapterName: string,
  storeName: string,
): string {
  return `automobile:devices/${deviceId}/storage/${encodeURIComponent(packageName)}/datastore/${encodeURIComponent(adapterName)}/${encodeURIComponent(storeName)}/entries`;
}

function jsonContent(uri: string, body: Record<string, unknown>): ResourceContent {
  return { uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) };
}

// Resolve the key_value capability for one operation from the storage-capabilities
// model (#5602), so DataStore diagnostics stay consistent with the capability
// resource a client would otherwise negotiate against.
function keyValueCapability(
  device: BootedDevice,
  packageName: string,
  operation: "list" | "read",
): OperationCapability | undefined {
  const report = computeStorageCapabilities(resolveStorageCapabilityContext(device, packageName));
  return findOperationCapability(report, "key_value", operation);
}

// Shared pre-read gate: resolve the device and classify any non-available state
// (unavailable / unsupported / disabled) into a structured diagnostic body.
// Returns the resolved device when the read may proceed, or a ready-to-serve
// diagnostic body otherwise.
async function resolveReadable(
  deviceId: string,
  packageName: string,
  adapterName: string,
  operation: "list" | "read",
): Promise<{ device: BootedDevice } | { diagnostic: Record<string, unknown> }> {
  const device = await findBootedDevice(deviceId);
  if (!device) {
    return {
      diagnostic: {
        status: "unavailable",
        kind: RESOURCE_KIND,
        deviceId,
        packageName,
        adapterName,
        reason: `Device not found or not booted: ${deviceId}`,
      },
    };
  }

  if (device.platform !== "android") {
    return {
      diagnostic: {
        status: "unsupported",
        kind: RESOURCE_KIND,
        deviceId,
        packageName,
        adapterName,
        platform: device.platform,
        reason: `DataStore is Android-only; not available on ${device.platform}.`,
        capability: keyValueCapability(device, packageName, operation),
      },
    };
  }

  if (!serverConfig.isEmbeddedSdkEnabled()) {
    const capability = keyValueCapability(device, packageName, operation);
    return {
      diagnostic: {
        status: "disabled",
        kind: RESOURCE_KIND,
        deviceId,
        packageName,
        adapterName,
        platform: device.platform,
        reason:
          capability?.reason ??
          "DataStore inspection requires the AutoMobile SDK embedded with storage inspection.",
        capability,
      },
    };
  }

  return { device };
}

async function getDataStoresResource(
  params: Record<string, string>,
  reader: DataStoreResourceReader,
): Promise<ResourceContent> {
  const deviceId = params.deviceId;
  const packageName = decodeURIComponent(params.packageName);
  const adapterName = decodeURIComponent(params.adapterName);
  const uri = buildStoresUri(deviceId, packageName, adapterName);

  const gate = await resolveReadable(deviceId, packageName, adapterName, "list");
  if ("diagnostic" in gate) {
    return jsonContent(uri, gate.diagnostic);
  }
  const device = gate.device;

  try {
    const stores = await reader.listDataStores(device, packageName, adapterName);
    const lastUpdated = new Date().toISOString();
    const hash = generateHash(stores);

    const cacheKey = `${deviceId}:${packageName}:${adapterName}`;
    const cached = cache.stores.get(cacheKey);
    if (cached && cached.hash !== hash) {
      void ResourceRegistry.notifyResourceUpdated(uri);
    }
    cache.stores.set(cacheKey, { hash });

    return jsonContent(uri, {
      status: "available",
      kind: RESOURCE_KIND,
      deviceId,
      packageName,
      adapterName,
      platform: device.platform,
      stores,
      totalCount: stores.length,
      lastUpdated,
      capability: keyValueCapability(device, packageName, "list"),
    });
  } catch (error) {
    // A registered adapter that fails to answer (absent app integration, no
    // adapter under this name) surfaces here as a bounded read failure.
    logger.warn(`[DataStoreResources] Failed to list data stores: ${error}`);
    return jsonContent(uri, {
      status: "unavailable",
      kind: RESOURCE_KIND,
      deviceId,
      packageName,
      adapterName,
      platform: device.platform,
      reason: `Failed to list data stores (adapter or app integration may be absent): ${error}`,
    });
  }
}

async function getDataStoreEntriesResource(
  params: Record<string, string>,
  reader: DataStoreResourceReader,
): Promise<ResourceContent> {
  const deviceId = params.deviceId;
  const packageName = decodeURIComponent(params.packageName);
  const adapterName = decodeURIComponent(params.adapterName);
  const storeName = decodeURIComponent(params.storeName);
  const uri = buildEntriesUri(deviceId, packageName, adapterName, storeName);

  const gate = await resolveReadable(deviceId, packageName, adapterName, "read");
  if ("diagnostic" in gate) {
    return jsonContent(uri, { ...gate.diagnostic, name: storeName });
  }
  const device = gate.device;

  try {
    const entries = await reader.getDataStore(device, packageName, adapterName, storeName);
    const lastUpdated = new Date().toISOString();
    const hash = generateHash(entries);

    const cacheKey = `${deviceId}:${packageName}:${adapterName}:${storeName}`;
    const cached = cache.entries.get(cacheKey);
    if (cached && cached.hash !== hash) {
      void ResourceRegistry.notifyResourceUpdated(uri);
    }
    cache.entries.set(cacheKey, { hash });

    return jsonContent(uri, {
      status: "available",
      kind: RESOURCE_KIND,
      deviceId,
      packageName,
      adapterName,
      name: storeName,
      platform: device.platform,
      entries,
      totalCount: entries.length,
      lastUpdated,
      capability: keyValueCapability(device, packageName, "read"),
    });
  } catch (error) {
    logger.warn(`[DataStoreResources] Failed to get data store entries: ${error}`);
    return jsonContent(uri, {
      status: "unavailable",
      kind: RESOURCE_KIND,
      deviceId,
      packageName,
      adapterName,
      name: storeName,
      platform: device.platform,
      reason: `Failed to read data store (adapter or app integration may be absent): ${error}`,
    });
  }
}

/**
 * Test-only: drop cached change-detection state so suites sharing the module
 * singleton stay hermetic.
 */
export function clearDataStoreResourceCacheForTesting(): void {
  cache.stores.clear();
  cache.entries.clear();
}

/**
 * Register Android DataStore list and entry resources (issue #5603).
 */
export function registerDataStoreResources(
  reader: DataStoreResourceReader = defaultDataStoreReader,
): void {
  ResourceRegistry.registerTemplate(
    DATA_STORE_RESOURCE_TEMPLATES.STORES,
    "App DataStore Instances",
    "List the Jetpack DataStore instances an app exposes through a host-registered AutoMobile SDK adapter (Android only).",
    "application/json",
    (params) => getDataStoresResource(params, reader),
  );

  ResourceRegistry.registerTemplate(
    DATA_STORE_RESOURCE_TEMPLATES.ENTRIES,
    "DataStore Instance Entries",
    "Read the key-value entries of a named Jetpack DataStore instance via a host-registered AutoMobile SDK adapter (Android only).",
    "application/json",
    (params) => getDataStoreEntriesResource(params, reader),
  );

  logger.info("[DataStoreResources] Registered DataStore resources");
}
