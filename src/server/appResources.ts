import { ResourceRegistry, ResourceContent, getRequestedResourceUri } from "./resourceRegistry";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { ListInstalledApps } from "../features/observe/ListInstalledApps";
import { GetAppMetadata, IosAppMetadataSource } from "../features/observe/GetAppMetadata";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../utils/ios-cmdline-tools/DeviceAppManager";
import {
  BootedDevice,
  InstalledApp,
  InstalledAppsByProfile,
  Platform,
  SystemInstalledApp,
} from "../models";
import { logger } from "../utils/logger";
import { getInstalledAppsCacheWriteCoordinator } from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../db/dbWriteBarrier";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { isIosPhysicalUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import {
  getIosInstalledAppBundleId,
  getIosInstalledAppPath,
} from "../utils/ios-cmdline-tools/iosInstalledApp";
import {
  findBootedDeviceForResource,
  listBootedDevicesForResource,
} from "./resourceDeviceResolver";

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
type InstalledAppType = "user" | "system";
/**
 * `launchable` is a cross-cutting filter, not a fourth classification: an app
 * keeps its "user"/"system" type and is additionally selected by whether it has
 * a launcher entry point. It is the default because the previous "user" default
 * hid every system app a human names in a task — Contacts, Clock, Settings —
 * while still returning providers and RRO overlays under type=all (#6798).
 */
export type AppsQueryType = InstalledAppType | "all" | "launchable";
/** Single source of truth for the accepted `type` values (tool schema + resource query string). */
export const APPS_QUERY_TYPES: ReadonlySet<string> = new Set<AppsQueryType>([
  "user",
  "system",
  "all",
  "launchable",
]);

export interface AppsQueryOptions {
  platform?: Platform;
  search?: string;
  type?: AppsQueryType;
  profile?: number;
  deviceId?: string;
}

export interface AppsQueryAppInfo {
  packageName: string;
  type: InstalledAppType;
  foreground: boolean;
  recent: boolean;
  userId?: number;
  userProfile?: "personal" | "work" | "secondary" | "unknown";
  userIds?: number[];
  /**
   * Launcher label as a human sees it ("Contacts"). Absent when no source
   * reported one — on Android that means CtrlProxy was unavailable, since adb
   * cannot resolve a package's label resource (#6798).
   */
  label?: string;
  /**
   * iOS-only legacy alias for client compatibility; `label` is canonical
   * going forward (#6798).
   */
  displayName?: string;
  /**
   * Whether the app has a launchable entry point. For a deduplicated Android
   * system app this summarizes "launches for at least one of `userIds`".
   * `undefined` means "not reported", never "no" (#6798).
   */
  launchable?: boolean;
  /**
   * Launchability per Android user id, where it was reported. A launcher
   * activity can be disabled for the owner and enabled in a work profile, so a
   * profile-scoped query reads this rather than the scalar (#6798 review).
   */
  launchableByUserId?: Record<number, boolean>;
}

interface AppsQueryDeviceContent {
  deviceId: string;
  platform: Platform;
  totalCount: number;
  lastUpdated: string;
  apps: AppsQueryAppInfo[];
}

export interface AppsQueryResourceContent {
  query: AppsQueryOptions;
  observationComplete: boolean;
  totalCount: number;
  /**
   * Apps installed on the device before any filter was applied. Lets a caller
   * see that a small result is a filter effect rather than a short device
   * inventory, so the default no longer hides apps silently (#6798).
   */
  installedCount: number;
  deviceCount: number;
  lastUpdated: string;
  devices: AppsQueryDeviceContent[];
  /**
   * Android user ids whose apps carried no launchability signal at all (their
   * launcher probe failed while another profile's succeeded). Present only when
   * non-empty: the `launchable` filter cannot judge those profiles, so naming
   * them keeps a device-wide query from dropping them silently (#6798 review).
   */
  launchabilityUnknownProfiles?: number[];
  /**
   * Apps matching this query's profile and search filters whose launchability
   * was not reported. Present only when non-empty: the `launchable` filter
   * excludes them until they are proven launchable rather than silently
   * presenting missing metadata as a negative answer (#6798 review).
   */
  launchabilityUnknownApps?: string[];
}

