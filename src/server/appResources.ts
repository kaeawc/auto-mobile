import { ResourceRegistry, ResourceContent, getRequestedResourceUri } from "./resourceRegistry";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { ListInstalledApps } from "../features/observe/ListInstalledApps";
import type { AppResourceDependencies } from "../features/deviceLifecycle/deviceLifecycleServerHost";
import { GetAppMetadata } from "../features/observe/GetAppMetadata";
import { createIosMetadataSource } from "../utils/iosAppMetadataSource";
import { BootedDevice, Platform } from "../models";
import { logger } from "../utils/logger";
import {
  getInstalledAppsCacheWriteCoordinator,
  type InstalledAppsCacheWriteCoordinator,
} from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier, type DbWriteBarrier } from "../db/dbWriteBarrier";
import { InstalledAppsRepository, type InstalledAppsStore } from "../db/installedAppsRepository";
import {
  registerDeviceIncarnationListener,
  type DeviceIncarnationListener,
} from "../utils/deviceIncarnation";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { SingleFlight } from "../utils/cache/SingleFlight";
import { isIosPhysicalUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import {
  findBootedDeviceForResource,
  listBootedDevicesForResource,
} from "./resourceDeviceResolver";
import type {
  AppsCacheEntry,
  AppsQueryDeviceContent,
  AppsQueryOptions,
  AppsQueryResourceContent,
  AppsQueryType,
  AppsResourceContent,
} from "./appResourcesTypes";
import {
  buildAppsByPackage,
  normalizeAndroidApps,
  normalizeIosApps,
} from "./appResourcesNormalization";
import {
  assertRequestedTypeIsAnswerable,
  filterAppsByQuery,
  isLaunchabilityUnknown,
  launchabilityUnknownApps,
  launchabilityUnknownProfiles,
  resolveEffectiveAppsQueryType,
} from "./appResourcesQuery";

export type {
  AppsQueryAppInfo,
  AppsQueryOptions,
  AppsQueryResourceContent,
} from "./appResourcesTypes";
export { extractIosApplicationType, toQueryIosApp } from "./appResourcesNormalization";
export { filterAppsByQuery } from "./appResourcesQuery";

// Resource URI templates
export const APP_RESOURCE_TEMPLATES = {
  DEVICE_APPS: "automobile:devices/{deviceId}/apps",
  DEVICE_APP: "automobile:devices/{deviceId}/apps/{packageName}",
  DEVICE_APP_METADATA: "automobile:devices/{deviceId}/apps/{appId}/metadata",
} as const;

export const APPS_RESOURCE_URIS = {
  BASE: "automobile:apps",
} as const;

const APPS_QUERY_KEYS = ["deviceId", "platform", "search", "type", "profile"] as const;
const APPS_QUERY_TEMPLATE = `${APPS_RESOURCE_URIS.BASE}{?${APPS_QUERY_KEYS.join(",")}}`;
const APPS_QUERY_PARAM_KEYS = new Set<string>(APPS_QUERY_KEYS);
/** Single source of truth for the accepted `type` values (tool schema + resource query string). */
export const APPS_QUERY_TYPES: ReadonlySet<string> = new Set<AppsQueryType>([
  "user",
  "system",
  "all",
  "launchable",
]);

const APPS_CACHE_TTL_MS = 60000;
const APPS_QUERY_URI_TTL_MS = 300000;
const appCacheByDeviceId = new Map<string, AppsCacheEntry>();
const appsCacheEntrySingleFlight = new SingleFlight<string, AppsCacheEntry | null>();
const appsCacheEntryFlightKey = (deviceId: string, generation: number): string =>
  JSON.stringify([deviceId, generation]);
const registeredDeviceResources = new Map<string, string>();
const appsQueryUrisByDeviceId = new Map<string, Map<string, number>>();
// Discovery is best-effort and may overlap a committed boot with a
// teardown/reboot inventory refresh. Only the newest started discovery may
// publish its snapshot into the shared resource registry.
let installedAppResourceRegistryGeneration = 0;
// A refresh can mutate the registry, then yield while clearing cache entries
// for disappeared devices. Keep that mutation pending until the newest
// completing refresh hands it to its caller for publication.
let installedAppResourceRegistryRevision = 0;
let installedAppResourceRegistryHandoffRevision = 0;

function recordAppsQueryUri(deviceId: string, uri: string, timer: Timer = defaultTimer): void {
  const now = timer.now();
  let entries = appsQueryUrisByDeviceId.get(deviceId);
  if (!entries) {
    entries = new Map();
    appsQueryUrisByDeviceId.set(deviceId, entries);
  }
  entries.set(uri, now);

  for (const [storedUri, lastSeen] of entries) {
    if (now - lastSeen > APPS_QUERY_URI_TTL_MS) {
      entries.delete(storedUri);
    }
  }

  if (entries.size === 0) {
    appsQueryUrisByDeviceId.delete(deviceId);
  }
}

function getAppsQueryUrisForDevice(deviceId: string, timer: Timer = defaultTimer): string[] {
  const entries = appsQueryUrisByDeviceId.get(deviceId);
  if (!entries) {
    return [];
  }

  const now = timer.now();
  const uris: string[] = [];
  for (const [uri, lastSeen] of entries) {
    if (now - lastSeen > APPS_QUERY_URI_TTL_MS) {
      entries.delete(uri);
      continue;
    }
    uris.push(uri);
  }

  if (entries.size === 0) {
    appsQueryUrisByDeviceId.delete(deviceId);
  }

  return uris;
}

function getDeviceAppsUri(deviceId: string): string {
  return `automobile:devices/${deviceId}/apps`;
}

function createAppsResourceContent(
  device: BootedDevice,
  {
    apps,
    foregroundApp,
    lastUpdated,
    observationComplete,
    message,
  }: Pick<
    AppsResourceContent,
    "apps" | "foregroundApp" | "lastUpdated" | "observationComplete" | "message"
  >,
): AppsResourceContent {
  return {
    deviceId: device.deviceId,
    platform: device.platform,
    observationComplete,
    apps,
    totalCount: apps.length,
    foregroundApp,
    lastUpdated,
    ...(message ? { message } : {}),
  };
}

function getAndroidAppsMessage(deviceId: string): string {
  return `User apps only. Use automobile:apps?deviceId=${deviceId}&type=system to list system apps.`;
}

async function findBootedDevice(deviceId: string): Promise<BootedDevice | null> {
  return findBootedDeviceForResource(deviceId, "AppResources");
}

interface FetchedAppsCacheEntry {
  entry: AppsCacheEntry;
  cacheable: boolean;
}

const defaultListInstalledAppsFactory: NonNullable<
  AppResourceDependencies["listInstalledAppsFactory"]
> = (device) => new ListInstalledApps(device);

export type { AppResourceDependencies };

async function fetchAppsForDevice(
  device: BootedDevice,
  timer: Timer = defaultTimer,
  signal?: AbortSignal,
  deps: AppResourceDependencies = {},
): Promise<FetchedAppsCacheEntry> {
  const listInstalledApps = (deps.listInstalledAppsFactory ?? defaultListInstalledAppsFactory)(
    device,
  );
  const lastUpdated = new Date().toISOString();

  if (device.platform === "android") {
    const result = await listInstalledApps.executeDetailedResult(signal);
    const { userApps, queryApps } = normalizeAndroidApps(result.apps);
    const foregroundApp = queryApps.find((app) => app.foreground)?.packageName ?? null;
    const message = getAndroidAppsMessage(device.deviceId);
    const launchabilityUnknown = isLaunchabilityUnknown(queryApps);

    return {
      cacheable: result.successful,
      entry: {
        expiresAt: timer.now() + APPS_CACHE_TTL_MS,
        content: createAppsResourceContent(device, {
          apps: userApps,
          foregroundApp,
          lastUpdated,
          observationComplete: result.successful,
          message,
        }),
        appsByPackage: buildAppsByPackage(userApps),
        queryApps,
        launchabilityUnknown,
        launchabilityUnknownProfiles: launchabilityUnknownProfiles(queryApps),
      },
    };
  }

  const result = await listInstalledApps.executeIosDetailedResult();
  const { apps, queryApps, iosTypeClassificationUnreliable } = normalizeIosApps(
    result.apps,
    isIosPhysicalUdid(device.deviceId),
  );

  return {
    cacheable: result.successful,
    entry: {
      expiresAt: timer.now() + APPS_CACHE_TTL_MS,
      content: createAppsResourceContent(device, {
        apps,
        foregroundApp: null,
        lastUpdated,
        observationComplete: result.successful,
      }),
      appsByPackage: buildAppsByPackage(apps),
      queryApps,
      iosTypeClassificationUnreliable,
      launchabilityUnknown: isLaunchabilityUnknown(queryApps),
      launchabilityUnknownProfiles: launchabilityUnknownProfiles(queryApps),
    },
  };
}

async function ensureAppsCacheEntry(
  deviceOrId: BootedDevice | string,
  timer: Timer = defaultTimer,
  signal?: AbortSignal,
  deps: AppResourceDependencies = {},
): Promise<AppsCacheEntry | null> {
  const deviceId = typeof deviceOrId === "string" ? deviceOrId : deviceOrId.deviceId;
  const cached = appCacheByDeviceId.get(deviceId);
  if (cached && cached.expiresAt > timer.now()) {
    return cached;
  }

  const coordinator = getInstalledAppsCacheWriteCoordinator();
  // Capture the incarnation before any asynchronous work (including a flight
  // task's scheduling) so retirement cannot promote this request to a reused id.
  const incarnation = coordinator.captureIncarnation(deviceId);
  const generation = coordinator.currentGeneration(deviceId);
  return await appsCacheEntrySingleFlight.run(
    appsCacheEntryFlightKey(deviceId, generation),
    async (flightSignal) => {
      const device =
        typeof deviceOrId === "string" ? await findBootedDevice(deviceOrId) : deviceOrId;
      if (!device) {
        return null;
      }

      flightSignal?.throwIfAborted();
      const cacheGeneration = coordinator.beginRebuild(deviceId, incarnation);
      const result = await fetchAppsForDevice(device, timer, flightSignal, deps);
      if (
        result.cacheable &&
        cacheGeneration === generation &&
        coordinator.currentGeneration(deviceId) === generation &&
        (device.platform !== "android" || !coordinator.isDirty(deviceId))
      ) {
        await coordinator.commitRebuild(deviceId, cacheGeneration, async () => {
          appCacheByDeviceId.set(deviceId, result.entry);
        });
      }
      return result.entry;
    },
    signal,
    { cancelWhenAllWaitersAbort: true },
  );
}

function decodeQueryParam(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseProfileParam(value: string | undefined): number | undefined {
  const decoded = decodeQueryParam(value);
  if (!decoded) {
    return undefined;
  }
  const parsed = Number(decoded);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid profile: ${value}`);
  }
  return parsed;
}

// Exported for tests: pure query-string parsing, no device/cache I/O (#6155).
export function parseAppsQueryParams(params: Record<string, string>): AppsQueryOptions {
  const unknownKeys = Object.keys(params).filter((key) => !APPS_QUERY_PARAM_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown query parameters: ${unknownKeys.join(", ")}`);
  }

  const platformRaw = decodeQueryParam(params.platform);
  const typeRaw = decodeQueryParam(params.type);
  const search = decodeQueryParam(params.search);
  const deviceId = decodeQueryParam(params.deviceId);

  if (!deviceId) {
    throw new Error("deviceId is required");
  }

  let platform: Platform | undefined;
  if (platformRaw) {
    if (platformRaw !== "android" && platformRaw !== "ios") {
      throw new Error(`Invalid platform: ${platformRaw}`);
    }
    platform = platformRaw;
  }

  // Left undefined (not defaulted here) when omitted so callers downstream can
  // tell "no type filter was requested" apart from an explicit "user"/"system"
  // request — needed to reject an explicit filter on a physical iOS device
  // where classification is unavailable (#6216 review, round 5) without also
  // rejecting the default, silently-lenient case. filterAppsByQuery still
  // applies the documented "launchable" default (#6798) when this is undefined.
  let type: AppsQueryType | undefined;
  if (typeRaw) {
    if (!APPS_QUERY_TYPES.has(typeRaw)) {
      throw new Error(`Invalid type: ${typeRaw}`);
    }
    type = typeRaw as AppsQueryType;
  }

  return {
    platform,
    search: search ?? undefined,
    type,
    profile: parseProfileParam(params.profile),
    deviceId,
  };
}

