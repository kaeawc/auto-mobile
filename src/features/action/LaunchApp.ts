import { unsupportedPlatformError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { BaseVisualChange } from "./BaseVisualChange";
import {
  BootedDevice,
  ClearAppDataResult,
  LaunchAppResult,
  TerminateAppResult,
} from "../../models";
import { ActionableError } from "../../models";
import {
  DefaultDeviceWindowCacheInvalidator,
  DeviceWindowCacheInvalidator,
  TerminateApp,
} from "./TerminateApp";
import { ClearAppData } from "./ClearAppData";
import { logger } from "../../utils/logger";
import { adbFailureOutput } from "../../utils/android-cmdline-tools/adbFailureOutput";
import { ListInstalledApps } from "../observe/ListInstalledApps";
import { InstalledAppsRepository } from "../../db/installedAppsRepository";
import {
  confirmAndroidPackageInstalledLive,
  type InstalledAppsCacheStaleMarker,
} from "./confirmAndroidPackageInstalledLive";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { resolveIosLaunchBackend } from "../../utils/ios-cmdline-tools/IosDeviceBackend";
import { createGlobalPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { runWithNestedPerfTracker } from "../../utils/PerfContext";
import {
  getPerformanceMonitor,
  type PerformanceSamplingCoordinator,
} from "../performance/PerformanceMonitor";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient } from "../observe/ios";
import { IOSCtrlProxyManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import { errorMessage } from "../../utils/describeUnknownError";
import { shellQuote } from "../../utils/shellQuote";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { getIosInstalledAppBundleId } from "../../utils/ios-cmdline-tools/iosInstalledApp";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import type { ActionCall } from "./ActionCall";
import {
  LaunchPackageRemovedError,
  PACKAGE_NOT_INSTALLED_ERROR,
} from "./LaunchPackageRemovedError";
import { OBSERVED_INTERACTION_PROFILES } from "./observedInteractionProfiles";

import {
  checkColdIosAppNotInstalled,
  launchColdIosProcess,
  launchWarmIosProcess,
  needsIosColdStart,
  type IosLaunchProcessOptions,
} from "./launchApp/iosLaunchProcess";
import {
  prepareAndroidLaunchProcess,
  resolveAndroidLaunchInstalledApps,
} from "./launchApp/androidLaunchPreparation";
import { observeAndroidAppLaunch } from "./launchApp/androidLaunchObservation";
import {
  LAUNCH_OBSERVATION_TIMEOUT_MS,
  LAUNCH_OBSERVATION_POLL_INTERVAL_MS,
  IOS_HIERARCHY_READY_TIMEOUT_MS,
  ANDROID_LAUNCH_OBSERVATION_TIMEOUT_MS,
  ANDROID_PREFLIGHT_ABORT_SETTLEMENT_GRACE_MS,
  IOS_RETARGET_ABORT_SETTLEMENT_GRACE_MS,
  ANDROID_COLD_FRAME_TIMEOUT_MS,
  ANDROID_COLD_FRAME_POLL_MS,
} from "./launchAppConstants";
import { LaunchAppActivityResolver } from "./LaunchAppActivityResolver";
import { LaunchAppIosHierarchyWaiter } from "./LaunchAppIosHierarchyWaiter";
import { LaunchForegroundWaiter } from "./LaunchForegroundWaiter";
import { LaunchObservationVerifier } from "./LaunchObservationVerifier";

export function amStartReportedFailure(stdout: string, stderr: string): boolean {
  return (
    /^Error(?::| type \d+)/m.test(`${stdout}\n${stderr}`) ||
    /does not exist/i.test(`${stdout}\n${stderr}`)
  );
}

export interface TargetUserDetector {
  detectTargetUserId(packageName: string, userId?: number, signal?: AbortSignal): Promise<number>;
}

export interface InstalledAppsProvider {
  listInstalledApps(
    signal?: AbortSignal,
  ): Promise<{ apps: string[]; successful: boolean; error?: unknown }>;
}

export interface IosClearAppDataRunner {
  execute(bundleId: string): Promise<ClearAppDataResult>;
}

export interface AndroidClearAppDataAction {
  execute(packageName: string, userId?: number): Promise<ClearAppDataResult>;
}

export interface AndroidColdBootAction {
  execute(
    packageName: string,
    options?: { skipObservation?: boolean; userId?: number },
  ): Promise<TerminateAppResult>;
}

/**
 * Launch an app on a physical iOS device via devicectl. Narrow injection point
 * so tests never shell out; parallels `DeviceAppUninstaller` in UninstallApp.
 * Implemented by `DeviceAppManager`. `terminateExisting` provides cold-boot
 * relaunch (terminate + fresh process); there is no standalone device terminate
 * here because devicectl cannot reliably resolve a PID by bundle id (deferred).
 */
/** The narrow simctl surface LaunchApp consumes; lets tests pass a typed fake (#11865). */
export type LaunchAppSimctl = Pick<
  SimCtlClient,
  "launchApp" | "terminateApp" | "executeCommandArgs" | "listAppsOrThrow"
>;

export interface DeviceAppLauncher {
  launchApp(
    deviceUdid: string,
    bundleId: string,
    options?: { terminateExisting?: boolean; launchArguments?: string[] },
  ): Promise<{ success: boolean; pid?: number; error?: string }>;
}

interface LaunchAppDependencies {
  targetUserDetector?: TargetUserDetector;
  installedAppsProvider?: InstalledAppsProvider;
  /** Marks the installed-apps cache stale when a live check contradicts it (#9976). */
  installedAppsCacheStaleMarker?: InstalledAppsCacheStaleMarker;
  performanceTrackerFactory?: () => PerformanceTracker;
  deviceAppLauncher?: DeviceAppLauncher;
  clearAppDataFactory?: (device: BootedDevice, simctl: LaunchAppSimctl) => IosClearAppDataRunner;
  createAndroidClearAppData?: (device: BootedDevice) => AndroidClearAppDataAction;
  createAndroidColdBoot?: (device: BootedDevice) => AndroidColdBootAction;
  cacheInvalidator?: DeviceWindowCacheInvalidator;
  performanceSamplingCoordinator?: PerformanceSamplingCoordinator;
}

function resolvePerformanceSamplingCoordinator(
  dependencies: LaunchAppDependencies,
): PerformanceSamplingCoordinator {
  return dependencies.performanceSamplingCoordinator ?? getPerformanceMonitor();
}

interface AndroidLaunchOptions {
  packageName: string;
  clearAppData: boolean;
  coldBoot: boolean;
  activityName?: string;
  userId?: number;
  skipUiStability?: boolean;
  signal?: AbortSignal;
}

/** Launch request for {@link LaunchApp.execute}: what to launch and how, beside the call context. */
export interface LaunchAppCall extends ActionCall {
  clearAppData: boolean;
  coldBoot: boolean;
  /** Activity name to launch (Android only). */
  activityName?: string;
  /** Android user ID (auto-detected if not provided). */
  userId?: number;
  skipUiStability?: boolean;
  launchArguments?: string[];
  /** `SIMCTL_CHILD_*` variables for a fresh iOS simulator process. */
  launchEnvironment?: Record<string, string>;
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
  private readonly launcherActivities: LaunchAppActivityResolver;
  private readonly iosHierarchyWaiter: LaunchAppIosHierarchyWaiter;
  private readonly launchObservation: LaunchObservationVerifier;
  private readonly foregroundWaiter: LaunchForegroundWaiter;
  /**
   * Create an LaunchApp instance
   * @param device - Optional device
   * @param adb - Optional ADB executor for testing
   * @param simctl - Optional SimCtlClient instance for testing
   * @param timer - Optional Timer instance for testing
   */
  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    simctl: LaunchAppSimctl | null = null,
    timer: Timer = defaultTimer,
    dependencies: LaunchAppDependencies = {},
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
    const context = () => ({
      device: this.device,
      adb: this.adb,
      timer: this.timer,
      observeScreen: this.observeScreen,
      cacheInvalidator: this.cacheInvalidator,
    });
    this.launcherActivities = new LaunchAppActivityResolver(context);
    this.iosHierarchyWaiter = new LaunchAppIosHierarchyWaiter(context);
    this.launchObservation = new LaunchObservationVerifier(context);
    this.foregroundWaiter = new LaunchForegroundWaiter(context);
  }

  /** Polls until the observed foreground matches the launched package or the observation timeout elapses. Public test seam (#11865). */
  ensureLaunchObservationMatchesPackage(
    ...args: Parameters<LaunchObservationVerifier["ensureLaunchObservationMatchesPackage"]>
  ) {
    return this.launchObservation.ensureLaunchObservationMatchesPackage(...args);
  }

  waitForIosHierarchyReady(
    ...args: Parameters<LaunchAppIosHierarchyWaiter["waitForIosHierarchyReady"]>
  ) {
    return this.iosHierarchyWaiter.waitForIosHierarchyReady(...args);
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
  async execute(packageName: string, launch: LaunchAppCall): Promise<LaunchAppResult> {
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
    }: LaunchAppCall,
  ): Promise<LaunchAppResult> {
    logger.info("execute");
    signal?.throwIfAborted();
    switch (this.device.platform) {
      case "ios":
        if (
          launchEnvironment !== undefined &&
          resolveIosDeviceKind({ deviceId: this.device.deviceId }) !== "simulator"
        ) {
          throw new ActionableError("A launch environment is supported on iOS simulators only.");
        }
        return this.executeiOS(packageName, clearAppData, coldBoot, signal, {
          launchArguments,
          launchEnvironment,
        });
      case "android":
        if (launchArguments?.length) {
          throw new ActionableError(
            "launchArguments are supported on iOS only. Android launch intent extras require a separate interface.",
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
        });
      default:
        throw unsupportedPlatformError(this.device.platform, "launch apps");
    }
  }

  private async executeAndroidWithSamplingPriority(
    options: AndroidLaunchOptions,
  ): Promise<LaunchAppResult> {
    const { packageName, clearAppData, coldBoot, activityName, userId, skipUiStability, signal } =
      options;
    return await this.performanceSamplingCoordinator.withDeviceSamplingPaused(
      this.device.deviceId,
      async () =>
        await this.executeAndroid({
          packageName,
          clearAppData,
          coldBoot,
          activityName,
          userId,
          skipUiStability,
          signal,
        }),
    );
  }

  private isTrustworthyIosColdAppListing(apps: string[]): boolean {
    // Both listers include system apps. Missing Settings means an empty or
    // partial inventory cannot establish absence before attempting a launch.
    return apps.includes("com.apple.Preferences");
  }

  private async checkIosAppNotInstalled(
    bundleId: string,
    perf: PerformanceTracker,
    signal?: AbortSignal,
    coldPrecheck = false,
  ): Promise<LaunchAppResult | undefined> {
    const installedAppsResult = await perf.track("checkInstalled", () =>
      this.installedAppsProvider.listInstalledApps(signal),
    );
    this.assertLaunchNotAborted(signal);
    if (coldPrecheck && !this.isTrustworthyIosColdAppListing(installedAppsResult.apps)) {
      return undefined;
    }
    if (installedAppsResult.successful && !installedAppsResult.apps.includes(bundleId)) {
      logger.info("App is not installed");
      return { success: false, packageName: bundleId, error: "App is not installed" };
    }
    return undefined;
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
    signal?: AbortSignal,
    processOptions: IosLaunchProcessOptions = {},
  ): Promise<LaunchAppResult> {
    const { launchArguments } = processOptions;
    const perf = this.performanceTrackerFactory();
    perf.serial("launchApp");

    return runWithNestedPerfTracker(perf, async () => {
      logger.info(`executeiOS bundleId ${bundleId}`);

      const isSystemBundleId = bundleId.startsWith("com.apple.");

      const result = await this.observedInteraction(
        async () => {
          this.assertLaunchNotAborted(signal);
          // Clearing app data always implies a fresh process: the app is
          // terminated, its sandbox wiped, then relaunched. Treat it as a cold
          // boot so we go through the terminate → clearCache → launch path.
          // Arguments and the environment are consumed only when a new app process starts.
          const needsColdStart = needsIosColdStart(coldBoot, clearAppData, processOptions);

          // Simulators launch/terminate via simctl; physical devices via devicectl
          // (parity with installApp/uninstallApp). Resolve once so cold and warm
          // paths agree on the transport.
          const backend = resolveIosLaunchBackend(this.device.deviceId, {
            simctl: this.simctl,
            deviceAppLauncher: this.deviceAppLauncher,
          });
          const simulator = backend.kind === "simulator";

          // Reject missing apps before termination, data clearing, or CtrlProxy
          // targeting only with a trustworthy inventory. Unknown IDs cannot
          // safely use the physical lister: its routing differs from launch.
          const checkInstalled = this.checkIosAppNotInstalled.bind(this);
          const missingApp = await checkColdIosAppNotInstalled({
            needsColdStart,
            isSystemBundleId,
            device: this.device,
            bundleId,
            perf,
            signal,
            checkInstalled,
          });
          if (missingApp) {
            perf.end();
            return missingApp;
          }

          // Set bundle ID before starting CtrlProxy so it targets the app, not SpringBoard
          if (!isSystemBundleId) {
            IOSCtrlProxyManager.getInstance(this.device).setTargetBundleId(bundleId);
          }
          const ctrlProxyClient = IOSCtrlProxyClient.getInstance(this.device);

          const launchOutcome = needsColdStart
            ? await launchColdIosProcess({
                device: this.device,
                bundleId,
                clearAppData,
                isSystemBundleId,
                perf,
                signal,
                processOptions,
                backend,
                simctl: this.simctl,
                ctrlProxyClient,
                clearAppDataFactory: this.clearAppDataFactory.bind(this),
                terminateBeforeLaunch: this.iosHierarchyWaiter.terminateIosAppBeforeLaunch.bind(
                  this.iosHierarchyWaiter,
                ),
              })
            : await launchWarmIosProcess({
                bundleId,
                isSystemBundleId,
                perf,
                signal,
                backend,
                launchArguments,
                checkInstalled,
              });
          if (launchOutcome.kind === "failed") {
            return launchOutcome.result;
          }
          const launchResult = launchOutcome.result;

          if (launchResult.error) {
            perf.end();
            return {
              success: false,
              packageName: bundleId,
              error: launchResult.error,
            };
          }

          if (simulator) {
            // A resident CtrlProxy runner may still be tracking SpringBoard from
            // daemon startup. simctl foregrounds the app but cannot replace the
            // runner's XCUIApplication target, so synchronize that target through
            // the runner before requiring an app-specific hierarchy.
            signal?.throwIfAborted();
            const { retargetAbortController, retarget } =
              this.iosHierarchyWaiter.requestIosLaunchRetarget(ctrlProxyClient, bundleId, perf);
            const ctrlProxyLaunchResult = await this.waitForIosRetarget(
              retarget,
              retargetAbortController,
              signal,
            );
            this.assertLaunchNotAborted(signal);
            if (!ctrlProxyLaunchResult.success) {
              perf.end();
              return {
                success: false,
                packageName: bundleId,
                error: ctrlProxyLaunchResult.error ?? "CtrlProxy failed to track the launched app",
              };
            }
          }

          signal?.throwIfAborted();
          await perf.track("waitForHierarchy", () =>
            this.iosHierarchyWaiter.waitForIosHierarchyReady(
              IOS_HIERARCHY_READY_TIMEOUT_MS,
              bundleId,
              signal,
            ),
          );
          perf.end();
          return {
            success: true,
            packageName: bundleId,
            pid: launchResult.pid,
          };
        },
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
      const settledResult = await this.launchObservation.ensureLaunchObservationMatchesPackage(
        result,
        bundleId,
        undefined,
        undefined,
        signal,
        { coldBoot },
      );
      await this.captureTerminalObservationScreenshot(settledResult.observation, perf, signal);
      return settledResult;
    });
  }

  private async isInstalledOrLiveConfirmed(
    installedApps: string[],
    packageName: string,
    userId: number,
    perf: PerformanceTracker,
    signal?: AbortSignal,
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
    const { packageName, clearAppData, coldBoot, activityName, userId, skipUiStability, signal } =
      options;
    const perf = this.performanceTrackerFactory();
    perf.serial("launchApp");

    return runWithNestedPerfTracker(perf, () =>
      this.runAndroidLaunch(
        { packageName, clearAppData, coldBoot, activityName, userId, skipUiStability, signal },
        perf,
      ),
    );
  }

  private async runAndroidLaunch(
    options: AndroidLaunchOptions,
    perf: PerformanceTracker,
  ): Promise<LaunchAppResult> {
    const { packageName, clearAppData, coldBoot, activityName, userId, skipUiStability, signal } =
      options;
    logger.info(`executeAndroid: ${packageName}`);

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
    const [targetUserResult, installedAppsResult] = await this.waitForAndroidPreflight(
      preflight,
      signal,
    );
    signal?.throwIfAborted();

    if (targetUserResult.status === "rejected") {
      throw targetUserResult.reason;
    }
    const targetUserId = targetUserResult.value;
    const installedApps = resolveAndroidLaunchInstalledApps({
      installedAppsResult,
      deviceId: this.device.deviceId,
      packageName,
    });
    if (
      !(await this.isInstalledOrLiveConfirmed(
        installedApps,
        packageName,
        targetUserId,
        perf,
        signal,
      ))
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

    const preparation = await prepareAndroidLaunchProcess({
      device: this.device,
      packageName,
      targetUserId,
      clearAppData,
      coldBoot,
      perf,
      signal,
      adb: this.adb,
      timer: this.timer,
      createClearAppData: this.createAndroidClearAppData.bind(this),
      createColdBoot: this.createAndroidColdBoot.bind(this),
    });
    if ("failure" in preparation) {
      return preparation.failure;
    }
    const { isRunning, didTerminateOrClear, alreadyForeground } = preparation;

    // A launch from not-running, or after a terminate/clear, starts a new process: the SDK route
    // the last one reported no longer names its screen.
    if (!isRunning || didTerminateOrClear) {
      this.cacheInvalidator.retireAppProcess(this.device, packageName);
    }

    return observeAndroidAppLaunch({
      device: this.device,
      adb: this.adb,
      adbFactory: this.adbFactory,
      packageName,
      targetUserId,
      activityName,
      clearAppData,
      skipUiStability,
      signal,
      perf,
      alreadyForeground,
      observedInteraction: this.observedInteraction.bind(this),
      performLaunch: () =>
        this.performLaunch(packageName, activityName, targetUserId, perf, signal),
      waitForForeground: () =>
        this.foregroundWaiter.waitForAppForeground(
          packageName,
          targetUserId,
          LAUNCH_OBSERVATION_TIMEOUT_MS,
          LAUNCH_OBSERVATION_POLL_INTERVAL_MS,
          perf,
          signal,
        ),
      settleObservation: (result) =>
        this.launchObservation.ensureLaunchObservationMatchesPackage(
          result,
          packageName,
          ANDROID_LAUNCH_OBSERVATION_TIMEOUT_MS,
          undefined,
          signal,
          { coldBoot, expectedUserId: targetUserId },
        ),
      captureScreenshot: (observation) =>
        this.captureTerminalObservationScreenshot(observation, perf, signal),
      waitForColdFrame: (result) => this.waitForAndroidColdStableFrame(result, packageName, signal),
    });
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
        const matchesPackage = this.launchObservation.launchObservationMatchesPackage(
          observation,
          packageName,
        );
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

  private async waitForAndroidPreflight<T>(
    preflight: Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (!signal) {
      return await preflight;
    }
    try {
      signal.throwIfAborted();
      return await raceWithDeadline(preflight, {
        timer: this.timer,
        signal,
        label: "Android preflight",
        relabelDefaultAbort: false,
      });
    } catch (error) {
      await this.awaitAndroidPreflightSettlement(preflight);
      throw error;
    }
  }

  private async waitForIosRetarget<T>(
    retarget: Promise<T>,
    requestAbortController: AbortController,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (!signal) {
      return await retarget;
    }
    try {
      signal.throwIfAborted();
      return await raceWithDeadline(retarget, {
        timer: this.timer,
        signal,
        label: "iOS retarget",
        relabelDefaultAbort: false,
      });
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
      const settled = await this.awaitPromiseSettlement(
        retarget,
        IOS_RETARGET_ABORT_SETTLEMENT_GRACE_MS,
      );
      if (!settled) {
        requestAbortController.abort(signal.reason);
        await retarget.catch(() => undefined);
      }
      throw error;
    }
  }

  private async awaitPromiseSettlement(
    promise: Promise<unknown>,
    gracePeriodMs: number,
  ): Promise<boolean> {
    let settled = false;
    const timeout = new Error("Promise settlement grace expired");
    try {
      await raceWithDeadline(
        promise.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        ),
        {
          timer: this.timer,
          timeoutMs: gracePeriodMs,
          label: "Promise settlement",
          timeoutError: () => timeout,
        },
      );
    } catch (error) {
      if (error !== timeout) {
        throw error;
      }
    }
    return settled;
  }

  private async awaitAndroidPreflightSettlement(preflight: Promise<unknown>): Promise<void> {
    const timeout = new Error("Android preflight settlement grace expired");
    try {
      await raceWithDeadline(
        preflight.then(
          () => undefined,
          () => undefined,
        ),
        {
          timer: this.timer,
          timeoutMs: ANDROID_PREFLIGHT_ABORT_SETTLEMENT_GRACE_MS,
          label: "Android preflight settlement",
          timeoutError: () => timeout,
        },
      );
    } catch (error) {
      if (error !== timeout) {
        throw error;
      }
    }
  }

  /**
   * Perform the actual app launch with timing
   */
  private assertLaunchNotAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
  }

  private async tryAndroidIntentLaunch(
    packageName: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; amReportedError?: boolean }> {
    logger.info(`[LaunchApp] Trying am start with intent for user ${userId}`);
    try {
      const component = await this.launcherActivities.resolveAndroidLauncherComponent(
        packageName,
        userId,
        signal,
      );
      this.assertLaunchNotAborted(signal);
      const launcherTarget = component ? `-n ${shellQuote(component)}` : shellQuote(packageName);
      const intentCmd = `shell am start --user ${userId} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${launcherTarget}`;
      logger.info(`[LaunchApp] Intent command: ${intentCmd}`);
      const result = await this.adb.executeCommand(intentCmd);
      this.assertLaunchNotAborted(signal);
      // am start may report launch errors on stderr while still returning exit code 0.
      if (result.stdout && !result.stdout.includes("Error") && !result.stderr.includes("Error")) {
        logger.info(`[LaunchApp] Intent launch completed successfully`);
        return { success: true };
      }
      logger.info(`[LaunchApp] Intent launch returned error: ${result.stdout}${result.stderr}`);
      // Classified from am's own output; the echoed intent (and its package) is not searched.
      return {
        success: false,
        amReportedError: amStartReportedFailure(result.stdout, result.stderr),
      };
    } catch (error) {
      this.assertLaunchNotAborted(signal);
      logger.warn(
        `[LaunchApp] Intent launch failed: ${errorMessage(error)}, falling back to monkey`,
      );
      // A non-zero exit from `am start` rejects the call; classify am's own output, not the
      // message, so a transport failure (no output of its own) is not read as an am error.
      const output = adbFailureOutput(error);
      return {
        success: false,
        amReportedError: amStartReportedFailure(output.stdout, output.stderr),
      };
    }
  }

  private async tryAndroidMonkeyLaunch(
    packageName: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<{ success: boolean }> {
    logger.info(`[LaunchApp] Trying monkey launch (fallback approach) for user ${userId}`);
    try {
      const monkeyCmd = `shell monkey -p ${shellQuote(packageName)} -c android.intent.category.LAUNCHER 1`;
      logger.info(`[LaunchApp] Monkey command: ${monkeyCmd}`);
      const result = await this.adb.executeCommand(monkeyCmd);
      this.assertLaunchNotAborted(signal);
      if (
        /No activities found to run|[Mm]onkey aborted/.test(`${result.stdout}\n${result.stderr}`)
      ) {
        logger.info(`[LaunchApp] Monkey launch reported no activity`);
        return { success: false };
      }
      logger.info(`[LaunchApp] Monkey launch completed successfully`);
      return { success: true };
    } catch (error) {
      this.assertLaunchNotAborted(signal);
      logger.warn(
        `[LaunchApp] Monkey launch failed: ${errorMessage(error)}, falling back to activity discovery`,
      );
      return { success: false };
    }
  }

  /** Android launch step: intent launch, then monkey/activity fallback. Public test seam (#11865). */
  async performLaunch(
    packageName: string,
    activityName: string | undefined,
    userId: number,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; packageName: string; activityName?: string; userId: number }> {
    this.assertLaunchNotAborted(signal);
    let targetActivity = activityName;

    // Try am start with intent first (alternative to monkey)
    if (!targetActivity) {
      const intentResult = await perf.track("intentLaunch", () =>
        this.tryAndroidIntentLaunch(packageName, userId, signal),
      );
      this.assertLaunchNotAborted(signal);

      if (intentResult.success) {
        perf.end();
        return {
          success: true,
          packageName,
          activityName: "intent_launch",
          userId,
        };
      }
      if (intentResult.amReportedError) {
        await this.failFastWhenPackageRemoved(packageName, userId, perf, signal);
      }
    }

    // Try monkey launch as fallback (fast but less reliable)
    if (!targetActivity) {
      if (userId !== 0) {
        logger.info(
          `[LaunchApp] Skipping monkey for user ${userId}: monkey cannot target a user; continuing to activity discovery`,
        );
      } else {
        const monkeyResult = await perf.track("monkeyLaunch", () =>
          this.tryAndroidMonkeyLaunch(packageName, userId, signal),
        );
        this.assertLaunchNotAborted(signal);

        if (monkeyResult.success) {
          perf.end();
          return {
            success: true,
            packageName,
            activityName: "monkey_launch",
            userId,
          };
        }
      }
    }

    // If no specific activity provided, get launcher activities from pm dump
    if (!targetActivity) {
      const launcherActivities = await perf.track("extractLauncherActivities", async () => {
        logger.info(`[LaunchApp] No activity specified, extracting launcher activities`);
        return this.launcherActivities.extractLauncherActivities(packageName, userId, perf, signal);
      });
      this.assertLaunchNotAborted(signal);

      if (launcherActivities.length > 0) {
        targetActivity = launcherActivities[0];
        logger.info(`[LaunchApp] Using first found activity: ${targetActivity}`);
      } else {
        // Try common activity name patterns
        const patternResult = await perf.track("tryCommonPatterns", async () => {
          logger.info(`[LaunchApp] No launcher activities found, trying common patterns`);
          const commonPatterns = [
            `${packageName}.MainActivity`,
            `${packageName}.ui.MainActivity`,
            `${packageName}.main.MainActivity`,
            `${packageName}.activity.MainActivity`,
            `${packageName}.LauncherActivity`,
            `${packageName}.MainLauncherActivity`,
          ];

          for (const pattern of commonPatterns) {
            this.assertLaunchNotAborted(signal);
            try {
              logger.info(`[LaunchApp] Trying common pattern: ${pattern}`);
              const result = await this.adb.executeCommand(
                `shell am start --user ${userId} -n ${shellQuote(`${packageName}/${pattern}`)}`,
              );
              this.assertLaunchNotAborted(signal);
              if (amStartReportedFailure(result.stdout, result.stderr)) {
                logger.info(`[LaunchApp] Pattern ${pattern} reported an activity error`);
                continue;
              }
              logger.info(`[LaunchApp] Successfully launched with pattern: ${pattern}`);
              return { success: true, pattern };
            } catch (error) {
              this.assertLaunchNotAborted(signal);
              logger.info(`[LaunchApp] Pattern ${pattern} failed: ${error}`);
            }
          }
          return { success: false, pattern: null };
        });
        this.assertLaunchNotAborted(signal);

        if (patternResult.success && patternResult.pattern) {
          perf.end();
          return {
            success: true,
            packageName,
            activityName: patternResult.pattern,
            userId,
          };
        }
      }
    }

    // Launch with specific activity if found, otherwise use default method
    if (targetActivity) {
      await perf.track("launchActivity", async () => {
        logger.info(`[LaunchApp] Launching with activity: ${targetActivity} for user ${userId}`);
        const launchCmd = `shell am start --user ${userId} -n ${shellQuote(`${packageName}/${targetActivity}`)}`;
        logger.info(`[LaunchApp] Launch command: ${launchCmd}`);
        await this.adb.executeCommand(launchCmd);
        this.assertLaunchNotAborted(signal);
        logger.info(`[LaunchApp] Launch command completed successfully`);
      });
    } else {
      // Fallback to launcher intent
      await perf.track("launcherIntent", async () => {
        logger.info(`[LaunchApp] No activity found, trying launcher intent for user ${userId}`);
        try {
          const launcherCmd = `shell am start --user ${userId} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${shellQuote(packageName)}`;
          logger.info(`[LaunchApp] Launcher intent command: ${launcherCmd}`);
          const result = await this.adb.executeCommand(launcherCmd);
          this.assertLaunchNotAborted(signal);
          if (amStartReportedFailure(result.stdout, result.stderr)) {
            throw new ActionableError("No launcher activity found and launcher intent failed");
          }
          logger.info(`[LaunchApp] Launcher intent completed successfully`);
        } catch (error) {
          this.assertLaunchNotAborted(signal);
          logger.error(`[LaunchApp] Launcher intent failed: ${error}`);
          throw new ActionableError("No launcher activity found and launcher intent failed");
        }
      });
    }

    logger.info(`[LaunchApp] Launch completed successfully`);
    perf.end();
    return {
      success: true,
      packageName,
      activityName: targetActivity,
      userId,
    };
  }
}