// Resource content schema
interface AppsResourceContent {
  deviceId: string;
  platform: Platform;
  observationComplete: boolean;
  apps: InstalledAppInfo[];
  totalCount: number;
  foregroundApp: string | null;
  lastUpdated: string; // ISO 8601
  message?: string;
}

interface AndroidInstalledAppInfo {
  packageName: string;
  userId: number;
  userProfile: "personal" | "work" | "secondary" | "unknown";
  foreground: boolean;
  recent: boolean;
  label?: string;
  launchable?: boolean;
}

export interface IosInstalledAppInfo {
  bundleId: string;
  type: InstalledAppType;
  displayName?: string;
  version?: string;
  path?: string;
  launchable?: boolean;
}

type InstalledAppInfo = AndroidInstalledAppInfo | IosInstalledAppInfo;

interface AppsCacheEntry {
  expiresAt: number;
  content: AppsResourceContent;
  appsByPackage: Map<string, InstalledAppInfo[]>;
  queryApps: AppsQueryAppInfo[];
  /**
   * True when at least one iOS app on this (physical) device could not be
   * reliably classified user/system (#6216 review, round 5). Gates whether an
   * explicit type=system/type=user filter is honored or rejected — see
   * queryInstalledApps. Always false/undefined for Android and the simulator.
   */
  iosTypeClassificationUnreliable?: boolean;
  /**
   * True when this device reported apps but none of them carried a
   * launchability signal, so the `launchable` filter (the documented default)
   * cannot be applied honestly and degrades to "user" (#6798).
   */
  launchabilityUnknown?: boolean;
  /**
   * The subset of profiles for which that is true. A launcher probe is issued
   * per Android user, so one can fail while another succeeds; a device-wide
   * boolean would then report the failed profile's apps as "not launchable"
   * (#6798 review).
   */
  launchabilityUnknownProfiles?: number[];
}

const APPS_CACHE_TTL_MS = 60000;
const APPS_QUERY_URI_TTL_MS = 300000;
const appCacheByDeviceId = new Map<string, AppsCacheEntry>();
const registeredDeviceResources = new Map<string, string>();
const appsQueryUrisByDeviceId = new Map<string, Map<string, number>>();

function userProfileForUserId(
  userId: number,
  profileType?: InstalledApp["profileType"],
): "personal" | "work" | "secondary" | "unknown" {
  if (profileType === "managed") {
    return "work";
  }
  if (profileType === "secondary") {
    return "secondary";
  }
  if (profileType === "primary" || userId === 0) {
    return "personal";
  }
  return "unknown";
}

function toInstalledAppInfo(app: InstalledApp): InstalledAppInfo {
  return {
    packageName: app.packageName,
    userId: app.userId,
    userProfile: userProfileForUserId(app.userId, app.profileType),
    foreground: app.foreground,
    recent: app.recent,
    ...(app.label ? { label: app.label } : {}),
    ...(app.launchable === undefined ? {} : { launchable: app.launchable }),
  };
}

function toQueryAndroidApp(app: AndroidInstalledAppInfo): AppsQueryAppInfo {
  return {
    packageName: app.packageName,
    type: "user",
    userId: app.userId,
    userProfile: app.userProfile,
    foreground: app.foreground,
    recent: app.recent,
    ...(app.label ? { label: app.label } : {}),
    ...(app.launchable === undefined ? {} : { launchable: app.launchable }),
  };
}

function toQuerySystemApp(app: SystemInstalledApp): AppsQueryAppInfo {
  return {
    packageName: app.packageName,
    type: "system",
    userIds: app.userIds,
    foreground: app.foreground,
    recent: app.recent,
    ...(app.label ? { label: app.label } : {}),
    ...(app.launchable === undefined ? {} : { launchable: app.launchable }),
    ...(app.launchableByUserId === undefined ? {} : { launchableByUserId: app.launchableByUserId }),
  };
}

function normalizeAndroidApps(installedApps: InstalledAppsByProfile): {
  userApps: AndroidInstalledAppInfo[];
  queryApps: AppsQueryAppInfo[];
} {
  const userApps: AndroidInstalledAppInfo[] = [];
  const queryApps: AppsQueryAppInfo[] = [];

  for (const profileApps of Object.values(installedApps.profiles)) {
    for (const app of profileApps) {
      const info = toInstalledAppInfo(app) as AndroidInstalledAppInfo;
      userApps.push(info);
      queryApps.push(toQueryAndroidApp(info));
    }
  }

  for (const systemApp of installedApps.system) {
    queryApps.push(toQuerySystemApp(systemApp));
  }

  return { userApps, queryApps };
}