function buildAppsUri(options: AppsQueryOptions): string {
  const query = new URLSearchParams();
  if (options.deviceId) {
    query.set("deviceId", options.deviceId);
  }
  if (options.platform) {
    query.set("platform", options.platform);
  }
  if (options.search) {
    query.set("search", options.search);
  }
  if (options.type) {
    query.set("type", options.type);
  }
  if (options.profile !== undefined) {
    query.set("profile", options.profile.toString());
  }

  const queryString = query.toString();
  return queryString ? `${APPS_RESOURCE_URIS.BASE}?${queryString}` : APPS_RESOURCE_URIS.BASE;
}

async function getAppsQueryDevice(
  options: AppsQueryOptions,
  signal?: AbortSignal,
): Promise<BootedDevice> {
  signal?.throwIfAborted();
  if (!options.deviceId) {
    throw new Error("deviceId is required");
  }

  const platforms: Platform[] = options.platform ? [options.platform] : ["android", "ios"];

  for (const platform of platforms) {
    signal?.throwIfAborted();
    const devices = await listBootedDevicesForResource(platform, "AppResources", { signal });
    const matched = devices.find((device) => device.deviceId === options.deviceId);
    if (matched) {
      return matched;
    }
  }

  throw new Error(`Device not found or not booted: ${options.deviceId}`);
}

