import { InstalledAppsRepository } from "../../db/installedAppsRepository";
import { ActionableError, BootedDevice, LaunchAppResult, ObserveResult } from "../../models";
import { toActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import { readAndroidPackageProcesses } from "../../utils/android-cmdline-tools/androidProcessState";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { resolveSetupUser } from "../../ctrlProxy/setupUser";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { getIosInstalledAppBundleId } from "../../utils/ios-cmdline-tools/iosInstalledApp";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { rethrowDeviceTransportUnavailable } from "../../utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import { logger } from "../../utils/logger";
import { runWithNestedPerfTracker } from "../../utils/PerfContext";
import { createGlobalPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { serverConfig } from "../../utils/ServerConfig";
import { defaultTimer, Timer } from "../../utils/SystemTimer";
import { ListInstalledApps } from "../observe/ListInstalledApps";
import { DisplayedTimeMetricsCollector } from "../performance/DisplayedTimeMetricsCollector";
import {
  getPerformanceMonitor,
  setLastTtiMs,
  type PerformanceSamplingCoordinator,
} from "../performance/PerformanceMonitor";
import { AndroidLaunchActivity } from "./AndroidLaunchActivity";
import { waitForAndroidPreflight } from "./AndroidLaunchPreflight";
import { BaseVisualChange } from "./BaseVisualChange";
import { ClearAppData } from "./ClearAppData";
import {
  confirmAndroidPackageInstalledLive,
  type InstalledAppsCacheStaleMarker,
} from "./confirmAndroidPackageInstalledLive";
import { IosLaunchHierarchy } from "./IosLaunchHierarchy";
import { IosLaunchProcess, type IosLaunchProcessOptions } from "./IosLaunchProcess";
import {
  type AndroidClearAppDataAction,
  type AndroidColdBootAction,
  type AndroidLaunchOptions,
  type DeviceAppLauncher,
  type InstalledAppsProvider,
  type IosClearAppDataRunner,
  type LaunchAppCall,
  type LaunchAppDependencies,
  type LaunchAppPositionalTail,
  type LaunchAppSimctl,
  type TargetUserDetector,
} from "./LaunchAppTypes";
import { LaunchForegroundWait } from "./LaunchForegroundWait";
import { LaunchObservation } from "./LaunchObservation";
import {
  LaunchPackageRemovedError,
  PACKAGE_NOT_INSTALLED_ERROR,
} from "./LaunchPackageRemovedError";
import { OBSERVED_INTERACTION_PROFILES } from "./observedInteractionProfiles";
import {
  DefaultDeviceWindowCacheInvalidator,
  DeviceWindowCacheInvalidator,
  TerminateApp,
} from "./TerminateApp";
export { amStartReportedFailure } from "./AndroidLaunchActivity";
export {
  type AndroidClearAppDataAction,
  type AndroidColdBootAction,
  type DeviceAppLauncher,
  type InstalledAppsProvider,
  type IosClearAppDataRunner,
  type LaunchAppCall,
  type LaunchAppSimctl,
  type TargetUserDetector,
} from "./LaunchAppTypes";

const LAUNCH_OBSERVATION_TIMEOUT_MS = 5000;
const LAUNCH_OBSERVATION_POLL_INTERVAL_MS = 200;

const ANDROID_LAUNCH_OBSERVATION_TIMEOUT_MS = 15_000;

const ANDROID_COLD_FRAME_TIMEOUT_MS = 2_500;
const ANDROID_COLD_FRAME_POLL_MS = 150;

function resolvePerformanceSamplingCoordinator(
  dependencies: LaunchAppDependencies,
): PerformanceSamplingCoordinator {
  return dependencies.performanceSamplingCoordinator ?? getPerformanceMonitor();
}

export class LaunchApp extends BaseVisualChange {
  readonly simctl: LaunchAppSimctl;
  private deviceAppLauncher: DeviceAppLauncher;
  private targetUserDetector: TargetUserDetector;
  private installedAppsProvider: InstalledAppsProvider;
  private installedAppsCacheStaleMarker: InstalledAppsCacheStaleMarker | undefined;
  private performanceTrackerFactory: () => PerformanceTracker;
  private clearAppDataFactory: (
    device: BootedDevice,
    simctl: LaunchAppSimctl,
  ) => IosClearAppDataRunner;
  private createAndroidClearAppData: (device: BootedDevice) => AndroidClearAppDataAction;
  private createAndroidColdBoot: (device: BootedDevice) => AndroidColdBootAction;
  private cacheInvalidator: DeviceWindowCacheInvalidator;
  private performanceSamplingCoordinator: PerformanceSamplingCoordinator;
  /**
   * Create an LaunchApp instance
   * @param device - Optional device
   * @param options - Optional ADB executor, SimCtlClient, Timer and collaborators for testing
   */
  constructor(
    device: BootedDevice,
    {
      adb = null,
      simctl,
      timer = defaultTimer,
      dependencies = {},
    }: {
      adb?: AdbExecutor | null;
      simctl?: LaunchAppSimctl | null;
      timer?: Timer;
      dependencies?: LaunchAppDependencies;
    } = {},
  ) {
    super(device, adb, timer);
    this.device = device;
    this.simctl = simctl || new SimCtlClient(this.device);
    this.deviceAppLauncher = dependencies.deviceAppLauncher ?? new DeviceAppManager();
    this.targetUserDetector = dependencies.targetUserDetector ?? {
      detectTargetUserId: (packageName: string, userId?: number, signal?: AbortSignal) =>
        this.detectTargetUserId(packageName, userId, signal),
    };
    this.installedAppsProvider = dependencies.installedAppsProvider ?? {
      listInstalledApps: (signal?: AbortSignal) => this.listInstalledApps(signal),
    };
    this.installedAppsCacheStaleMarker = dependencies.installedAppsCacheStaleMarker;
    this.performanceTrackerFactory =
      dependencies.performanceTrackerFactory ?? createGlobalPerformanceTracker;
    this.cacheInvalidator =
      dependencies.cacheInvalidator ?? new DefaultDeviceWindowCacheInvalidator();
    this.windowCacheInvalidator = this.cacheInvalidator;
    this.clearAppDataFactory =
      dependencies.clearAppDataFactory ??
      ((device, simctl) =>
        new ClearAppData(device, undefined, { simctl, cacheInvalidator: this.cacheInvalidator }));
    this.createAndroidClearAppData = this.resolveAndroidClearAppDataFactory(
      dependencies.createAndroidClearAppData,
    );
    this.createAndroidColdBoot = this.resolveAndroidColdBootFactory(
      dependencies.createAndroidColdBoot,
    );
    this.performanceSamplingCoordinator = resolvePerformanceSamplingCoordinator(dependencies);
  }

  private resolveAndroidClearAppDataFactory(
    factory: ((device: BootedDevice) => AndroidClearAppDataAction) | undefined,
  ): (device: BootedDevice) => AndroidClearAppDataAction {
    return (
      factory ??
      ((device) => new ClearAppData(device, undefined, { cacheInvalidator: this.cacheInvalidator }))
    );
  }

  private resolveAndroidColdBootFactory(
    factory: ((device: BootedDevice) => AndroidColdBootAction) | undefined,
  ): (device: BootedDevice) => AndroidColdBootAction {
    return factory ?? ((device) => new TerminateApp(device));
  }

  /**
   * Launch an app by package name - routes to platform-specific implementation
   * @param packageName - The package name to launch
   * @param clearAppData - Whether clear app data before launch
   * @param coldBoot - Whether to cold boot the app or resume if already running
   * @param activityName - Optional activity name to launch (Android only)
   * @param userId - Optional Android user ID (auto-detected if not provided)
   * @param skipUiStability - Whether to skip UI stability checks
   * @param launchEnvironment - `SIMCTL_CHILD_*` variables for a fresh iOS simulator process
   */
  async execute(packageName: string, launch: LaunchAppCall): Promise<LaunchAppResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    packageName: string,
    clearAppData: boolean,
    coldBoot: boolean,
    ...positional: [
      activityName?: string,
      userId?: number,
      skipUiStability?: boolean,
      signal?: AbortSignal,
      launchArguments?: string[],
      launchEnvironment?: Record<string, string>,
    ]
  ): Promise<LaunchAppResult>;
  async execute(
    packageName: string,
    clearAppDataOrCall: boolean | LaunchAppCall,
    ...positional: LaunchAppPositionalTail
  ): Promise<LaunchAppResult> {
    const [
      coldBoot,
      activityName,
      userId,
      skipUiStability,
      signal,
      launchArguments,
      launchEnvironment,
    ] = positional;
    const launch: LaunchAppCall =
      typeof clearAppDataOrCall === "object"
        ? clearAppDataOrCall
        : {
            clearAppData: clearAppDataOrCall,
            coldBoot: coldBoot ?? false,
            activityName,
            userId,
            skipUiStability,
            signal,
            launchArguments,
            launchEnvironment,
          };
    return this.executeLaunch(packageName, launch);
  }

  private async executeLaunch(
    packageName: string,
    {
      clearAppData,
      coldBoot,
      activityName,
      userId,
      skipUiStability,
      signal,
      launchArguments,
      launchEnvironment,
      intent,
    }: LaunchAppCall,
  ): Promise<LaunchAppResult> {
    logger.info("execute");
    signal?.throwIfAborted();
    if (intent && this.device.platform !== "android") {
      throw new ActionableError("intent is supported on Android only; use launchArguments on iOS.");
    }
    switch (this.device.platform) {
      case "ios":
        if (
          launchEnvironment !== undefined &&
          resolveIosDeviceKind({ deviceId: this.device.deviceId }) !== "simulator"
        ) {
          throw new ActionableError("A launch environment is supported on iOS simulators only.");
        }
        return this.executeiOS(packageName, clearAppData, coldBoot, {
          signal,
          processOptions: {
            launchArguments,
            launchEnvironment,
          },
        });
      case "android":
        if (launchArguments?.length) {
          throw new ActionableError(
            "launchArguments are supported on iOS only. On Android, pass intent (component, action, data, categories, extras, flags) instead.",
          );
        }
        if (launchEnvironment !== undefined) {
          throw new ActionableError("A launch environment is supported on iOS simulators only.");
        }
        return this.executeAndroidWithSamplingPriority({
          packageName,
          clearAppData,
          coldBoot,
          activityName,
          userId,
          skipUiStability,
          signal,
          intent,
        });
      default:
        throw unsupportedPlatformError(this.device.platform, "launch apps");
    }
  }

  private async executeAndroidWithSamplingPriority(
    options: AndroidLaunchOptions,
  ): Promise<LaunchAppResult> {
    return await this.performanceSamplingCoordinator.withDeviceSamplingPaused(
      this.device.deviceId,
      async () => await this.executeAndroid(options),
    );
  }

  /**
   * Launch an iOS app by bundle identifier
   * @param bundleId - The bundle identifier to launch
   * @param clearAppData - Whether to wipe the app's data container before launch (iOS simulator)
   * @param coldBoot - Whether to cold boot the app or resume if already running
   * @param processOptions - Arguments and simulator environment for a fresh process
   */
  private async executeiOS(
    bundleId: string,
    clearAppData: boolean,
    coldBoot: boolean,
    {
      signal,
      processOptions = {},
    }: { signal?: AbortSignal; processOptions?: IosLaunchProcessOptions } = {},
  ): Promise<LaunchAppResult> {
    const perf = this.performanceTrackerFactory();
    perf.serial("launchApp");

    return runWithNestedPerfTracker(perf, async () => {
      logger.info(`executeiOS bundleId ${bundleId}`);

      const result = await this.observedInteraction(
        async () =>
          new IosLaunchProcess({
            device: this.device,
            simctl: this.simctl,
            deviceAppLauncher: this.deviceAppLauncher,
            installedAppsProvider: this.installedAppsProvider,
            clearAppDataFactory: this.clearAppDataFactory,
            cacheInvalidator: this.cacheInvalidator,
            timer: this.timer,
            waitForIosHierarchyReady: (...args) => this.waitForIosHierarchyReady(...args),
          }).run({ bundleId, clearAppData, coldBoot, signal, processOptions, perf }),
        {
          ...OBSERVED_INTERACTION_PROFILES.appLaunch,
          perf,
          foregroundAppMayChange: true,
          // Use minTimestamp=0 so finalObserve returns cached hierarchy without a sync fetch.
          // iOS hierarchy timestamps (Swift Date) and TS timestamps (Date.now) are from
          // different clocks, causing minTimestamp checks to fail and force ~130ms round-trips.
          overrideMinTimestamp: 0,
          signal,
        },
      );

      signal?.throwIfAborted();
      const settledResult = await this.ensureLaunchObservationMatchesPackage(result, bundleId, {
        signal,
        coldBoot,
      });
      await this.captureTerminalObservationScreenshot(settledResult.observation, perf, signal);
      return settledResult;
    });
  }

  private async isInstalledOrLiveConfirmed(
    installedApps: string[],
    packageName: string,
    userId: number,
    { perf, signal }: { perf: PerformanceTracker; signal?: AbortSignal },
  ): Promise<boolean> {
    if (installedApps.includes(packageName)) {
      return true;
    }
    return perf.track("confirmInstalledLive", () =>
      this.confirmInstalledLive(packageName, userId, false, signal),
    );
  }

  /**
   * A listing may be served from the installed-apps cache, which an out-of-band
   * install (adb, Gradle) does not invalidate. Confirm a negative with one live
   * read before telling the caller the app is absent (#9976). The mirror case, a
   * cached "installed" for an app removed out of band, is confirmed by
   * {@link failFastWhenPackageRemoved} once the first launch attempt fails (#10192).
   */
  private async confirmInstalledLive(
    packageName: string,
    userId: number,
    cacheListedPackage: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.installedAppsCacheStaleMarker ??= new InstalledAppsRepository();
    return confirmAndroidPackageInstalledLive({
      adb: this.adb,
      deviceId: this.device.deviceId,
      packageName,
      userId,
      staleMarker: this.installedAppsCacheStaleMarker,
      cacheListedPackage,
      signal,
    });
  }

  /**
   * The cache said installed and the launcher intent was rejected with an `am`
   * error. That is also what a package removed outside the tools looks like, and
   * the remaining fallbacks (about a dozen adb calls) cannot launch it. One live
   * read settles it before they run; the success path never pays for it (#10192).
   * A failed read is not evidence either way, so the fallbacks still run.
   */
  private async failFastWhenPackageRemoved(
    packageName: string,
    userId: number,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<void> {
    let installed = true;
    try {
      installed = await perf.track("confirmInstalledAfterLaunchFailure", () =>
        this.confirmInstalledLive(packageName, userId, true, signal),
      );
    } catch (error) {
      this.assertLaunchNotAborted(signal);
      rethrowDeviceTransportUnavailable(error);
      logger.warn(
        `[LaunchApp] Could not confirm ${packageName} is still installed after the launcher intent failed: ${errorMessage(error)}`,
        error,
      );
    }
    if (!installed) {
      logger.error(`[LaunchApp] ${packageName} is no longer installed for user ${userId}`);
      throw new LaunchPackageRemovedError();
    }
  }

  private async detectTargetUserId(
    packageName: string,
    userId?: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const foregroundUser =
      userId === undefined ? await resolveSetupUser(this.adb, this.device) : undefined;
    if (foregroundUser !== undefined) {
      return foregroundUser;
    }
    const target = await new AndroidUserTargetResolver(this.adb).resolve({
      packageName,
      explicitUserId: userId,
      installedOnly: true,
      signal,
    });
    logger.info(`[LaunchApp] Using ${target.source}: user ${target.userId}`);
    return target.userId;
  }

  private async listInstalledApps(
    signal?: AbortSignal,
  ): Promise<{ apps: string[]; successful: boolean; error?: unknown }> {
    const list = new ListInstalledApps(this.device, this.adbFactory);
    if (this.device.platform === "ios") {
      const result = await list.executeIosDetailedResult();
      return {
        apps: result.apps
          .map((app) => getIosInstalledAppBundleId(app))
          .filter((bundleId): bundleId is string => bundleId !== undefined),
        successful: result.successful,
        error: result.error,
      };
    }
    const result = await list.executeDetailedResult(signal, { namesOnly: true });
    const apps = new Set<string>();
    for (const profileApps of Object.values(result.apps.profiles)) {
      for (const app of profileApps) {
        apps.add(app.packageName);
      }
    }
    for (const app of result.apps.system) {
      apps.add(app.packageName);
    }
    return { apps: Array.from(apps), successful: result.successful, error: result.error };
  }

  /**
   * Launch an Android app by package name
   * @param packageName - The package name to launch
   * @param clearAppData - Whether clear app data before launch
   * @param coldBoot - Whether to cold boot the app or resume if already running
   * @param activityName - Optional activity name to launch
   * @param userId - Optional Android user ID (auto-detected if not provided)
   * @param skipUiStability - Whether to skip UI stability checks
   */
  private async executeAndroid(options: AndroidLaunchOptions): Promise<LaunchAppResult> {
    const perf = this.performanceTrackerFactory();
    perf.serial("launchApp");

    return runWithNestedPerfTracker(perf, () => this.runAndroidLaunch(options, perf));
  }

  private async runAndroidLaunch(
    options: AndroidLaunchOptions,
    perf: PerformanceTracker,
  ): Promise<LaunchAppResult> {
    logger.info(`executeAndroid: ${options.packageName}`);
    const { targetUserId, installedApps } = await this.androidLaunchPreflight(options, perf);
    const missing = await this.checkAndroidInstallation(options, targetUserId, installedApps, perf);
    if (missing) {
      return missing;
    }
    const isRunning = await this.isAndroidAppRunning(options, targetUserId, perf);
    const preparation = await this.prepareAndroidProcess(options, targetUserId, isRunning, perf);
    if (preparation.failure) {
      return preparation.failure;
    }
    if (preparation.alreadyForeground && !options.intent) {
      return this.observeAlreadyForegroundAndroid(options, targetUserId, perf);
    }
    return this.launchNewAndroidProcess(options, targetUserId, perf);
  }

  private async androidLaunchPreflight(
    options: AndroidLaunchOptions,
    perf: PerformanceTracker,
  ): Promise<{ targetUserId: number; installedApps: string[] }> {
    const { packageName, userId, signal } = options;
    const preflight = Promise.allSettled([
      // Auto-detect target user if not specified
      perf.track("detectTargetUser", async () => {
        return this.targetUserDetector.detectTargetUserId(packageName, userId, signal);
      }),
      // Check app status (installation and running)
      perf.track("checkInstalled", async () => {
        return this.installedAppsProvider.listInstalledApps(signal);
      }),
    ]);
    const [targetUserResult, installedAppsResult] = await waitForAndroidPreflight(
      preflight,
      signal,
      this.timer,
    );
    signal?.throwIfAborted();

    if (targetUserResult.status === "rejected") {
      throw targetUserResult.reason;
    }
    if (installedAppsResult.status === "rejected") {
      throw installedAppsResult.reason;
    }

    const targetUserId = targetUserResult.value;
    const listing = installedAppsResult.value;
    if (!listing.successful) {
      throw toActionableError(
        listing.error ??
          new Error(
            `installed-app listing did not complete successfully for ${this.device.deviceId}`,
          ),
        `Could not determine whether ${packageName} is installed`,
      );
    }
    const installedApps = listing.apps;

    return { targetUserId, installedApps };
  }

  private async checkAndroidInstallation(
    options: AndroidLaunchOptions,
    targetUserId: number,
    installedApps: string[],
    perf: PerformanceTracker,
  ): Promise<LaunchAppResult | undefined> {
    const { packageName, signal } = options;
    logger.info(`[LaunchApp] Found ${installedApps.length} installed app(s)`);
    logger.info(`[LaunchApp] Looking for package: ${packageName}`);
    logger.info(`[LaunchApp] Installed apps: ${installedApps.join(", ")}`);
    if (
      !(await this.isInstalledOrLiveConfirmed(installedApps, packageName, targetUserId, {
        perf,
        signal,
      }))
    ) {
      logger.error(`[LaunchApp] App ${packageName} is not installed`);
      logger.error(`[LaunchApp] DEBUG: installedApps.length = ${installedApps.length}`);
      logger.error(`[LaunchApp] DEBUG: installedApps = [${installedApps.join(", ")}]`);
      perf.end();
      return {
        success: false,
        packageName: packageName,
        userId: targetUserId,
        error: PACKAGE_NOT_INSTALLED_ERROR,
      };
    }

    return undefined;
  }

  private async isAndroidAppRunning(
    options: AndroidLaunchOptions,
    targetUserId: number,
    perf: PerformanceTracker,
  ): Promise<boolean> {
    const { packageName, signal } = options;
    // Check if app is running
    const isRunning = await perf.track("checkRunning", async () => {
      const isRunningArgs = ["shell", "dumpsys", "activity", "processes"];
      logger.info(`[LaunchApp] Checking if app is running: ${isRunningArgs.join(" ")}`);
      const result = await readAndroidPackageProcesses(this.adb, packageName, {
        userId: targetUserId,
        signal,
        timer: this.timer,
      });
      logger.info(
        `[LaunchApp] App running: ${result.isRunning} (processes: ${JSON.stringify(result.processes)})`,
      );
      return result.isRunning;
    });
    this.assertLaunchNotAborted(signal);

    return isRunning;
  }

  private async clearAndroidData(
    options: AndroidLaunchOptions,
    targetUserId: number,
    perf: PerformanceTracker,
  ): Promise<LaunchAppResult | undefined> {
    const { packageName, signal } = options;
    const clearResult = await perf.track("clearAppData", async () => {
      return this.createAndroidClearAppData(this.device).execute(packageName, targetUserId);
    });
    this.assertLaunchNotAborted(signal);
    if (!clearResult.success) {
      const error = `Failed to clear app data: ${clearResult.error ?? "unknown error"}`;
      logger.warn(`[LaunchApp] Android clearAppData failed for ${packageName}: ${error}`);
      perf.end();
      return { success: false, packageName, userId: targetUserId, error };
    }

    return undefined;
  }

  private async stopAndroidForColdBoot(
    options: AndroidLaunchOptions,
    targetUserId: number,
    perf: PerformanceTracker,
  ): Promise<LaunchAppResult | undefined> {
    const { packageName, signal } = options;
    const coldBootResult = await perf.track("terminateApp", async () => {
      return this.createAndroidColdBoot(this.device).execute(packageName, {
        skipObservation: true,
        userId: targetUserId,
      });
    });
    this.assertLaunchNotAborted(signal);
    if (!coldBootResult.success) {
      const error = `Cold boot could not stop ${packageName}: ${coldBootResult.error ?? "unknown error"}`;
      logger.warn(`[LaunchApp] ${error}`);
      perf.end();
      return { success: false, packageName, userId: targetUserId, error };
    }

    return undefined;
  }

  private async checkAndroidAlreadyForeground(
    options: AndroidLaunchOptions,
    targetUserId: number,
    perf: PerformanceTracker,
  ): Promise<boolean | null> {
    const { packageName, signal } = options;
    // Check if app is in foreground - use getForegroundApp which returns user context
    const foregroundApp = await perf.track(`checkForeground`, async () => {
      return this.adb.getForegroundApp();
    });
    this.assertLaunchNotAborted(signal);

    const alreadyForeground =
      foregroundApp &&
      foregroundApp.packageName === packageName &&
      foregroundApp.userId === targetUserId;

    if (alreadyForeground) {
      logger.info(
        `[LaunchApp] App ${packageName} is already in foreground in user ${targetUserId}`,
      );
    }
    return alreadyForeground;
  }

  private async prepareAndroidProcess(
    options: AndroidLaunchOptions,
    targetUserId: number,
    isRunning: boolean,
    perf: PerformanceTracker,
  ): Promise<{ failure?: LaunchAppResult; alreadyForeground?: boolean | null }> {
    const { packageName, clearAppData, coldBoot } = options;
    let didTerminateOrClear = false;
    if (clearAppData) {
      const failure = await this.clearAndroidData(options, targetUserId, perf);
      if (failure) {
        return { failure };
      }
      didTerminateOrClear = isRunning;
    } else if (isRunning && coldBoot) {
      const failure = await this.stopAndroidForColdBoot(options, targetUserId, perf);
      if (failure) {
        return { failure };
      }
      didTerminateOrClear = true;
    }
    const alreadyForeground =
      isRunning && !didTerminateOrClear
        ? await this.checkAndroidAlreadyForeground(options, targetUserId, perf)
        : false;
    // A new process cannot retain the SDK screen identity of the previous one.
    if (!isRunning || didTerminateOrClear) {
      this.cacheInvalidator.retireAppProcess(this.device, packageName);
    }
    return { alreadyForeground };
  }

  private async observeAlreadyForegroundAndroid(
    options: AndroidLaunchOptions,
    targetUserId: number,
    perf: PerformanceTracker,
  ): Promise<LaunchAppResult> {
    const { packageName, activityName, skipUiStability, signal, coldBoot } = options;
    // "Make this app foreground" is a goal, not a transition: the goal already
    // holds, so this is a success flagged with `alreadyForeground` — not an
    // error a client has to string-match to decide whether to continue, which
    // also discarded the observation a launch normally returns (issue #6868).
    const result = await this.observedInteraction(
      async () => {
        perf.end();
        return {
          success: true,
          alreadyForeground: true,
          packageName,
          activityName,
          userId: targetUserId,
        };
      },
      {
        ...OBSERVED_INTERACTION_PROFILES.appLaunch,
        perf,
        packageName,
        signal,
        skipUiStability: skipUiStability ?? false,
      },
    );
    // The foreground read and this observation are two separate device reads,
    // so another app or a system surface can take over in between. Reconcile
    // through the SAME validation the launch path uses rather than asserting
    // `alreadyForeground: true` over a capture of a different app, which
    // `buildLaunchAppResponse` would surface as a clean success with a
    // mismatched `observedAppId` and no error (issue #6868 review).
    const settledResult = await this.ensureLaunchObservationMatchesPackage(result, packageName, {
      timeoutMs: ANDROID_LAUNCH_OBSERVATION_TIMEOUT_MS,
      signal,
      coldBoot,
      expectedUserId: targetUserId,
    });
    await this.captureTerminalObservationScreenshot(settledResult.observation, perf, signal);
    return settledResult;
  }

  private async launchNewAndroidProcess(
    options: AndroidLaunchOptions,
    targetUserId: number,
    perf: PerformanceTracker,
  ): Promise<LaunchAppResult> {
    const { packageName, clearAppData, coldBoot, activityName, skipUiStability, signal, intent } =
      options;
    logger.info(`[LaunchApp] Proceeding with app launch`);
    this.assertLaunchNotAborted(signal);

    const captureDisplayedMetrics = serverConfig.isUiPerfModeEnabled();
    logger.info(
      `[LaunchApp] captureDisplayedMetrics=${captureDisplayedMetrics} (isUiPerfModeEnabled)`,
    );
    const displayedMetricsCollector = captureDisplayedMetrics
      ? new DisplayedTimeMetricsCollector(this.device, this.adbFactory)
      : null;
    let displayedMetricsStartMs: number | null = null;

    const foregroundWaitTimeoutMs = LAUNCH_OBSERVATION_TIMEOUT_MS;
    const foregroundPollIntervalMs = LAUNCH_OBSERVATION_POLL_INTERVAL_MS;
    let observationTimestampMs: number | undefined;

    const launchResult = await this.observedInteraction<LaunchAppResult>(
      async () => {
        if (displayedMetricsCollector) {
          displayedMetricsStartMs = await perf.track("displayedLogcatStartTime", () =>
            this.adb.getDeviceTimestampMs(),
          );
        }
        const launchOutcome = await this.performLaunch(packageName, activityName, targetUserId, {
          perf,
          options: { signal, intent },
        });
        signal?.throwIfAborted();
        const foregroundReady = await this.waitForAppForeground(packageName, targetUserId, {
          timeoutMs: foregroundWaitTimeoutMs,
          pollIntervalMs: foregroundPollIntervalMs,
          perf,
          signal,
        });
        if (!foregroundReady) {
          logger.warn(
            `[LaunchApp] ${packageName} did not become the foreground app before observation; continuing to validate launch observation`,
          );
        }
        observationTimestampMs = await this.adb.getDeviceTimestampMs();
        return launchOutcome;
      },
      {
        ...OBSERVED_INTERACTION_PROFILES.appLaunch,
        perf,
        skipUiStability: skipUiStability ?? false,
        packageName,
        foregroundAppMayChange: true,
        observationTimestampProvider: () => observationTimestampMs,
        signal,
      },
    ).catch((error: unknown) => {
      if (error instanceof LaunchPackageRemovedError) {
        perf.end();
        return { success: false, packageName, userId: targetUserId, error: error.message };
      }
      throw error;
    });

    signal?.throwIfAborted();
    if (!launchResult.success && launchResult.error === PACKAGE_NOT_INSTALLED_ERROR) {
      return launchResult;
    }
    const settledLaunchResult = await this.ensureLaunchObservationMatchesPackage(
      launchResult,
      packageName,
      {
        timeoutMs: ANDROID_LAUNCH_OBSERVATION_TIMEOUT_MS,
        signal,
        coldBoot,
        expectedUserId: targetUserId,
      },
    );
    if (clearAppData && settledLaunchResult.success && settledLaunchResult.observation) {
      await this.waitForAndroidColdStableFrame(settledLaunchResult, packageName, signal);
    }
    await this.captureTerminalObservationScreenshot(settledLaunchResult.observation, perf, signal);

    await this.captureAndroidDisplayedMetrics({
      packageName,
      displayedMetricsCollector,
      displayedMetricsStartMs,
      settledLaunchResult,
      perf,
    });
    return settledLaunchResult;
  }

  private async captureAndroidDisplayedMetrics({
    packageName,
    displayedMetricsCollector,
    displayedMetricsStartMs,
    settledLaunchResult,
    perf,
  }: {
    packageName: string;
    displayedMetricsCollector: DisplayedTimeMetricsCollector | null;
    displayedMetricsStartMs: number | null;
    settledLaunchResult: LaunchAppResult;
    perf: PerformanceTracker;
  }): Promise<void> {
    logger.info(
      `[LaunchApp] TTI capture check: collector=${!!displayedMetricsCollector}, startMs=${displayedMetricsStartMs}, hasObservation=${!!settledLaunchResult?.observation}`,
    );
    if (
      displayedMetricsCollector &&
      displayedMetricsStartMs !== null &&
      settledLaunchResult?.observation
    ) {
      const displayedMetricsEndMs = await perf.track("displayedLogcatEndTime", () =>
        this.adb.getDeviceTimestampMs(),
      );
      logger.info(
        `[LaunchApp] Capturing displayed metrics: startMs=${displayedMetricsStartMs}, endMs=${displayedMetricsEndMs}`,
      );
      const displayedTimeMetrics = await displayedMetricsCollector.captureDisplayedMetrics(
        {
          packageName,
          startTimestampMs: displayedMetricsStartMs,
          endTimestampMs: displayedMetricsEndMs,
        },
        perf,
      );
      logger.info(`[LaunchApp] Captured ${displayedTimeMetrics.length} displayed metrics`);
      settledLaunchResult.observation.displayedTimeMetrics = displayedTimeMetrics;

      // Store TTI for the performance monitor to report
      // Use the first displayed metric as the TTI (time to first frame / interactive)
      if (displayedTimeMetrics.length > 0) {
        const firstMetric = displayedTimeMetrics[0];
        setLastTtiMs(this.device.deviceId, packageName, firstMetric.displayedTimeMs);
        logger.info(
          `[LaunchApp] Recorded TTI for ${packageName}: ${firstMetric.displayedTimeMs}ms`,
        );
      } else {
        logger.info(`[LaunchApp] No displayed metrics found for ${packageName}`);
      }
    } else {
      logger.info(`[LaunchApp] Skipping TTI capture - conditions not met`);
    }
  }

  private async waitForAndroidColdStableFrame(
    result: LaunchAppResult,
    packageName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = this.timer.now() + ANDROID_COLD_FRAME_TIMEOUT_MS;
    const timeout = new Error("Android cold frame readiness timed out");
    let previousHash: string | null = null;

    while (this.timer.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const remainingMs = deadline - this.timer.now();
        const observation = await raceWithDeadline(
          () =>
            this.observeScreen.execute({
              freshness: "fresh",
              timeoutMs: remainingMs,
              signal,
              skipScreenshot: true,
              skipAccessibilityAudit: true,
              skipPerformanceAudit: true,
            }),
          {
            timer: this.timer,
            timeoutMs: remainingMs,
            signal,
            label: "Android cold frame readiness",
            timeoutError: () => timeout,
          },
        );
        const matchesPackage = this.launchObservationMatchesPackage(observation, packageName);
        const hash = matchesPackage ? hierarchyFingerprint(observation.viewHierarchy) : null;
        if (matchesPackage) {
          result.observation = observation;
        }
        if (hash !== null && hash === previousHash) {
          return;
        }
        previousHash = hash;
      } catch (error) {
        signal?.throwIfAborted();
        logger.warn(
          `[LaunchApp] Android cold frame readiness failed: ${errorMessage(error)}`,
          error,
        );
        return;
      }

      const remainingMs = deadline - this.timer.now();
      if (remainingMs > 0) {
        await this.timer.sleep(Math.min(ANDROID_COLD_FRAME_POLL_MS, remainingMs));
      }
    }
    logger.warn(`[LaunchApp] Android cold frame readiness timed out for ${packageName}`);
  }

  private assertLaunchNotAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
  }

  private launchObservation(): LaunchObservation {
    return new LaunchObservation({
      device: this.device,
      adb: this.adb,
      timer: this.timer,
      observeScreen: this.observeScreen,
      cacheInvalidator: this.cacheInvalidator,
    });
  }
  /** Reconciles the launch result against foreground and task evidence. Kept public for callers and test fakes. */
  async ensureLaunchObservationMatchesPackage(
    ...args: Parameters<LaunchObservation["ensureLaunchObservationMatchesPackage"]>
  ): Promise<LaunchAppResult> {
    return this.launchObservation().ensureLaunchObservationMatchesPackage(...args);
  }

  private launchObservationMatchesPackage(
    observation: ObserveResult,
    packageName: string,
  ): boolean {
    return this.launchObservation().launchObservationMatchesPackage(observation, packageName);
  }
  /** Runs the ordered Android launch fallbacks. Kept public for callers and test fakes. */
  async performLaunch(
    ...args: Parameters<AndroidLaunchActivity["performLaunch"]>
  ): ReturnType<AndroidLaunchActivity["performLaunch"]> {
    return new AndroidLaunchActivity({
      device: this.device,
      adb: this.adb,
      failFastWhenPackageRemoved: (...args) => this.failFastWhenPackageRemoved(...args),
    }).performLaunch(...args);
  }

  private waitForAppForeground(
    ...args: Parameters<LaunchForegroundWait["waitForAppForeground"]>
  ): Promise<boolean> {
    return new LaunchForegroundWait({ adb: this.adb, timer: this.timer }).waitForAppForeground(
      ...args,
    );
  }
  /** Waits for the launched iOS app hierarchy via push or sync. Kept public for callers and test fakes. */
  async waitForIosHierarchyReady(
    ...args: Parameters<IosLaunchHierarchy["waitForIosHierarchyReady"]>
  ): Promise<void> {
    return new IosLaunchHierarchy({
      device: this.device,
      timer: this.timer,
    }).waitForIosHierarchyReady(...args);
  }
}