function readIosStringField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readIosAppField(app: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readIosStringField(app[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function extractIosDisplayName(app: Record<string, unknown>): string | undefined {
  return readIosAppField(app, [
    "bundleDisplayName",
    "bundleName",
    "CFBundleDisplayName",
    "CFBundleName",
    "displayName",
    "name",
  ]);
}

function extractIosVersion(app: Record<string, unknown>): string | undefined {
  return readIosAppField(app, [
    "bundleShortVersionString",
    "bundleVersion",
    "CFBundleShortVersionString",
    "CFBundleVersion",
    "BundleShortVersionString",
    "BundleVersion",
    "version",
  ]);
}

function extractIosPath(app: Record<string, unknown>): string | undefined {
  // Shared with the devicectl listing so a physical device's `file://` bundle
  // URL reaches this resource as a filesystem path, same as a simulator's.
  return getIosInstalledAppPath(app);
}

/**
 * Classifies an iOS app as "user" or "system" so `type=user` (the documented
 * default, #6155) actually excludes preinstalled apps on iOS the same way it
 * excludes them on Android.
 *
 * `simctl listapps` reports an explicit `ApplicationType` ("System"/"Hidden"
 * vs "User") — when present it always wins. When it's absent:
 *  - On the simulator, an unexpected/incomplete record still falls back to
 *    Apple's `com.apple.` bundle-id namespace, which only first-party system
 *    apps use there.
 *  - On a PHYSICAL device, `devicectl device info apps --json-output` exposes
 *    no equivalent field at all (only bundleIdentifier/name/version/
 *    bundleVersion/url/appClip, per Apple's devicectl output), so the
 *    `com.apple.` heuristic would misclassify a user's own Apple-published
 *    apps (Pages, Numbers, Keynote, TestFlight, ...) as hidden system apps and
 *    silently drop them from `type=user`. Without a reliable signal there,
 *    default to "user" rather than guessing "system" (#6216 review).
 */
const IOS_APPLICATION_TYPE_KEYS = ["ApplicationType", "applicationType", "type", "Type"];

function readIosRawApplicationType(app: Record<string, unknown>): string | undefined {
  return readIosAppField(app, IOS_APPLICATION_TYPE_KEYS);
}

// Exported for tests: pure classification, no device/cache I/O (#6155).
export function extractIosApplicationType(
  app: Record<string, unknown>,
  bundleId: string,
  isPhysicalDevice: boolean,
): InstalledAppType {
  const raw = readIosRawApplicationType(app);
  if (raw) {
    const normalized = raw.toLowerCase();
    if (normalized === "system" || normalized === "hidden") {
      return "system";
    }
    if (normalized === "user") {
      return "user";
    }
  }
  if (isPhysicalDevice) {
    return "user";
  }
  return bundleId.startsWith("com.apple.") ? "system" : "user";
}

/**
 * True when `extractIosApplicationType` had no reliable signal and had to
 * default a physical-device app to "user" — i.e. devicectl reported no
 * `ApplicationType`-equivalent field. An explicit `type=system`/`type=user`
 * filter must not be silently applied against such apps: it would report an
 * empty or over-inclusive result that looks like "no system apps exist"
 * rather than "we can't tell" (#6216 review, round 5). Always false on the
 * simulator and for apps that do carry a real classification.
 */
// Exported for tests: pure check, no device/cache I/O (#6216 review, round 5).
export function isIosApplicationTypeUnclassified(
  app: Record<string, unknown>,
  isPhysicalDevice: boolean,
): boolean {
  return isPhysicalDevice && !readIosRawApplicationType(app);
}

/**
 * iOS launchability from simctl's `ApplicationType` (#6798). "Hidden" is
 * Apple's marker for a bundle with no home-screen entry point (SpringBoard's
 * own internal apps, app extensions); "User" and "System" both launch. A
 * physical device has no equivalent field, so launchability stays undefined
 * there rather than being guessed.
 */
// Exported for tests: pure classification, no device/cache I/O (#6798).
export function extractIosLaunchable(app: Record<string, unknown>): boolean | undefined {
  const raw = readIosRawApplicationType(app)?.toLowerCase();
  if (raw === "hidden") {
    return false;
  }
  if (raw === "user" || raw === "system") {
    return true;
  }
  return undefined;
}

// Exported for tests: pure conversion, no device/cache I/O (#6216 review).
export function toQueryIosApp(app: IosInstalledAppInfo): AppsQueryAppInfo {
  return {
    packageName: app.bundleId,
    type: app.type,
    userId: 0,
    // iOS has no Android-style multi-user profiles — every app belongs to the
    // single (profile 0) user. filterAppsByQuery's profile check only reads
    // `userIds` for non-"user" apps; without this, any profile filter (e.g.
    // the common profile:0 case) would silently drop every iOS system app
    // because `userIds` was left undefined (#6216 review).
    userIds: [0],
    userProfile: "personal",
    foreground: false,
    recent: false,
    ...(app.displayName ? { displayName: app.displayName, label: app.displayName } : {}),
    ...(app.launchable === undefined ? {} : { launchable: app.launchable }),
  };
}

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

function getInstalledAppIdentifier(app: InstalledAppInfo): string {
  return "bundleId" in app ? app.bundleId : app.packageName;
}

function buildAppsByPackage(apps: InstalledAppInfo[]): Map<string, InstalledAppInfo[]> {
  const appsByPackage = new Map<string, InstalledAppInfo[]>();
  for (const app of apps) {
    const identifier = getInstalledAppIdentifier(app);
    const existing = appsByPackage.get(identifier);
    if (existing) {
      existing.push(app);
    } else {
      appsByPackage.set(identifier, [app]);
    }
  }
  return appsByPackage;
}

function getDeviceAppsUri(deviceId: string): string {
  return `automobile:devices/${deviceId}/apps`;
}

function createAppsResourceContent(
  device: BootedDevice,
  apps: InstalledAppInfo[],
  foregroundApp: string | null,
  lastUpdated: string,
  observationComplete: boolean,
  message?: string,
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

/** Narrow surface `fetchAppsForDevice` needs from `ListInstalledApps`, so tests can
 * inject a fake without driving the real adb/simctl/devicectl command chain. */
type InstalledAppsLister = Pick<
  ListInstalledApps,
  "executeDetailedResult" | "executeIosDetailedResult"
>;
type ListInstalledAppsFactory = (device: BootedDevice) => InstalledAppsLister;

const defaultListInstalledAppsFactory: ListInstalledAppsFactory = (device) =>
  new ListInstalledApps(device);

let listInstalledAppsFactory: ListInstalledAppsFactory = defaultListInstalledAppsFactory;

/** Test-only seam: inject a fake app lister so a failed listing command can be
 * simulated without real adb/simctl/devicectl I/O (#6155). Pass null to restore
 * the default. */
export function setListInstalledAppsFactoryForTests(
  factory: ListInstalledAppsFactory | null,
): void {
  listInstalledAppsFactory = factory ?? defaultListInstalledAppsFactory;
}

async function fetchAppsForDevice(
  device: BootedDevice,
  timer: Timer = defaultTimer,
): Promise<FetchedAppsCacheEntry> {
  const listInstalledApps = listInstalledAppsFactory(device);
  const lastUpdated = new Date().toISOString();

  if (device.platform === "android") {
    const result = await listInstalledApps.executeDetailedResult();
    const { userApps, queryApps } = normalizeAndroidApps(result.apps);
    const foregroundApp = queryApps.find((app) => app.foreground)?.packageName ?? null;
    const message = getAndroidAppsMessage(device.deviceId);
    const launchabilityUnknown = isLaunchabilityUnknown(queryApps);
    const unknownProfiles = launchabilityUnknownProfiles(queryApps);

    return {
      cacheable: result.successful,
      entry: {
        expiresAt: timer.now() + APPS_CACHE_TTL_MS,
        content: createAppsResourceContent(
          device,
          userApps,
          foregroundApp,
          lastUpdated,
          result.successful,
          message,
        ),
        appsByPackage: buildAppsByPackage(userApps),
        queryApps,
        launchabilityUnknown,
        launchabilityUnknownProfiles: unknownProfiles,
      },
    };
  }

  const result = await listInstalledApps.executeIosDetailedResult();
  const apps: IosInstalledAppInfo[] = [];
  const queryApps: AppsQueryAppInfo[] = [];
  const isPhysicalDevice = isIosPhysicalUdid(device.deviceId);
  let iosTypeClassificationUnreliable = false;

  for (const app of result.apps) {
    const bundleId = getIosInstalledAppBundleId(app);
    if (!bundleId) {
      continue;
    }
    const rawApp = app as Record<string, unknown>;
    const displayName = extractIosDisplayName(rawApp);
    const version = extractIosVersion(rawApp);
    const path = extractIosPath(rawApp);
    const type = extractIosApplicationType(rawApp, bundleId, isPhysicalDevice);
    if (isIosApplicationTypeUnclassified(rawApp, isPhysicalDevice)) {
      iosTypeClassificationUnreliable = true;
    }
    const launchable = extractIosLaunchable(rawApp);
    const info: IosInstalledAppInfo = {
      bundleId,
      type,
      displayName,
      ...(version ? { version } : {}),
      ...(path ? { path } : {}),
      ...(launchable === undefined ? {} : { launchable }),
    };
    apps.push(info);
    queryApps.push({
      ...toQueryIosApp(info),
    });
  }

  return {
    cacheable: result.successful,
    entry: {
      expiresAt: timer.now() + APPS_CACHE_TTL_MS,
      content: createAppsResourceContent(device, apps, null, lastUpdated, result.successful),
      appsByPackage: buildAppsByPackage(apps),
      queryApps,
      iosTypeClassificationUnreliable,
      launchabilityUnknown: isLaunchabilityUnknown(queryApps),
      launchabilityUnknownProfiles: launchabilityUnknownProfiles(queryApps),
    },
  };
}

/**
 * True when the device reported apps but not one of them carried a
 * launchability signal — an old on-device CtrlProxy plus a failed `cmd package`
 * probe, or a physical iOS device. The `launchable` filter must degrade rather
 * than report every app as unlaunchable (#6798). A device with zero apps is not
 * "unknown": there is nothing to misreport.
 */
function isLaunchabilityUnknown(queryApps: AppsQueryAppInfo[]): boolean {
  return queryApps.length > 0 && queryApps.every((app) => app.launchable === undefined);
}

/** The profiles an app belongs to: its own user for a user app, every user it is installed for otherwise. */
function profilesForQueryApp(app: AppsQueryAppInfo): number[] {
  if (app.type === "user") {
    return app.userId === undefined ? [] : [app.userId];
  }
  return app.userIds ?? [];
}

/**
 * Profiles that reported apps but no launchability for any of them. The launcher
 * probe runs once per Android user, so a work profile's probe can fail while the
 * owner's succeeds — and the device-wide `every` check would then call
 * launchability "known" and quietly report every work-profile app as
 * unlaunchable (#6798 review).
 */
function launchabilityUnknownProfiles(queryApps: AppsQueryAppInfo[]): number[] {
  const known = new Set<number>();
  const seen = new Set<number>();
  for (const app of queryApps) {
    for (const profile of profilesForQueryApp(app)) {
      seen.add(profile);
      if (launchabilityForProfile(app, profile) !== undefined) {
        known.add(profile);
      }
    }
  }
  return Array.from(seen)
    .filter((profile) => !known.has(profile))
    .sort((a, b) => a - b);
}

async function ensureAppsCacheEntry(
  deviceId: string,
  timer: Timer = defaultTimer,
): Promise<AppsCacheEntry | null> {
  const cached = appCacheByDeviceId.get(deviceId);
  if (cached && cached.expiresAt > timer.now()) {
    return cached;
  }

  const device = await findBootedDevice(deviceId);
  if (!device) {
    return null;
  }

  const cacheGeneration = getInstalledAppsCacheWriteCoordinator().beginRebuild(deviceId);
  const result = await fetchAppsForDevice(device, timer);
  if (
    result.cacheable &&
    (device.platform !== "android" || !getInstalledAppsCacheWriteCoordinator().isDirty(deviceId))
  ) {
    await getInstalledAppsCacheWriteCoordinator().commitRebuild(
      deviceId,
      cacheGeneration,
      async () => {
        appCacheByDeviceId.set(deviceId, result.entry);
      },
    );
  }
  return result.entry;
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

// Exported for tests: pure filtering, no device/cache I/O (#6155).
export function filterAppsByQuery(
  apps: AppsQueryAppInfo[],
  options: AppsQueryOptions,
): AppsQueryAppInfo[] {
  // Trim + lowercase so callers get case-insensitive, whitespace-tolerant
  // search (" Camera " matches "Camera") whether search arrives from the
  // listApps tool schema (unnormalized) or the apps resource's query string
  // (#6216 review).
  const searchTerm = options.search?.trim().toLowerCase() || undefined;
  // Documented default is "launchable" (#6798, superseding the "user" default of
  // #6155) — an omitted type must not fall through to "no filter" and return
  // providers and overlays too.
  const effectiveType = options.type ?? "launchable";

  return apps.filter(
    (app) =>
      matchesAppsQueryType(app, effectiveType, options.profile) &&
      matchesAppsQueryProfile(app, options.profile) &&
      matchesAppsQuerySearch(app, searchTerm),
  );
}

/**
 * Launchability as it applies to one profile, or to the app as a whole when no
 * profile was requested. A deduplicated system app can launch in a work profile
 * and not for the owner, so a profile-scoped query must read that profile's
 * value rather than the "launches somewhere" scalar (#6798 review).
 */
export function launchabilityForProfile(
  app: AppsQueryAppInfo,
  profile: number | undefined,
): boolean | undefined {
  if (profile === undefined || app.launchableByUserId === undefined) {
    return app.launchable;
  }
  return app.launchableByUserId[profile];
}

// Exported for tests: keeps the existing profile and search predicates authoritative.
export function launchabilityUnknownApps(
  queryApps: AppsQueryAppInfo[],
  options: AppsQueryOptions,
): string[] {
  return filterAppsByQuery(queryApps, { ...options, type: "all" })
    .filter((app) => launchabilityForProfile(app, options.profile) === undefined)
    .map((app) => app.packageName);
}

function matchesAppsQueryType(
  app: AppsQueryAppInfo,
  effectiveType: AppsQueryType,
  profile: number | undefined,
): boolean {
  if (effectiveType === "launchable") {
    // Strictly `=== true`: an app whose launchability was never reported is not
    // evidence that it launches.
    return launchabilityForProfile(app, profile) === true;
  }
  return effectiveType === "all" || app.type === effectiveType;
}

function matchesAppsQueryProfile(app: AppsQueryAppInfo, profile: number | undefined): boolean {
  if (profile === undefined) {
    return true;
  }
  return app.type === "user" ? app.userId === profile : (app.userIds?.includes(profile) ?? false);
}

function matchesAppsQuerySearch(app: AppsQueryAppInfo, searchTerm: string | undefined): boolean {
  if (!searchTerm) {
    return true;
  }
  return (
    app.packageName.toLowerCase().includes(searchTerm) ||
    (app.label?.toLowerCase().includes(searchTerm) ?? false)
  );
}

async function getAppsQueryDevice(options: AppsQueryOptions): Promise<BootedDevice> {
  if (!options.deviceId) {
    throw new Error("deviceId is required");
  }

  const platforms: Platform[] = options.platform ? [options.platform] : ["android", "ios"];

  for (const platform of platforms) {
    const devices = await listBootedDevicesForResource(platform, "AppResources");
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
): Promise<AppsQueryResourceContent> {
  const device = await getAppsQueryDevice(options);
  const cacheEntry = await ensureAppsCacheEntry(device.deviceId);
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
  assertRequestedTypeIsAnswerable(device.deviceId, options, cacheEntry);
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

/**
 * Rejects an explicit `type` the cached listing cannot answer honestly.
 *
 * An EXPLICIT type=system/type=user filter on a physical iOS device with no
 * reliable classification signal must not silently return an empty (or
 * over-inclusive) result — that reads as "no system apps exist" rather than
 * "we can't tell". type=all is unaffected (#6216 review, round 5).
 *
 * An OMITTED type on such a device is the more common case, and must not be
  // silently defaulted to "user" either: `--include-all-apps` is passed
  // unconditionally when listing a physical device (DeviceAppManager), so the
  // cached apps already include system records, and every unclassified one
  // was defaulted to "user" (extractIosApplicationType). Applying the normal
  // "user" default filter here would therefore let system apps straight
  // through while the response still claimed `query.type: "user"` — exactly
  // the over-inclusive-but-mislabeled result Codex flagged (#6216 review,
  // round 6). Report the effective type as "all" (the truthful description
  // of what this transport can actually filter) and skip the "user" default
 * filter, rather than rejecting the common omitted-type call outright.
 *
 * An explicit type=launchable against a device that reported no launchability
 * signal at all would return an empty list that reads as "nothing on this
 * device can be launched". Reject it the same way an unclassifiable
 * type=user/type=system is rejected (#6798). The same reasoning applies per
 * profile: the launcher probe runs once per Android user, so an explicit
 * type=launchable scoped to a profile whose probe failed must be rejected
 * rather than answered with an authoritative-looking empty list (#6798 review).
 */
function assertRequestedTypeIsAnswerable(
  deviceId: string,
  options: AppsQueryOptions,
  cacheEntry: AppsCacheEntry,
): void {
  if (
    options.type !== undefined &&
    options.type !== "all" &&
    cacheEntry.iosTypeClassificationUnreliable
  ) {
    throw new Error(
      `Cannot filter by type=${options.type} for device ${deviceId}: iOS user/system ` +
        "app classification is not available on this transport (physical device via devicectl). " +
        "Use type=all (or omit type) to list every app.",
    );
  }
  if (
    options.type === "launchable" &&
    isLaunchabilityUnknownForQuery(cacheEntry, options.profile)
  ) {
    throw new Error(
      `Cannot filter by type=launchable for device ${deviceId}${
        options.profile === undefined ? "" : ` profile ${options.profile}`
      }: no launchability signal is available (the installed CtrlProxy APK predates the field ` +
        "and the `cmd package query-activities` probe did not answer). Use type=user, type=system " +
        "or type=all.",
    );
  }
}

/**
 * The type actually applied, reported back to the caller as `query.type` so a
 * response never claims a filter it did not apply. Precedence:
 *  1. A physical iOS device with no user/system signal reports "all" for an
 *     omitted type (#6216 review, round 6) — it cannot honor any narrower one.
 *  2. An omitted type is "launchable" (#6798), degrading to "user" when no app
 *     reported launchability, which is the pre-#6798 behavior.
 *  3. Anything explicit is honored verbatim.
 */
function resolveEffectiveAppsQueryType(
  requested: AppsQueryType | undefined,
  cacheEntry: AppsCacheEntry,
  profile: number | undefined,
): AppsQueryType {
  if (requested !== undefined) {
    return requested;
  }
  if (cacheEntry.iosTypeClassificationUnreliable) {
    return "all";
  }
  return isLaunchabilityUnknownForQuery(cacheEntry, profile) ? "user" : "launchable";
}

/**
 * Whether the `launchable` filter can be applied honestly to what this query
 * asks for: the whole device when no profile was named, otherwise just that
 * profile (#6798 review).
 */
function isLaunchabilityUnknownForQuery(
  cacheEntry: AppsCacheEntry,
  profile: number | undefined,
): boolean {
  if (profile === undefined) {
    return cacheEntry.launchabilityUnknown === true;
  }
  return cacheEntry.launchabilityUnknownProfiles?.includes(profile) === true;
}

async function getAppsQueryResource(
  options: AppsQueryOptions,
  uri: string,
): Promise<ResourceContent> {
  try {
    const content = await queryInstalledApps(options);

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

async function getAppsResource(deviceId: string): Promise<ResourceContent> {
  const cacheEntry = await ensureAppsCacheEntry(deviceId);
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

async function getAppResource(deviceId: string, packageName: string): Promise<ResourceContent> {
  const cacheEntry = await ensureAppsCacheEntry(deviceId);
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

function registerDeviceAppResource(device: BootedDevice): void {
  const uri = getDeviceAppsUri(device.deviceId);

  ResourceRegistry.register(
    uri,
    `Installed Apps (${device.deviceId})`,
    `List of installed user apps for device ${device.deviceId} (${device.platform}). ` +
      `System apps: use automobile:apps?deviceId=${device.deviceId}&type=system.`,
    "application/json",
    () => getAppsResource(device.deviceId),
  );

  registeredDeviceResources.set(device.deviceId, uri);
}

function unregisterDeviceAppResource(deviceId: string): void {
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

export async function syncInstalledAppResources(): Promise<void> {
  let devices: BootedDevice[] = [];
  try {
    devices = await PlatformDeviceManagerFactory.getInstance().getBootedDevices("either");
  } catch (error) {
    logger.warn(`[AppResources] Failed to get booted devices: ${error}`);
  }

  const currentDeviceIds = new Set(devices.map((device) => device.deviceId));
  let changed = false;

  for (const device of devices) {
    if (!registeredDeviceResources.has(device.deviceId)) {
      registerDeviceAppResource(device);
      changed = true;
    }
  }

  for (const deviceId of Array.from(registeredDeviceResources.keys())) {
    if (!currentDeviceIds.has(deviceId)) {
      unregisterDeviceAppResource(deviceId);
      // Clear installed apps cache when device disappears
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
      changed = true;
    }
  }

  if (changed) {
    await ResourceRegistry.notifyResourceListChanged();
    await ResourceRegistry.notifyResourceUpdated(APPS_RESOURCE_URIS.BASE);
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

export function invalidateInstalledAppResourceCache(deviceId?: string): void {
  if (deviceId) {
    appCacheByDeviceId.delete(deviceId);
    invalidateMetadataCacheForDevice(deviceId);
    return;
  }
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

function createIosMetadataSource(device: BootedDevice): IosAppMetadataSource {
  const simctl = new SimCtlClient(device);
  // Physical-device app metadata resolves through DeviceAppManager, the single
  // typed devicectl boundary (issue #4053) — no direct xcrun composition here.
  const deviceAppManager = new DeviceAppManager();
  return {
    listApps: (deviceId?: string) => simctl.listApps(deviceId),
    getPhysicalDeviceAppInfo: (deviceId: string, bundleId: string) =>
      deviceAppManager.getInstalledAppInfo(deviceId, bundleId),
  };
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

  const device = await findBootedDevice(deviceId);
  if (!device) {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Device not found or not booted: ${deviceId}` }, null, 2),
    };
  }

  const cacheGeneration = getInstalledAppsCacheWriteCoordinator().beginRebuild(deviceId);
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

export function registerAppResources(): void {
  ResourceRegistry.register(
    APPS_RESOURCE_URIS.BASE,
    "Installed Apps",
    "List installed apps (with display label and launchability) across booted devices with optional query filters: type (launchable|user|system|all, default launchable), search, profile (deviceId required).",
    "application/json",
    () => getAppsQueryResource({}, APPS_RESOURCE_URIS.BASE),
  );

  ResourceRegistry.registerTemplate(
    APPS_QUERY_TEMPLATE,
    "Installed Apps",
    "List installed apps (with display label and launchability) across booted devices with optional query filters: type (launchable|user|system|all, default launchable), search, profile.",
    "application/json",
    async (params) => {
      try {
        const options = parseAppsQueryParams(params);
        const uri = getRequestedResourceUri(params) || buildAppsUri(options);
        return getAppsQueryResource(options, uri);
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
    async (params) => getAppsResource(params.deviceId),
  );

  ResourceRegistry.registerTemplate(
    APP_RESOURCE_TEMPLATES.DEVICE_APP,
    "Installed App Details",
    "Details for a specific user app installed on a specific device. " +
      "System apps: use automobile:apps?deviceId=DEVICE_ID&type=system&search=PACKAGE_NAME.",
    "application/json",
    async (params) => getAppResource(params.deviceId, params.packageName),
  );

  ResourceRegistry.registerTemplate(
    APP_RESOURCE_TEMPLATES.DEVICE_APP_METADATA,
    "App Metadata",
    "Version, build number, install path, and timestamps for an installed app. " +
      "Returns normalized metadata for both Android (package name) and iOS (bundle ID).",
    "application/json",
    async (params) => getAppMetadataResource(params.deviceId, params.appId),
  );

  void syncInstalledAppResources();

  logger.info("[AppResources] Registered app resources");
}