/**
 * Resolves the target device and returns the filtered installed-apps content
 * for it, applying the documented `type` default (see filterAppsByQuery):
 * an omitted `type` defaults to "user" everywhere EXCEPT a physical iOS
 * device whose devicectl listing carries no user/system classification
 * signal (`iosTypeClassificationUnreliable`) — there, an omitted `type`
 * returns every app and reports `query.type: "all"` (the "user" default
 * would otherwise silently let system apps through under a "user" label),
 * and an explicit `type=user`/`type=system` is rejected rather than
 * honored against data we cannot actually classify (#6216 review, rounds
 * 5-6). Shared by the `apps` resource and the `listApps` tool (#6155) so
 * both honor the same default and filtering behavior. Throws on failure —
 * callers that need a resource-shaped error payload should catch via
 * getAppsQueryResource.
 */
export async function queryInstalledApps(
  options: AppsQueryOptions,
  signal?: AbortSignal,
  deps: AppResourceDependencies = {},
): Promise<AppsQueryResourceContent> {
  const device = await getAppsQueryDevice(options, signal);
  const cacheEntry = await ensureAppsCacheEntry(device, defaultTimer, signal, deps);
  if (!cacheEntry) {
    throw new Error(`Device not found or not booted: ${device.deviceId}`);
  }
  // `observationComplete` is wired directly to whether the underlying adb /
  // simctl / devicectl listing command itself succeeded (ListInstalledApps'
  // `successful` flag) — false here means the listing FAILED, not "0 apps
  // installed". Reporting that as a normal (possibly empty) app list would be
  // a dishonest success; surface it as a failure instead (#6155).
  if (!cacheEntry.content.observationComplete) {
    throw new Error(
      `Failed to list installed apps for device ${device.deviceId}: the app-listing command did not complete successfully`,
    );
  }
  assertRequestedTypeIsAnswerable(device.deviceId, device.platform, options, cacheEntry);
  const effectiveType = resolveEffectiveAppsQueryType(options.type, cacheEntry, options.profile);
  const effectiveOptions: AppsQueryOptions = { ...options, type: effectiveType };

  const apps = filterAppsByQuery(cacheEntry.queryApps, effectiveOptions);
  const unknownApps = launchabilityUnknownApps(cacheEntry.queryApps, effectiveOptions);
  const deviceEntries: AppsQueryDeviceContent[] = [
    {
      deviceId: device.deviceId,
      platform: device.platform,
      totalCount: apps.length,
      lastUpdated: cacheEntry.content.lastUpdated,
      apps,
    },
  ];

  const parsed = Date.parse(cacheEntry.content.lastUpdated);
  const lastUpdated = Number.isNaN(parsed)
    ? new Date().toISOString()
    : new Date(parsed).toISOString();

  // Only the profiles this query could actually have returned are worth naming,
  // and only when the applied filter depends on launchability.
  const unknownProfiles = (cacheEntry.launchabilityUnknownProfiles ?? []).filter(
    (unknownProfile) => options.profile === undefined || options.profile === unknownProfile,
  );

  return {
    query: effectiveOptions,
    observationComplete: cacheEntry.content.observationComplete,
    totalCount: apps.length,
    installedCount: cacheEntry.queryApps.length,
    deviceCount: 1,
    lastUpdated,
    devices: deviceEntries,
    ...(effectiveType === "launchable" && unknownProfiles.length > 0
      ? { launchabilityUnknownProfiles: unknownProfiles }
      : {}),
    ...(effectiveType === "launchable" && unknownApps.length > 0
      ? { launchabilityUnknownApps: unknownApps }
      : {}),
  };
}

