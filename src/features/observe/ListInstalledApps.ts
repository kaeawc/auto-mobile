import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  ActionableError,
  AndroidUser,
  BootedDevice,
  classifyAndroidUser,
  InstalledAppsByProfile,
  SystemInstalledApp,
} from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { InstalledAppsRepository, InstalledAppsStore } from "../../db/installedAppsRepository";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import type { InstalledApp as DbInstalledApp, NewInstalledApp } from "../../db/types";
import { AndroidCtrlProxyClient } from "./android";
import type { A11yInstalledPackagesResult, InstalledPackageRecord } from "./android/types";
import { getInstalledAppsCacheWriteCoordinator } from "../../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../../db/dbWriteBarrier";
import {
  getIosInstalledAppBundleId,
  type IosInstalledAppRecord,
} from "../../utils/ios-cmdline-tools/iosInstalledApp";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { isIosPhysicalUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import {
  applyLauncherPackages,
  catalogFromPackageRecords,
  launcherProbeFallbackReason,
  launcherActivitiesCommand,
  mergeSystemAppCatalogEntry,
  needsLauncherProbe,
  parseLauncherPackages,
  type AndroidAppCatalog,
  type AndroidAppCatalogEntry,
} from "./androidAppCatalog";

/** Label + launchability per Android user id; launchability is a per-user fact. */
type AndroidAppCatalogByUser = Map<number, AndroidAppCatalog>;

const INSTALLED_APPS_CACHE_TTL_MS = 5 * 60 * 1000;

export type { IosInstalledAppRecord } from "../../utils/ios-cmdline-tools/iosInstalledApp";

export interface InstalledAppsDetailedResult {
  apps: InstalledAppsByProfile;
  successful: boolean;
}

export interface IosInstalledAppsDetailedResult {
  apps: IosInstalledAppRecord[];
  successful: boolean;
}

/**
 * Physical-device app listing seam (`devicectl device info apps`), narrowed to
 * the single call this feature makes so tests can inject a fake without a
 * `DeviceAppManager`.
 */
export interface IosPhysicalAppLister {
  listInstalledApps(deviceUdid: string): Promise<IosInstalledAppRecord[]>;
}

/** One CtrlProxy `installed_packages` answer, tagged with the user it describes. */
export interface AndroidInstalledPackages {
  userId: number;
  packages: InstalledPackageRecord[];
}

/** The result of one CtrlProxy package request, including an actionable unavailable reason. */
export type AndroidInstalledPackagesRequest =
  | { available: true; result: AndroidInstalledPackages }
  | { available: false; reason: string };

/**
 * CtrlProxy package-listing seam, narrowed to the single call this feature
 * makes. Lets a test drive the "CtrlProxy answered for user N" path — including
 * the multi-profile case where it answers for one user only — without standing
 * up an accessibility-service connection.
 */
export interface AndroidInstalledPackageSource {
  requestInstalledPackages(signal?: AbortSignal): Promise<AndroidInstalledPackagesRequest>;
}

/**
 * The single CtrlProxy call CtrlProxyInstalledPackageSource makes, narrowed from
 * AndroidCtrlProxyClient so tests can inject a fake without a live WebSocket
 * connection.
 */
export interface AndroidPackagesA11yClient {
  requestInstalledPackages(
    includeSystem: boolean,
    userId: number | undefined,
    timeoutMs: number,
  ): Promise<A11yInstalledPackagesResult>;
}

/** Production source: one request against the on-device accessibility service. */
export class CtrlProxyInstalledPackageSource implements AndroidInstalledPackageSource {
  private readonly device: BootedDevice;
  private readonly a11yClient?: AndroidPackagesA11yClient;

  constructor(device: BootedDevice, a11yClient?: AndroidPackagesA11yClient) {
    this.device = device;
    this.a11yClient = a11yClient;
  }

  private async requestFromClient(
    client: AndroidPackagesA11yClient,
    signal?: AbortSignal,
  ): Promise<A11yInstalledPackagesResult> {
    signal?.throwIfAborted();
    if (!signal) {
      return client.requestInstalledPackages(true, undefined, 4000);
    }

    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const request = client.requestInstalledPackages(true, undefined, 4000);
      void request.then(
        () => {
          if (signal.aborted) {
            // The request settled after cancellation won the race, so its result is safe to ignore.
            logger.debug(
              `[ListInstalledApps] ignoring late installed_packages response for device ${this.device.deviceId}`,
            );
          }
        },
        (error) => {
          if (signal.aborted) {
            // The request settled after cancellation won the race, so its failure is safe to ignore.
            logger.debug(
              `[ListInstalledApps] ignoring late installed_packages failure for device ${this.device.deviceId}: ${errorMessage(error)}`,
            );
          }
        },
      );
      return await Promise.race([aborted, request]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async requestInstalledPackages(signal?: AbortSignal): Promise<AndroidInstalledPackagesRequest> {
    try {
      const client = this.a11yClient ?? AndroidCtrlProxyClient.getInstance(this.device);
      const result = await this.requestFromClient(client, signal);
      signal?.throwIfAborted();
      if (result.success) {
        return { available: true, result: { userId: result.userId, packages: result.packages } };
      }
      const reason = result.error ?? "unknown error";
      // The caller folds this reason into one warn only when a non-namesOnly catalog fallback runs.
      logger.debug(
        `[ListInstalledApps] installed_packages request failed for device ${this.device.deviceId}: ${reason}`,
      );
      return { available: false, reason };
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      const reason = errorMessage(error);
      // The caller folds this reason into one warn only when a non-namesOnly catalog fallback runs.
      logger.debug(
        `[ListInstalledApps] installed_packages request threw for device ${this.device.deviceId}: ${reason}`,
      );
      return { available: false, reason };
    }
  }
}

export interface DetailedListingOptions {
  /**
   * Skip the label/launchability catalog (#6798). A names-only caller does not
   * need it, and it costs a WebSocket round-trip plus one batched adb command.
   */
  namesOnly?: boolean;
}

/**
 * Mutable state threaded through one inventory rebuild: the grouped result, the
 * system-app dedupe map, and the rows destined for the installed-apps cache.
 */
interface InventoryAccumulator {
  installedApps: InstalledAppsByProfile;
  systemAppsMap: Map<string, SystemInstalledApp>;
  cacheEntries: NewInstalledApp[];
  cacheKeys: Set<string>;
  timestampMs: number;
  foregroundApp: { packageName: string; userId: number } | null;
}

interface PartitionedPackages {
  userPackages: string[];
  systemPackages: string[];
  /** Labels + launchability for every package in this partition (#6798). */
  catalog: AndroidAppCatalog;
}

interface ListInstalledAppsOptions {
  cacheEnabled?: boolean;
  installedAppsRepository?: InstalledAppsStore;
  timer?: Timer;
  iosPhysicalAppLister?: IosPhysicalAppLister;
  installedPackageSource?: AndroidInstalledPackageSource;
}

export class ListInstalledApps {
  private adb: AdbExecutor;
  private simctl: SimCtlClient;
  private device: BootedDevice;
  private installedAppsRepository: InstalledAppsStore;
  private cacheEnabled: boolean;
  private timer: Timer;
  private iosPhysicalAppLister: IosPhysicalAppLister | null;
  private installedPackageSource: AndroidInstalledPackageSource;
  /**
   * Create an ListInstalledApps instance
   * @param device - Device to run ADB commands against
   * @param adbFactory - Factory for creating AdbClient instances
   * @param simctl - Optional SimCtlClient instance for testing
   * @param options - Optional cache configuration
   */
  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    simctl: SimCtlClient | null = null,
    options: ListInstalledAppsOptions = {},
  ) {
    this.adb = adbFactory.create(device);
    this.simctl = simctl || new SimCtlClient(device);
    this.device = device;
    this.installedAppsRepository = options.installedAppsRepository ?? new InstalledAppsRepository();
    // Enable caching by default when using the production factory
    const defaultCacheEnabled = adbFactory === defaultAdbClientFactory;
    this.cacheEnabled = options.cacheEnabled ?? defaultCacheEnabled;
    this.timer = options.timer ?? defaultTimer;
    this.iosPhysicalAppLister = options.iosPhysicalAppLister ?? null;
    this.installedPackageSource =
      options.installedPackageSource ?? new CtrlProxyInstalledPackageSource(device);
  }

  /**
   * Physical iOS devices have no simctl; `devicectl device info apps` is the
   * only listing available there. Constructed lazily so simulator-only callers
   * never build a DeviceAppManager.
   */
  private getIosPhysicalAppLister(): IosPhysicalAppLister {
    this.iosPhysicalAppLister ??= new DeviceAppManager();
    return this.iosPhysicalAppLister;
  }

  /**
   * List all installed packages on the device
   * @returns Promise with list of package names
   */
  async execute(): Promise<string[]> {
    try {
      switch (this.device.platform) {
        case "ios":
          return (await this.executeIosDetailed())
            .map((app) => getIosInstalledAppBundleId(app))
            .filter((bundleId): bundleId is string => bundleId !== undefined);
        case "android":
          // For backward compatibility, just return package names. Names-only
          // callers (LaunchApp's installed-package check) must not pay for the
          // label/launchability catalog or its adb probe (#6798).
          const detailedApps = await this.executeDetailed(undefined, { namesOnly: true });
          return this.flattenPackageNames(detailedApps);
        default:
          throw new ActionableError(`Unsupported platform: ${this.device.platform}`);
      }
    } catch (error) {
      logger.warn("Failed to list installed apps:", error);
      return []; // Return empty array on error
    }
  }

  /**
   * List installed packages on Android grouped by user profile, with system apps deduped.
   * @returns Promise with grouped installed app details
   */
  async executeDetailed(
    signal?: AbortSignal,
    options: DetailedListingOptions = {},
  ): Promise<InstalledAppsByProfile> {
    return (await this.executeDetailedResult(signal, options)).apps;
  }

  /**
   * List Android apps and report whether the live listing completed without
   * partial-user or command failures. Resource caches must not retain a
   * degraded fallback result.
   */
  async executeDetailedResult(
    signal?: AbortSignal,
    options: DetailedListingOptions = {},
  ): Promise<InstalledAppsDetailedResult> {
    signal?.throwIfAborted();
    if (this.device.platform !== "android") {
      logger.warn("executeDetailed() is only supported on Android");
      return { apps: { profiles: {}, system: [] }, successful: false };
    }

    try {
      if (this.cacheEnabled) {
        const cachedApps = await this.getCachedInstalledApps(signal, options);
        if (cachedApps) {
          return { apps: cachedApps, successful: true };
        }
      }

      return await this.rebuildInstalledAppsCache(signal, options);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("Failed to list installed apps with details:", error);
      return { apps: { profiles: {}, system: [] }, successful: false };
    }
  }

  /**
   * List iOS simulator apps while preserving the optional metadata used by the
   * app resource. iOS keeps its pre-existing live-list behavior because no
   * production observer can invalidate a persistent cache after an out-of-band
   * Xcode or simctl install/uninstall.
   */
  async executeIosDetailed(): Promise<IosInstalledAppRecord[]> {
    return (await this.executeIosDetailedResult()).apps;
  }

  /**
   * List iOS apps and preserve whether simctl produced a live result so the
   * resource cache can retry after a transient command failure.
   */
  async executeIosDetailedResult(): Promise<IosInstalledAppsDetailedResult> {
    if (this.device.platform !== "ios") {
      logger.warn("executeIosDetailed() is only supported on iOS");
      return { apps: [], successful: false };
    }

    try {
      // `listAppsOrThrow` (not `listApps`) so a simctl listing that failed
      // surfaces as successful:false instead of being collapsed into an empty
      // array, which callers would read as "the app is absent" (issue #5621).
      //
      // Only a positively physical-looking UDID routes to devicectl. Anything
      // else (simulator UUID, or a non-UDID id) keeps the simctl path, so an
      // unrecognized id degrades to today's behavior rather than shelling out
      // to a tool that cannot serve it.
      const apps = isIosPhysicalUdid(this.device.deviceId)
        ? await this.getIosPhysicalAppLister().listInstalledApps(this.device.deviceId)
        : await this.simctl.listAppsOrThrow(this.device.deviceId);
      const appsByBundleId = new Map<string, IosInstalledAppRecord>();
      for (const app of apps) {
        if (!app || typeof app !== "object" || Array.isArray(app)) {
          continue;
        }
        const record = app as IosInstalledAppRecord;
        const bundleId = getIosInstalledAppBundleId(record);
        if (bundleId) {
          appsByBundleId.set(bundleId, record);
        }
      }
      const detailedApps = Array.from(appsByBundleId.values());

      return { apps: detailedApps, successful: true };
    } catch (error) {
      logger.warn("Failed to list installed iOS apps:", error);
      return { apps: [], successful: false };
    }
  }

  private async getCachedInstalledApps(
    signal?: AbortSignal,
    options: DetailedListingOptions = {},
  ): Promise<InstalledAppsByProfile | null> {
    if (getInstalledAppsCacheWriteCoordinator().isDirty(this.device.deviceId)) {
      return null;
    }

    // Oldest row wins: the TTL has to cover every row this read will return, so
    // a single package-event write cannot extend it for rows it never verified
    // (issue #6639).
    const cacheVerifiedAt = await this.installedAppsRepository.getCacheVerifiedAt(
      this.device.deviceId,
    );
    if (!cacheVerifiedAt) {
      return null;
    }

    const cacheAgeMs = this.timer.now() - cacheVerifiedAt;
    if (cacheAgeMs > INSTALLED_APPS_CACHE_TTL_MS) {
      return null;
    }

    const cachedRows = await this.installedAppsRepository.listInstalledApps(this.device.deviceId);
    if (cachedRows.length === 0) {
      return null;
    }

    const foregroundApp =
      this.device.platform === "android" ? await this.adb.getForegroundApp(signal) : null;
    const users = await this.getAndroidUsersForCache(signal);
    signal?.throwIfAborted();
    // Labels and launchability are deliberately NOT persisted: they are device
    // state (a locale change relabels every app, an update can add or remove a
    // launcher entry) and re-reading them costs one WebSocket round-trip plus at
    // most one batched adb command. Re-read them so a cached listing answers
    // "which package is Contacts?" as well as a live one does (#6798).
    const catalogByUser: AndroidAppCatalogByUser = options.namesOnly
      ? new Map()
      : await this.readAndroidAppCatalog(cachedRows, signal);
    logger.info(
      `[ListInstalledApps] Using cached installed apps list (age ${cacheAgeMs}ms, rows ${cachedRows.length})`,
    );
    return this.buildInstalledAppsFromRows(cachedRows, foregroundApp, users, catalogByUser);
  }

  /**
   * Labels + launchability for cached rows, per user. The CtrlProxy pass answers
   * for the user its accessibility service runs as and no other, so every other
   * cached profile — and any package that pass did not mention — still gets one
   * batched adb probe. The cost stays proportional to the number of profiles
   * rather than packages (#6798).
   *
   * Cancellable at every step: the CtrlProxy request alone can take four
   * seconds and each profile then costs its own sequential adb probe, so a
   * caller that already cancelled must not keep driving device I/O (#6924
   * review).
   */
  private async readAndroidAppCatalog(
    rows: DbInstalledApp[],
    signal?: AbortSignal,
  ): Promise<AndroidAppCatalogByUser> {
    const catalogByUser: AndroidAppCatalogByUser = new Map();
    if (this.device.platform !== "android") {
      return catalogByUser;
    }
    signal?.throwIfAborted();
    const proxy = await this.fetchCtrlProxyPackages(signal);
    signal?.throwIfAborted();
    if (proxy.available) {
      catalogByUser.set(proxy.result.userId, catalogFromPackageRecords(proxy.result.packages));
    }
    const packagesByUser = new Map<number, string[]>();
    for (const row of rows) {
      const packages = packagesByUser.get(row.user_id) ?? [];
      packages.push(row.package_name);
      packagesByUser.set(row.user_id, packages);
    }
    for (const [userId, packageNames] of packagesByUser) {
      let catalog = catalogByUser.get(userId);
      if (!catalog) {
        catalog = new Map();
        catalogByUser.set(userId, catalog);
      }
      if (needsLauncherProbe(catalog, packageNames)) {
        this.warnCtrlProxyCatalogFallback(proxy, userId, catalog, packageNames);
        signal?.throwIfAborted();
        await this.topUpLaunchability(catalog, packageNames, userId, signal);
      }
    }
    return catalogByUser;
  }

  /**
   * One `installed_packages` request against the on-device accessibility
   * service. The result carries either its unavailable reason or the user it
   * describes — PackageManager runs as the service user, so it answers for that
   * user only and every other profile still needs its own probe (#6798).
   */
  private async fetchCtrlProxyPackages(
    signal?: AbortSignal,
  ): Promise<AndroidInstalledPackagesRequest> {
    return this.installedPackageSource.requestInstalledPackages(signal);
  }

  /** Explain when the label-capable CtrlProxy catalog must be topped up by adb. */
  private warnCtrlProxyCatalogFallback(
    proxy: AndroidInstalledPackagesRequest,
    userId: number,
    catalog: AndroidAppCatalog,
    packageNames: Iterable<string>,
  ): void {
    if (!proxy.available) {
      logger.warn(
        `[ListInstalledApps] CtrlProxy catalog unavailable for device ${this.device.deviceId}: ${proxy.reason}; falling back to ADB launcher probe for user ${userId}.`,
      );
      return;
    }
    if (proxy.result.userId !== userId) {
      logger.debug(
        `[ListInstalledApps] CtrlProxy catalog covers user ${proxy.result.userId} only; user ${userId} uses the ADB launcher probe.`,
      );
      return;
    }
    const reason = launcherProbeFallbackReason(catalog, packageNames);
    if (reason) {
      logger.warn(
        `[ListInstalledApps] ${reason} for device ${this.device.deviceId}; falling back to ADB launcher probe for user ${userId}.`,
      );
    }
  }

  /**
   * Fold one user's view of a system package into the deduplicated entry. Shared
   * by the live and cached paths so both merge user ids, foreground state and
   * per-user launchability the same way (#6798 review).
   */
  private upsertSystemApp(
    systemAppsMap: Map<string, SystemInstalledApp>,
    packageName: string,
    userId: number,
    isForeground: boolean,
    entry: AndroidAppCatalogEntry | undefined,
  ): void {
    const existing = systemAppsMap.get(packageName);
    if (existing) {
      if (!existing.userIds.includes(userId)) {
        existing.userIds.push(userId);
      }
      existing.foreground = existing.foreground || isForeground;
      mergeSystemAppCatalogEntry(existing, userId, entry);
      return;
    }
    const systemApp: SystemInstalledApp = {
      packageName,
      userIds: [userId],
      foreground: isForeground,
      recent: false, // TODO: Implement recent app detection
    };
    mergeSystemAppCatalogEntry(systemApp, userId, entry);
    systemAppsMap.set(packageName, systemApp);
  }

  private buildInstalledAppsFromRows(
    rows: DbInstalledApp[],
    foregroundApp: { packageName: string; userId: number } | null,
    users: AndroidUser[] = [],
    catalogByUser: AndroidAppCatalogByUser = new Map(),
  ): InstalledAppsByProfile {
    const installedApps: InstalledAppsByProfile = { profiles: {}, system: [] };
    const systemAppsMap = new Map<string, SystemInstalledApp>();

    for (const row of rows) {
      const isForeground =
        foregroundApp !== null &&
        foregroundApp.packageName === row.package_name &&
        foregroundApp.userId === row.user_id;

      const entry = catalogByUser.get(row.user_id)?.get(row.package_name);
      if (row.is_system) {
        this.upsertSystemApp(systemAppsMap, row.package_name, row.user_id, isForeground, entry);
      } else {
        installedApps.profiles[row.user_id] = installedApps.profiles[row.user_id] || [];
        installedApps.profiles[row.user_id].push({
          packageName: row.package_name,
          userId: row.user_id,
          profileType: this.profileTypeForUser(row.user_id, users, row.profile_type ?? undefined),
          foreground: isForeground,
          recent: false,
          ...entry,
        });
      }
    }

    installedApps.system = Array.from(systemAppsMap.values());
    return installedApps;
  }

  private async getAndroidUsersForCache(signal?: AbortSignal): Promise<AndroidUser[]> {
    if (this.device.platform !== "android") {
      return [];
    }
    try {
      return await this.adb.listUsers(signal);
    } catch (error) {
      logger.warn("[ListInstalledApps] Failed to refresh user metadata for cached apps", error);
      return [];
    }
  }

  private profileTypeForUser(
    userId: number,
    users: AndroidUser[],
    cachedProfileType: AndroidUser["profileType"],
  ): AndroidUser["profileType"] {
    const user = users.find((candidate) => candidate.userId === userId);
    return (
      user?.profileType ??
      (user ? classifyAndroidUser(user.flags) : (cachedProfileType ?? "unknown"))
    );
  }

  private async rebuildInstalledAppsCache(
    signal?: AbortSignal,
    options: DetailedListingOptions = {},
  ): Promise<InstalledAppsDetailedResult> {
    signal?.throwIfAborted();
    const cacheGeneration = getInstalledAppsCacheWriteCoordinator().beginRebuild(
      this.device.deviceId,
    );
    const installedApps: InstalledAppsByProfile = { profiles: {}, system: [] };
    const systemAppsMap = new Map<string, SystemInstalledApp>();
    const cacheEntries: NewInstalledApp[] = [];
    const accumulator: InventoryAccumulator = {
      installedApps,
      systemAppsMap,
      cacheEntries,
      cacheKeys: new Set<string>(),
      timestampMs: this.timer.now(),
      foregroundApp: null,
    };
    let hadUserErrors = false;

    // Get all users on the device
    logger.info("[ListInstalledApps] Getting list of users...");
    const users = await this.adb.listUsers(signal);
    signal?.throwIfAborted();
    logger.info(
      `[ListInstalledApps] Found ${users.length} user(s): ${users.map((u) => `${u.userId}:${u.name}`).join(", ")}`,
    );
    if (users.length === 0) {
      logger.warn("[ListInstalledApps] No users reported; skipping cache update");
      return { apps: installedApps, successful: false };
    }

    // Get the current foreground app
    accumulator.foregroundApp = await this.adb.getForegroundApp(signal);
    signal?.throwIfAborted();

    // List packages for each user
    for (const user of users) {
      try {
        signal?.throwIfAborted();
        logger.info(`[ListInstalledApps] Listing packages for user ${user.userId}...`);

        const { userPackages, systemPackages, catalog } = await this.partitionPackagesForUser(
          user.userId,
          signal,
          options,
        );
        signal?.throwIfAborted();

        logger.info(
          `[ListInstalledApps] Found ${userPackages.length} user package(s) and ${systemPackages.length} system package(s) for user ${user.userId}`,
        );

        this.collectUserPackages(accumulator, user, userPackages, catalog);
        this.collectSystemPackages(accumulator, user, systemPackages, catalog);
      } catch (error) {
        signal?.throwIfAborted();
        hadUserErrors = true;
        logger.warn(`Failed to list packages for user ${user.userId}:`, error);
        // Continue with other users
      }
    }

    installedApps.system = Array.from(systemAppsMap.values());
    const profileAppCount = Object.values(installedApps.profiles).reduce(
      (count, apps) => count + apps.length,
      0,
    );

    logger.info(
      `Found ${profileAppCount} user app(s) across ${users.length} user(s); ${installedApps.system.length} system app(s) deduped`,
    );

    if (this.cacheEnabled && !hadUserErrors) {
      try {
        const committed = await getInstalledAppsCacheWriteCoordinator().commitRebuild(
          this.device.deviceId,
          cacheGeneration,
          () =>
            getDbWriteBarrier()
              .track(() =>
                this.installedAppsRepository.replaceInstalledApps(
                  this.device.deviceId,
                  cacheEntries,
                ),
              )
              .then(() => undefined),
        );
        if (committed) {
          getInstalledAppsCacheWriteCoordinator().markRebuilt(
            this.device.deviceId,
            cacheGeneration,
          );
        }
      } catch (error) {
        // The live result remains valid even if its persistence fails. Keep a
        // dirty cache dirty so a later read retries the database write.
        logger.warn("[ListInstalledApps] Failed to update installed apps cache:", error);
      }
    } else if (this.cacheEnabled && hadUserErrors) {
      logger.warn("[ListInstalledApps] Skipping cache update due to user listing errors");
    }

    return { apps: installedApps, successful: !hadUserErrors };
  }

  private isForegroundFor(
    accumulator: InventoryAccumulator,
    packageName: string,
    userId: number,
  ): boolean {
    const foreground = accumulator.foregroundApp;
    return (
      foreground !== null && foreground.packageName === packageName && foreground.userId === userId
    );
  }

  private recordCacheEntry(
    accumulator: InventoryAccumulator,
    user: AndroidUser,
    packageName: string,
    isSystem: 0 | 1,
  ): void {
    const cacheKey = `${user.userId}:${packageName}:${isSystem}`;
    if (accumulator.cacheKeys.has(cacheKey)) {
      return;
    }
    accumulator.cacheKeys.add(cacheKey);
    accumulator.cacheEntries.push({
      device_id: this.device.deviceId,
      user_id: user.userId,
      package_name: packageName,
      is_system: isSystem,
      installed_at: accumulator.timestampMs,
      last_verified_at: accumulator.timestampMs,
      profile_type: user.profileType ?? classifyAndroidUser(user.flags),
    });
  }

  private collectUserPackages(
    accumulator: InventoryAccumulator,
    user: AndroidUser,
    packageNames: string[],
    catalog: AndroidAppCatalog,
  ): void {
    const profiles = accumulator.installedApps.profiles;
    profiles[user.userId] = profiles[user.userId] || [];
    for (const packageName of packageNames) {
      profiles[user.userId].push({
        packageName,
        userId: user.userId,
        profileType: user.profileType ?? classifyAndroidUser(user.flags),
        foreground: this.isForegroundFor(accumulator, packageName, user.userId),
        recent: false, // TODO: Implement recent app detection
        ...catalog.get(packageName),
      });
      this.recordCacheEntry(accumulator, user, packageName, 0);
    }
  }

  private collectSystemPackages(
    accumulator: InventoryAccumulator,
    user: AndroidUser,
    packageNames: string[],
    catalog: AndroidAppCatalog,
  ): void {
    for (const packageName of packageNames) {
      this.upsertSystemApp(
        accumulator.systemAppsMap,
        packageName,
        user.userId,
        this.isForegroundFor(accumulator, packageName, user.userId),
        catalog.get(packageName),
      );
      this.recordCacheEntry(accumulator, user, packageName, 1);
    }
  }

  // Why: PackageManager runs as the service user, so cross-user queries
  // (`--user N` for non-current user) fall back to ADB.
  private async partitionPackagesForUser(
    userId: number,
    signal?: AbortSignal,
    options: DetailedListingOptions = {},
  ): Promise<PartitionedPackages> {
    const proxy =
      this.device.platform === "android"
        ? await this.fetchCtrlProxyPackages(signal)
        : {
            available: false as const,
            reason: "CtrlProxy catalog is unavailable on this platform",
          };
    if (proxy.available) {
      const records = proxy.result.userId === userId ? proxy.result.packages : null;
      if (records) {
        const userPackages: string[] = [];
        const systemPackages: string[] = [];
        for (const p of records) {
          (p.isSystem ? systemPackages : userPackages).push(p.packageName);
        }
        // The accessibility service resolves labels and launch intents in the
        // same PackageManager pass, so the catalog costs nothing extra here.
        // Only an on-device CtrlProxy that predates those fields needs the adb probe
        // as a top-up (#6798).
        const catalog = options.namesOnly
          ? (new Map() as AndroidAppCatalog)
          : catalogFromPackageRecords(records);
        const listedPackages = [...userPackages, ...systemPackages];
        if (!options.namesOnly && needsLauncherProbe(catalog, listedPackages)) {
          this.warnCtrlProxyCatalogFallback(proxy, userId, catalog, listedPackages);
          await this.topUpLaunchability(catalog, listedPackages, userId, signal);
        }
        return { userPackages, systemPackages, catalog };
      }
    }

    const [allRes, systemRes] = await Promise.all([
      this.adb.executeCommand(
        `shell pm list packages --user ${userId}`,
        undefined,
        undefined,
        undefined,
        signal,
      ),
      this.adb.executeCommand(
        `shell pm list packages -s --user ${userId}`,
        undefined,
        undefined,
        undefined,
        signal,
      ),
    ]);
    const systemPackages = this.parsePackages(systemRes.stdout);
    const systemSet = new Set(systemPackages);
    const userPackages = this.parsePackages(allRes.stdout).filter((p) => !systemSet.has(p));
    const catalog: AndroidAppCatalog = new Map();
    if (!options.namesOnly) {
      const listedPackages = [...userPackages, ...systemPackages];
      this.warnCtrlProxyCatalogFallback(proxy, userId, catalog, listedPackages);
      await this.topUpLaunchability(catalog, listedPackages, userId, signal);
    }
    return { userPackages, systemPackages, catalog };
  }

  /**
   * One batched `cmd package query-activities` read per user. Labels are not
   * available over adb at all (a label is a `labelRes` resource id and no shell
   * surface resolves one), so this only settles launchability — and only when
   * the probe itself succeeded, so a missing `package` service leaves
   * `launchable` undefined rather than marking every app unlaunchable (#6798).
   */
  private async topUpLaunchability(
    catalog: AndroidAppCatalog,
    packageNames: string[],
    userId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.adb.executeCommand(
        launcherActivitiesCommand(userId),
        undefined,
        undefined,
        undefined,
        signal,
      );
      signal?.throwIfAborted();
      applyLauncherPackages(catalog, packageNames, parseLauncherPackages(result.stdout));
    } catch (error) {
      signal?.throwIfAborted();
      // Best-effort enrichment: the app listing itself is still correct without
      // it, and `launchable: undefined` truthfully reports "not known".
      logger.debug(
        `[ListInstalledApps] Launcher activity probe failed for user ${userId}: ${error}`,
      );
    }
  }

  private parsePackages(stdout: string): string[] {
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("package:"))
      .map((line) => line.replace("package:", "").trim())
      .filter((pkg) => pkg.length > 0);
  }

  private flattenPackageNames(detailedApps: InstalledAppsByProfile): string[] {
    const packageNames = new Set<string>();
    for (const apps of Object.values(detailedApps.profiles)) {
      for (const app of apps) {
        packageNames.add(app.packageName);
      }
    }
    for (const app of detailedApps.system) {
      packageNames.add(app.packageName);
    }
    return Array.from(packageNames);
  }
}
