import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
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
import { getInstalledAppsCacheWriteCoordinator } from "../../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../../db/dbWriteBarrier";
import {
  getIosInstalledAppBundleId,
  type IosInstalledAppRecord,
} from "../../utils/ios-cmdline-tools/iosInstalledApp";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { isIosPhysicalUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";

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

interface ListInstalledAppsOptions {
  cacheEnabled?: boolean;
  installedAppsRepository?: InstalledAppsStore;
  timer?: Timer;
  iosPhysicalAppLister?: IosPhysicalAppLister;
}

export class ListInstalledApps {
  private adb: AdbExecutor;
  private simctl: SimCtlClient;
  private device: BootedDevice;
  private installedAppsRepository: InstalledAppsStore;
  private cacheEnabled: boolean;
  private timer: Timer;
  private iosPhysicalAppLister: IosPhysicalAppLister | null;
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
          // For backward compatibility, just return package names
          const detailedApps = await this.executeDetailed();
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
  async executeDetailed(): Promise<InstalledAppsByProfile> {
    return (await this.executeDetailedResult()).apps;
  }

  /**
   * List Android apps and report whether the live listing completed without
   * partial-user or command failures. Resource caches must not retain a
   * degraded fallback result.
   */
  async executeDetailedResult(): Promise<InstalledAppsDetailedResult> {
    if (this.device.platform !== "android") {
      logger.warn("executeDetailed() is only supported on Android");
      return { apps: { profiles: {}, system: [] }, successful: false };
    }

    try {
      if (this.cacheEnabled) {
        const cachedApps = await this.getCachedInstalledApps();
        if (cachedApps) {
          return { apps: cachedApps, successful: true };
        }
      }

      return await this.rebuildInstalledAppsCache();
    } catch (error) {
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

  private async getCachedInstalledApps(): Promise<InstalledAppsByProfile | null> {
    if (getInstalledAppsCacheWriteCoordinator().isDirty(this.device.deviceId)) {
      return null;
    }

    const lastVerifiedAt = await this.installedAppsRepository.getLatestVerification(
      this.device.deviceId,
    );
    if (!lastVerifiedAt) {
      return null;
    }

    const cacheAgeMs = this.timer.now() - lastVerifiedAt;
    if (cacheAgeMs > INSTALLED_APPS_CACHE_TTL_MS) {
      return null;
    }

    const cachedRows = await this.installedAppsRepository.listInstalledApps(this.device.deviceId);
    if (cachedRows.length === 0) {
      return null;
    }

    const foregroundApp =
      this.device.platform === "android" ? await this.adb.getForegroundApp() : null;
    const users = await this.getAndroidUsersForCache();
    logger.info(
      `[ListInstalledApps] Using cached installed apps list (age ${cacheAgeMs}ms, rows ${cachedRows.length})`,
    );
    return this.buildInstalledAppsFromRows(cachedRows, foregroundApp, users);
  }

  private buildInstalledAppsFromRows(
    rows: DbInstalledApp[],
    foregroundApp: { packageName: string; userId: number } | null,
    users: AndroidUser[] = [],
  ): InstalledAppsByProfile {
    const installedApps: InstalledAppsByProfile = { profiles: {}, system: [] };
    const systemAppsMap = new Map<string, SystemInstalledApp>();

    for (const row of rows) {
      const isForeground =
        foregroundApp !== null &&
        foregroundApp.packageName === row.package_name &&
        foregroundApp.userId === row.user_id;

      if (row.is_system) {
        const existing = systemAppsMap.get(row.package_name);
        if (existing) {
          if (!existing.userIds.includes(row.user_id)) {
            existing.userIds.push(row.user_id);
          }
          existing.foreground = existing.foreground || isForeground;
        } else {
          systemAppsMap.set(row.package_name, {
            packageName: row.package_name,
            userIds: [row.user_id],
            foreground: isForeground,
            recent: false,
          });
        }
      } else {
        installedApps.profiles[row.user_id] = installedApps.profiles[row.user_id] || [];
        installedApps.profiles[row.user_id].push({
          packageName: row.package_name,
          userId: row.user_id,
          profileType: this.profileTypeForUser(row.user_id, users, row.profile_type ?? undefined),
          foreground: isForeground,
          recent: false,
        });
      }
    }

    installedApps.system = Array.from(systemAppsMap.values());
    return installedApps;
  }

  private async getAndroidUsersForCache(): Promise<AndroidUser[]> {
    if (this.device.platform !== "android") {
      return [];
    }
    try {
      return await this.adb.listUsers();
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

  private async rebuildInstalledAppsCache(): Promise<InstalledAppsDetailedResult> {
    const cacheGeneration = getInstalledAppsCacheWriteCoordinator().beginRebuild(
      this.device.deviceId,
    );
    const installedApps: InstalledAppsByProfile = { profiles: {}, system: [] };
    const systemAppsMap = new Map<string, SystemInstalledApp>();
    const cacheEntries: NewInstalledApp[] = [];
    const cacheKeys = new Set<string>();
    const timestampMs = this.timer.now();
    let hadUserErrors = false;

    // Get all users on the device
    logger.info("[ListInstalledApps] Getting list of users...");
    const users = await this.adb.listUsers();
    logger.info(
      `[ListInstalledApps] Found ${users.length} user(s): ${users.map((u) => `${u.userId}:${u.name}`).join(", ")}`,
    );
    if (users.length === 0) {
      logger.warn("[ListInstalledApps] No users reported; skipping cache update");
      return { apps: installedApps, successful: false };
    }

    // Get the current foreground app
    const foregroundApp = await this.adb.getForegroundApp();

    // List packages for each user
    for (const user of users) {
      try {
        logger.info(`[ListInstalledApps] Listing packages for user ${user.userId}...`);

        const { userPackages, systemPackages } = await this.partitionPackagesForUser(user.userId);

        logger.info(
          `[ListInstalledApps] Found ${userPackages.length} user package(s) and ${systemPackages.length} system package(s) for user ${user.userId}`,
        );

        installedApps.profiles[user.userId] = installedApps.profiles[user.userId] || [];

        for (const packageName of userPackages) {
          const isForeground =
            foregroundApp !== null &&
            foregroundApp.packageName === packageName &&
            foregroundApp.userId === user.userId;

          installedApps.profiles[user.userId].push({
            packageName,
            userId: user.userId,
            profileType: user.profileType ?? classifyAndroidUser(user.flags),
            foreground: isForeground,
            recent: false, // TODO: Implement recent app detection
          });

          const cacheKey = `${user.userId}:${packageName}:0`;
          if (!cacheKeys.has(cacheKey)) {
            cacheKeys.add(cacheKey);
            cacheEntries.push({
              device_id: this.device.deviceId,
              user_id: user.userId,
              package_name: packageName,
              is_system: 0,
              installed_at: timestampMs,
              last_verified_at: timestampMs,
              profile_type: user.profileType ?? classifyAndroidUser(user.flags),
            });
          }
        }

        for (const packageName of systemPackages) {
          const isForeground =
            foregroundApp !== null &&
            foregroundApp.packageName === packageName &&
            foregroundApp.userId === user.userId;

          const existing = systemAppsMap.get(packageName);
          if (existing) {
            if (!existing.userIds.includes(user.userId)) {
              existing.userIds.push(user.userId);
            }
            existing.foreground = existing.foreground || isForeground;
          } else {
            systemAppsMap.set(packageName, {
              packageName,
              userIds: [user.userId],
              foreground: isForeground,
              recent: false, // TODO: Implement recent app detection
            });
          }

          const cacheKey = `${user.userId}:${packageName}:1`;
          if (!cacheKeys.has(cacheKey)) {
            cacheKeys.add(cacheKey);
            cacheEntries.push({
              device_id: this.device.deviceId,
              user_id: user.userId,
              package_name: packageName,
              is_system: 1,
              installed_at: timestampMs,
              last_verified_at: timestampMs,
              profile_type: user.profileType ?? classifyAndroidUser(user.flags),
            });
          }
        }
      } catch (error) {
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

  // Why: PackageManager runs as the service user, so cross-user queries
  // (`--user N` for non-current user) fall back to ADB.
  private async partitionPackagesForUser(
    userId: number,
  ): Promise<{ userPackages: string[]; systemPackages: string[] }> {
    if (this.device.platform === "android") {
      try {
        const a11y = AndroidCtrlProxyClient.getInstance(this.device);
        const result = await a11y.requestInstalledPackages(true, undefined, 4000);
        if (result.success && result.userId === userId) {
          const userPackages: string[] = [];
          const systemPackages: string[] = [];
          for (const p of result.packages) {
            (p.isSystem ? systemPackages : userPackages).push(p.packageName);
          }
          return { userPackages, systemPackages };
        }
      } catch (error) {
        logger.debug(
          `[ListInstalledApps] WebSocket package list failed, falling back to ADB: ${error}`,
        );
      }
    }

    const [allRes, systemRes] = await Promise.all([
      this.adb.executeCommand(`shell pm list packages --user ${userId}`),
      this.adb.executeCommand(`shell pm list packages -s --user ${userId}`),
    ]);
    const systemPackages = this.parsePackages(systemRes.stdout);
    const systemSet = new Set(systemPackages);
    const userPackages = this.parsePackages(allRes.stdout).filter((p) => !systemSet.has(p));
    return { userPackages, systemPackages };
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