async function getAppsQueryResource(
  options: AppsQueryOptions,
  uri: string,
  deps: AppResourceDependencies = {},
): Promise<ResourceContent> {
  try {
    const content = await queryInstalledApps(options, undefined, deps);

    if (options.deviceId) {
      recordAppsQueryUri(options.deviceId, uri);
    }

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(content, null, 2),
    };
  } catch (error) {
    logger.error(`[AppResources] Failed to read apps resource: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Failed to read apps resource: ${error}`,
        },
        null,
        2,
      ),
    };
  }
}

async function getAppsResource(
  deviceId: string,
  deps: AppResourceDependencies = {},
): Promise<ResourceContent> {
  const cacheEntry = await ensureAppsCacheEntry(deviceId, undefined, undefined, deps);
  if (!cacheEntry) {
    return {
      uri: getDeviceAppsUri(deviceId),
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Device not found or not booted: ${deviceId}`,
        },
        null,
        2,
      ),
    };
  }

  return {
    uri: getDeviceAppsUri(deviceId),
    mimeType: "application/json",
    text: JSON.stringify(cacheEntry.content, null, 2),
  };
}

async function getAppResource(
  deviceId: string,
  packageName: string,
  deps: AppResourceDependencies = {},
): Promise<ResourceContent> {
  const cacheEntry = await ensureAppsCacheEntry(deviceId, undefined, undefined, deps);
  const uri = `${getDeviceAppsUri(deviceId)}/${packageName}`;

  if (!cacheEntry) {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Device not found or not booted: ${deviceId}`,
        },
        null,
        2,
      ),
    };
  }

  const matchingApps = cacheEntry.appsByPackage.get(packageName) ?? [];
  const filteredContent: AppsResourceContent = {
    ...cacheEntry.content,
    apps: matchingApps,
    totalCount: matchingApps.length,
  };

  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(filteredContent, null, 2),
  };
}

function registerDeviceAppResource(device: BootedDevice, deps: AppResourceDependencies = {}): void {
  const uri = getDeviceAppsUri(device.deviceId);

  ResourceRegistry.register(
    uri,
    `Installed Apps (${device.deviceId})`,
    `List of installed user apps for device ${device.deviceId} (${device.platform}). ` +
      `System apps: use automobile:apps?deviceId=${device.deviceId}&type=system.`,
    "application/json",
    () => getAppsResource(device.deviceId, deps),
  );

  registeredDeviceResources.set(device.deviceId, uri);
}

function unregisterDeviceAppResource(deviceId: string): void {
  const generation = getInstalledAppsCacheWriteCoordinator().currentGeneration(deviceId);
  appsCacheEntrySingleFlight.delete(appsCacheEntryFlightKey(deviceId, generation));
  const uri = registeredDeviceResources.get(deviceId);
  if (!uri) {
    return;
  }

  ResourceRegistry.unregister(uri);
  registeredDeviceResources.delete(deviceId);
  appCacheByDeviceId.delete(deviceId);
  appsQueryUrisByDeviceId.delete(deviceId);
  invalidateMetadataCacheForDevice(deviceId);
}

function reconcileInstalledAppResourceDevices(
  devices: BootedDevice[],
  deps: AppResourceDependencies,
): string[] {
  const currentDeviceIds = new Set(devices.map((device) => device.deviceId));
  let changed = false;

  for (const device of devices) {
    if (!registeredDeviceResources.has(device.deviceId)) {
      registerDeviceAppResource(device, deps);
      changed = true;
    }
  }

  const disappearedDeviceIds: string[] = [];
  for (const deviceId of Array.from(registeredDeviceResources.keys())) {
    if (!currentDeviceIds.has(deviceId)) {
      unregisterDeviceAppResource(deviceId);
      disappearedDeviceIds.push(deviceId);
      changed = true;
    }
  }

  if (changed) {
    installedAppResourceRegistryRevision++;
  }

  return disappearedDeviceIds;
}

export async function syncInstalledAppResourceRegistry(
  deps: AppResourceDependencies = {},
): Promise<boolean> {
  const generation = ++installedAppResourceRegistryGeneration;
  let devices: BootedDevice[] = [];
  try {
    devices = await PlatformDeviceManagerFactory.getInstance().getBootedDevices("either");
  } catch (error) {
    logger.warn(`[AppResources] Failed to get booted devices: ${error}`);
    // An unobservable device list says nothing about which devices disappeared: keep the registry
    // and every device's installed-apps cache rather than treating all of them as gone.
    return false;
  }

  if (generation !== installedAppResourceRegistryGeneration) {
    return false;
  }

  const disappearedDeviceIds = reconcileInstalledAppResourceDevices(devices, deps);

  for (const deviceId of disappearedDeviceIds) {
    // All registry mutation above is synchronous, so a newer refresh cannot
    // interleave a partial snapshot while this best-effort cleanup yields.
    try {
      const { InstalledAppsRepository } = await import("../db/installedAppsRepository");
      const repo = new InstalledAppsRepository();
      await getInstalledAppsCacheWriteCoordinator().invalidate(deviceId, () =>
        getDbWriteBarrier()
          .track(() => repo.clearDeviceSession(deviceId))
          .then(() => undefined),
      );
      logger.info(
        `[AppResources] Cleared installed apps cache for disappeared device: ${deviceId}`,
      );
    } catch (error) {
      logger.warn(`[AppResources] Failed to clear cache for device ${deviceId}: ${error}`);
    }
  }

  // A newer refresh may have started while best-effort disappearance cleanup
  // yielded. The newest completing refresh claims every pending registry
  // revision, including one mutated by an older refresh, for one list-change
  // broadcast by its caller.
  if (
    generation !== installedAppResourceRegistryGeneration ||
    installedAppResourceRegistryRevision === installedAppResourceRegistryHandoffRevision
  ) {
    return false;
  }

  installedAppResourceRegistryHandoffRevision = installedAppResourceRegistryRevision;
  return true;
}

export async function notifyInstalledAppResourceListChanged(): Promise<void> {
  await ResourceRegistry.notifyResourceListChanged();
  await ResourceRegistry.notifyResourceUpdated(APPS_RESOURCE_URIS.BASE);
}

export async function syncInstalledAppResources(deps: AppResourceDependencies = {}): Promise<void> {
  if (await syncInstalledAppResourceRegistry(deps)) {
    await notifyInstalledAppResourceListChanged();
  }
}

export async function notifyInstalledAppResourceUpdated(deviceId: string): Promise<void> {
  const queryUris = getAppsQueryUrisForDevice(deviceId);
  await ResourceRegistry.notifyResourcesUpdated([
    getDeviceAppsUri(deviceId),
    APPS_RESOURCE_URIS.BASE,
    ...queryUris,
  ]);
}

function invalidateMetadataCacheForDevice(deviceId: string): void {
  const prefix = `${deviceId}:`;
  for (const key of appMetadataCacheByKey.keys()) {
    if (key.startsWith(prefix)) {
      appMetadataCacheByKey.delete(key);
    }
  }
}

export function invalidateInstalledAppsCache(deviceId?: string): void {
  if (deviceId) {
    invalidateInstalledAppResourceCache(deviceId);
    getInstalledAppsCacheWriteCoordinator().invalidateWithoutWrite(deviceId);
    return;
  }
  const deviceIds = new Set<string>(appCacheByDeviceId.keys());
  for (const entry of appMetadataCacheByKey.values()) {
    deviceIds.add(entry.deviceId);
  }
  invalidateInstalledAppResourceCache();
  for (const cachedDeviceId of deviceIds) {
    getInstalledAppsCacheWriteCoordinator().invalidateWithoutWrite(cachedDeviceId);
  }
}

export function createInstalledAppsDeviceIncarnationListener(
  repository: InstalledAppsStore = new InstalledAppsRepository(),
  coordinator: InstalledAppsCacheWriteCoordinator = getInstalledAppsCacheWriteCoordinator(),
  barrier: DbWriteBarrier = getDbWriteBarrier(),
  invalidateCache: (deviceId: string) => void = invalidateInstalledAppsCache,
  notifyResourcesUpdated: (deviceId: string) => Promise<void> = notifyInstalledAppResourceUpdated,
): DeviceIncarnationListener {
  return {
    name: "installed-apps",
    onDeviceIncarnationChanged: async (deviceId) => {
      // Dirty the in-process cache before the best-effort persistence write.
      invalidateCache(deviceId);
      await coordinator.invalidate(
        deviceId,
        async () =>
          await barrier.track(async () => {
            await repository.markDeviceStale(deviceId);
          }),
      );
    },
    onIncarnationChangeSettled: async (deviceId, outcome) => {
      // "Updated" invites subscribers to re-read; failed loads/readiness only
      // invalidate caches, since the guest cannot yet provide a fresh app list.
      if (outcome.ready) {
        await notifyResourcesUpdated(deviceId);
      }
    },
  };
}

registerDeviceIncarnationListener(createInstalledAppsDeviceIncarnationListener());

export function invalidateInstalledAppResourceCache(deviceId?: string): void {
  if (deviceId) {
    const generation = getInstalledAppsCacheWriteCoordinator().currentGeneration(deviceId);
    appsCacheEntrySingleFlight.delete(appsCacheEntryFlightKey(deviceId, generation));
    appCacheByDeviceId.delete(deviceId);
    invalidateMetadataCacheForDevice(deviceId);
    return;
  }
  appsCacheEntrySingleFlight.clear();
  appCacheByDeviceId.clear();
  appMetadataCacheByKey.clear();
}

// --- App Metadata Resource ---

interface AppMetadataCacheEntry {
  deviceId: string;
  expiresAt: number;
  content: ResourceContent;
}

const APP_METADATA_CACHE_TTL_MS = 60000;
const appMetadataCacheByKey = new Map<string, AppMetadataCacheEntry>();

function metadataCacheKey(deviceId: string, appId: string): string {
  return `${deviceId}:${appId}`;
}

async function getAppMetadataResource(
  deviceId: string,
  appId: string,
  timer: Timer = defaultTimer,
): Promise<ResourceContent> {
  const uri = `automobile:devices/${deviceId}/apps/${appId}/metadata`;

  // Check cache
  const cacheKey = metadataCacheKey(deviceId, appId);
  const cached = appMetadataCacheByKey.get(cacheKey);
  if (cached && cached.expiresAt > timer.now()) {
    return cached.content;
  }

  // Captured before discovery awaits: a request that resumes while shutdown
  // drains this device must not populate the cache after retirement (#6894).
  const incarnation = getInstalledAppsCacheWriteCoordinator().captureIncarnation(deviceId);
  const device = await findBootedDevice(deviceId);
  if (!device) {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Device not found or not booted: ${deviceId}` }, null, 2),
    };
  }

  const cacheGeneration = getInstalledAppsCacheWriteCoordinator().beginRebuild(
    deviceId,
    incarnation,
  );
  try {
    const iosSource = device.platform === "ios" ? createIosMetadataSource(device) : null;
    const getMetadata = new GetAppMetadata(device, undefined, iosSource);
    const metadata = await getMetadata.execute(appId);

    if (!metadata) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: `App not found: ${appId}` }, null, 2),
      };
    }

    const content: ResourceContent = {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(metadata, null, 2),
    };

    if (cacheGeneration !== undefined) {
      await getInstalledAppsCacheWriteCoordinator().commitRebuild(
        deviceId,
        cacheGeneration,
        async () => {
          appMetadataCacheByKey.set(cacheKey, {
            deviceId,
            expiresAt: timer.now() + APP_METADATA_CACHE_TTL_MS,
            content,
          });
        },
      );
    }

    return content;
  } catch (error) {
    logger.error(`[AppResources] Failed to get app metadata for ${appId}: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Failed to get app metadata: ${error}` }, null, 2),
    };
  }
}

export function registerAppResources(deps: AppResourceDependencies = {}): void {
  ResourceRegistry.register(
    APPS_RESOURCE_URIS.BASE,
    "Installed Apps",
    "List installed apps across booted devices, with optional display label and launchability fields when reported by the platform or transport (label is typically omitted on Android without CtrlProxy label support; launchable is typically omitted for physical iOS/devicectl records), with optional query filters: type (launchable|user|system|all, default launchable), search, profile (deviceId required).",
    "application/json",
    () => getAppsQueryResource({}, APPS_RESOURCE_URIS.BASE, deps),
  );

  ResourceRegistry.registerTemplate(
    APPS_QUERY_TEMPLATE,
    "Installed Apps",
    "List installed apps across booted devices, with optional display label and launchability fields when reported by the platform or transport (label is typically omitted on Android without CtrlProxy label support; launchable is typically omitted for physical iOS/devicectl records), with optional query filters: type (launchable|user|system|all, default launchable), search, profile.",
    "application/json",
    async (params) => {
      try {
        const options = parseAppsQueryParams(params);
        const uri = getRequestedResourceUri(params) || buildAppsUri(options);
        return getAppsQueryResource(options, uri, deps);
      } catch (error) {
        logger.error(`[AppResources] Failed to parse apps query params: ${error}`);
        return {
          uri: APPS_RESOURCE_URIS.BASE,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              error: `Invalid apps query parameters: ${error}`,
            },
            null,
            2,
          ),
        };
      }
    },
  );

  ResourceRegistry.registerTemplate(
    APP_RESOURCE_TEMPLATES.DEVICE_APPS,
    "Installed Apps",
    "List of installed user apps for a specific device. " +
      "System apps: use automobile:apps?deviceId=DEVICE_ID&type=system.",
    "application/json",
    async (params) => getAppsResource(params.deviceId, deps),
  );

  ResourceRegistry.registerTemplate(
    APP_RESOURCE_TEMPLATES.DEVICE_APP,
    "Installed App Details",
    "Details for a specific user app installed on a specific device. " +
      "System apps: use automobile:apps?deviceId=DEVICE_ID&type=system&search=PACKAGE_NAME.",
    "application/json",
    async (params) => getAppResource(params.deviceId, params.packageName, deps),
  );

  ResourceRegistry.registerTemplate(
    APP_RESOURCE_TEMPLATES.DEVICE_APP_METADATA,
    "App Metadata",
    "Version, build number, install path, and timestamps for an installed app. " +
      "Returns normalized metadata for both Android (package name) and iOS (bundle ID).",
    "application/json",
    async (params) => getAppMetadataResource(params.deviceId, params.appId),
  );

  void syncInstalledAppResources(deps);

  logger.info("[AppResources] Registered app resources");
}
