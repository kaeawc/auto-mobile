import { toActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { BaseVisualChange } from "./BaseVisualChange";
import {
  BootedDevice,
  ClearAppDataResult,
  DeviceLockState,
  LaunchAppResult,
  ObserveResult,
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
import { resolveMissingForegroundWindow } from "../observe/ObserveScreen";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { resolveIosColdAppCheckKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import {
  resolveIosLaunchBackend,
  resolveIosColdStartTerminateBackend,
} from "../../utils/ios-cmdline-tools/IosDeviceBackend";
import { createGlobalPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { runWithNestedPerfTracker } from "../../utils/PerfContext";
import { DisplayedTimeMetricsCollector } from "../performance/DisplayedTimeMetricsCollector";
import {
  getPerformanceMonitor,
  setLastTtiMs,
  type PerformanceSamplingCoordinator,
} from "../performance/PerformanceMonitor";
import { serverConfig } from "../../utils/ServerConfig";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient } from "../observe/ios";
import { IOSCtrlProxyManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import { AndroidCtrlProxyClient } from "../observe/android";
import { readAndroidPackageProcesses } from "../../utils/android-cmdline-tools/androidProcessState";
import { errorMessage } from "../../utils/describeUnknownError";
import { shellQuote } from "../../utils/shellQuote";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { getIosInstalledAppBundleId } from "../../utils/ios-cmdline-tools/iosInstalledApp";
import {
  getLaunchObservationPackageNames,
  isLaunchPermissionDialogObservation,
} from "./launchObservationPackages";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import {
  parseLauncherActivities,
  parseLauncherActivitiesFromPackageDump,
  resolveComponentActivity,
} from "./launcherActivityParsing";

const LAUNCH_OBSERVATION_TIMEOUT_MS = 5000;
const LAUNCH_OBSERVATION_POLL_INTERVAL_MS = 200;
const ANDROID_LAUNCH_OBSERVATION_TIMEOUT_MS = 15_000;
const SHADE_COLLAPSE_RETRY_INTERVAL_MS = 1_000;
// One bounded lock re-read before a launch timeout names a SystemUI blocker (#10182).
const LAUNCH_BLOCKER_LOCK_REREAD_TIMEOUT_MS = 3_000;
const ANDROID_PREFLIGHT_ABORT_SETTLEMENT_GRACE_MS = 1_000;
const IOS_RETARGET_ABORT_SETTLEMENT_GRACE_MS = 1_000;
const ANDROID_COLD_FRAME_TIMEOUT_MS = 2_500;
const ANDROID_COLD_FRAME_POLL_MS = 150;

export function amStartReportedFailure(stdout: string, stderr: string): boolean {
  return (
    /^Error(?::| type \d+)/m.test(`${stdout}\n${stderr}`) ||
    /does not exist/i.test(`${stdout}\n${stderr}`)
  );
}

const PACKAGE_NOT_INSTALLED_ERROR = "App is not installed";

/** Raised inside the launch action when a live read shows the package was removed (#10192). */
class LaunchPackageRemovedError extends ActionableError {
  constructor() {
    super(PACKAGE_NOT_INSTALLED_ERROR);
  }
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
  clearAppDataFactory?: (device: BootedDevice, simctl: SimCtlClient) => IosClearAppDataRunner;
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

export class LaunchApp extends BaseVisualChange {
  private simctl: SimCtlClient;
  private deviceAppLauncher: DeviceAppLauncher;
  private targetUserDetector: TargetUserDetector;
  private installedAppsProvider: InstalledAppsProvider;
  private installedAppsCacheStaleMarker: InstalledAppsCacheStaleMarker | undefined;
  private performanceTrackerFactory: () => PerformanceTracker;
  private clearAppDataFactory: (
    device: BootedDevice,
    simctl: SimCtlClient,
  ) => IosClearAppDataRunner;
  private createAndroidClearAppData: (device: BootedDevice) => AndroidClearAppDataAction;
  private createAndroidColdBoot: (device: BootedDevice) => AndroidColdBootAction;
  private cacheInvalidator: DeviceWindowCacheInvalidator;
  private performanceSamplingCoordinator: PerformanceSamplingCoordinator;
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
    simctl: SimCtlClient | null = null,
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
   * Extract launcher activities using targeted adb command
   * @param packageName - Package name we're trying to launch
   * @param userId - Android user the launcher query targets
   * @param perf - Optional performance tracker
   * @returns Array of launcher activity names
   */
  private async extractLauncherActivities(
    packageName: string,
    userId: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[]> {
    this.assertLaunchNotAborted(signal);
    logger.info("extractLauncherActivities");
    const resolvedActivities = await this.tryResolveViaCtrlProxy(packageName, perf, signal);
    if (resolvedActivities) {
      return resolvedActivities;
    }
    const activities: string[] = [];

    try {
      logger.info(`[LaunchApp] Extracting launcher activities for ${packageName}`);
      const approaches = this.buildActivityApproachCommands(packageName, userId);
      for (let i = 0; i < approaches.length; i++) {
        this.assertLaunchNotAborted(signal);
        activities.push(
          ...(await this.runActivityApproach(approaches[i], i, packageName, perf, signal)),
        );
        if (activities.length > 0) {
          break;
        }
      }

      if (activities.length === 0) {
        this.assertLaunchNotAborted(signal);
        logger.info(`[LaunchApp] No activities found, trying fallback approach`);
        activities.push(...(await this.runActivityFallback(packageName, perf, signal)));
      }
    } catch (error) {
      this.assertLaunchNotAborted(signal);
      logger.warn(`[LaunchApp] Failed to extract launcher activities for ${packageName}:`, error);
    }

    logger.info(`[LaunchApp] Final activities list: [${activities.join(", ")}]`);
    return activities;
  }

  private async tryResolveViaCtrlProxy(
    packageName: string,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[] | undefined> {
    // Try the WebSocket-backed PackageManager launch intent first.
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const result = perf
        ? await perf.track("a11yLaunchIntent", () => a11y.requestLaunchIntent(packageName, 3000))
        : await a11y.requestLaunchIntent(packageName, 3000);
      this.assertLaunchNotAborted(signal);
      if (result.success && result.componentName) {
        const activity = resolveComponentActivity(result.componentName, packageName);
        if (activity !== undefined) {
          logger.info(`[LaunchApp] Resolved launcher activity via a11y: ${activity}`);
          return [activity];
        }
      }
    } catch (error) {
      this.assertLaunchNotAborted(signal);
      logger.debug(`[LaunchApp] a11y launch intent failed, falling back to ADB: ${error}`);
    }
    return undefined;
  }

  private buildActivityApproachCommands(packageName: string, userId: number): string[] {
    return [
      // Ask PackageManager for MAIN/LAUNCHER activities before parsing a full dump.
      `shell cmd package query-activities --brief --user ${userId} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER | grep ${shellQuote(packageName)}`,
    ];
  }

  private async runActivityApproach(
    command: string,
    index: number,
    packageName: string,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[]> {
    try {
      logger.info(`[LaunchApp] Trying approach ${index + 1}: ${command}`);
      const result = perf
        ? await perf.track(`activityApproach_${index + 1}`, () =>
            this.adb.executeCommand(command, undefined, undefined, undefined, signal),
          )
        : await this.adb.executeCommand(command, undefined, undefined, undefined, signal);
      this.assertLaunchNotAborted(signal);
      logger.info(
        `[LaunchApp] Approach ${index + 1} result: ${result.stdout.length} chars of output`,
      );
      const activities = parseLauncherActivities(result.stdout, packageName);
      if (activities.length > 0) {
        logger.info(
          `[LaunchApp] Successfully found ${activities.length} activities using approach ${index + 1}`,
        );
      }
      return activities;
    } catch (error) {
      this.assertLaunchNotAborted(signal);
      logger.warn(`[LaunchApp] Approach ${index + 1} failed:`, error);
    }
    return [];
  }

  private async runActivityFallback(
    packageName: string,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[]> {
    try {
      const simpleResult = perf
        ? await perf.track("activityFallback", () =>
            this.adb.executeCommand(
              `shell pm dump ${shellQuote(packageName)}`,
              undefined,
              undefined,
              undefined,
              signal,
            ),
          )
        : await this.adb.executeCommand(
            `shell pm dump ${shellQuote(packageName)}`,
            undefined,
            undefined,
            undefined,
            signal,
          );
      this.assertLaunchNotAborted(signal);
      const activities = parseLauncherActivitiesFromPackageDump(simpleResult.stdout, packageName);
      for (const activity of activities) {
        logger.info(`[LaunchApp] Added fallback activity: ${activity}`);
      }
      return activities;
    } catch (error) {
      this.assertLaunchNotAborted(signal);
      logger.warn(`[LaunchApp] Fallback approach failed:`, error);
    }
    return [];
  }

  /**
   * Launch an app by package name - routes to platform-specific implementation
   * @param packageName - The package name to launch
   * @param clearAppData - Whether clear app data before launch
   * @param coldBoot - Whether to cold boot the app or resume if already running
   * @param activityName - Optional activity name to launch (Android only)
   * @param userId - Optional Android user ID (auto-detected if not provided)
   * @param skipUiStability - Whether to skip UI stability checks
   */
  async execute(
    packageName: string,
    clearAppData: boolean,
    coldBoot: boolean,
    activityName?: string,
    userId?: number,
    skipUiStability?: boolean,
    signal?: AbortSignal,
    launchArguments?: string[],
  ): Promise<LaunchAppResult> {
    logger.info("execute");
    signal?.throwIfAborted();
    switch (this.device.platform) {
      case "ios":
        return this.executeiOS(packageName, clearAppData, coldBoot, signal, launchArguments);
      case "android":
        if (launchArguments?.length) {
          throw new ActionableError(
            "launchArguments are supported on iOS only. Android launch intent extras require a separate interface.",
          );
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
   */
  private async executeiOS(
    bundleId: string,
    clearAppData: boolean,
    coldBoot: boolean,
    signal?: AbortSignal,
    launchArguments?: string[],
  ): Promise<LaunchAppResult> {
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
          // Arguments are consumed only when a new app process starts.
          const needsColdStart = coldBoot || clearAppData || Boolean(launchArguments?.length);

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
          if (
            needsColdStart &&
            !isSystemBundleId &&
            resolveIosColdAppCheckKind(this.device) !== undefined
          ) {
            const missingApp = await this.checkIosAppNotInstalled(bundleId, perf, signal, true);
            if (missingApp) {
              perf.end();
              return missingApp;
            }
          }

          // Set bundle ID before starting CtrlProxy so it targets the app, not SpringBoard
          if (!isSystemBundleId) {
            IOSCtrlProxyManager.getInstance(this.device).setTargetBundleId(bundleId);
          }
          const ctrlProxyClient = IOSCtrlProxyClient.getInstance(this.device);

          let launchResult: { success: boolean; pid?: number; error?: string };

          if (needsColdStart) {
            // Cold boot: use simctl (simulator) / devicectl (device) directly.
            // XCUIApplication.launch() is slow for heavy apps (10s+ timeout) while
            // simctl launch completes in ~500ms. CtrlProxy's value is in the
            // activate() fast path, not cold boot.
            const terminator = resolveIosColdStartTerminateBackend(this.device.deviceId, {
              simctl: this.simctl,
            });
            if (terminator) {
              // simctl launch does not terminate an already-running instance, so
              // terminate first for cold-boot semantics. Physical devices skip this:
              // the devicectl launch below passes `--terminate-existing`, which is
              // the authoritative cold-boot relaunch (an explicit pre-terminate
              // would add a redundant round-trip).
              await perf.track("terminateApp", () =>
                this.terminateIosAppBeforeLaunch(terminator, bundleId),
              );
              this.assertLaunchNotAborted(signal);
            }

            // Wipe the app's data container (fastest iOS "clear data": no reinstall,
            // keeps permission grants). System bundles (com.apple.*) are skipped —
            // we never want to wipe SpringBoard/Settings data.
            if (clearAppData && !isSystemBundleId) {
              const clearResult = await perf.track("clearAppData", () =>
                this.clearAppDataFactory(this.device, this.simctl).execute(bundleId),
              );
              this.assertLaunchNotAborted(signal);
              if (!clearResult.success) {
                // Do NOT launch with stale data — callers request clearAppData to
                // guarantee a clean launch. Fail loudly instead of silently
                // reporting success on an un-cleared app.
                const error = `Failed to clear app data: ${clearResult.error ?? "unknown error"}`;
                logger.warn(`[LaunchApp] iOS clearAppData failed for ${bundleId}: ${error}`);
                perf.end();
                return { success: false, packageName: bundleId, error };
              }
            } else if (clearAppData && isSystemBundleId) {
              logger.warn(`[LaunchApp] Ignoring clearAppData for system bundle ${bundleId}`);
            }

            // Re-wire CtrlProxy to the (re)launched app. The bundle is already
            // re-targeted above (setTargetBundleId); after a data wipe the app gets
            // a brand-new process, so drop the cached hierarchy too — otherwise
            // waitForIosHierarchyReady returns stale pre-terminate data via the
            // cache fast path. clearCache() nulls the cache entirely, which is what we
            // need here: invalidateCache() (fixed in #4193) forces a refetch, but the
            // invalidated entry is still served as a stale fallback if that refetch
            // fails — and pre-terminate data for a wiped app must never be served.
            ctrlProxyClient.clearCache();
            IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.clearSdkScreenIdentity(
              bundleId,
            );
            launchResult = await perf.track("launch", () =>
              backend.launchApp(bundleId, { foregroundIfRunning: false, launchArguments }),
            );
            this.assertLaunchNotAborted(signal);
          } else {
            // Warm launch. Simulator: simctl launch foregrounds a backgrounded app
            // and is faster than the CtrlProxy WebSocket round-trip (~4-5s). Device:
            // devicectl has no foreground verb, so relaunch via --terminate-existing.
            launchResult = await perf.track("launch", () =>
              backend.launchApp(bundleId, { launchArguments }),
            );
            this.assertLaunchNotAborted(signal);

            if (!launchResult.success) {
              logger.warn(`[LaunchApp] launch failed: ${launchResult.error ?? "unknown error"}`);
            }

            // Only check installed apps on the fallback path, and only on
            // simulators — simctl listapps is slow (~2s) and returns nothing for
            // a physical device, where devicectl's launch error is authoritative.
            if (!launchResult.success && !isSystemBundleId && simulator) {
              const missingApp = await this.checkIosAppNotInstalled(bundleId, perf, signal);
              if (missingApp) {
                perf.end();
                return missingApp;
              }
            }
          }

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
            const { retargetAbortController, retarget } = this.requestIosLaunchRetarget(
              ctrlProxyClient,
              bundleId,
              perf,
            );
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
            this.waitForIosHierarchyReady(60000, bundleId, signal),
          );
          perf.end();
          return {
            success: true,
            packageName: bundleId,
            pid: launchResult.pid,
          };
        },
        {
          changeExpected: false,
          perf,
          skipPreviousObserve: true,
          foregroundAppMayChange: true,
          // Use minTimestamp=0 so finalObserve returns cached hierarchy without a sync fetch.
          // iOS hierarchy timestamps (Swift Date) and TS timestamps (Date.now) are from
          // different clocks, causing minTimestamp checks to fail and force ~130ms round-trips.
          overrideMinTimestamp: 0,
          deferPostActionScreenshot: true,
          signal,
        },
      );

      signal?.throwIfAborted();
      const settledResult = await this.ensureLaunchObservationMatchesPackage(
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

  private requestIosLaunchRetarget(
    ctrlProxyClient: IOSCtrlProxyClient,
    bundleId: string,
    perf: PerformanceTracker,
  ) {
    const retargetAbortController = new AbortController();
    const retarget = ctrlProxyClient.requestLaunchApp(
      bundleId,
      undefined,
      perf,
      false,
      retargetAbortController.signal,
    );
    return { retargetAbortController, retarget };
  }

  private async terminateIosAppBeforeLaunch(
    terminator: NonNullable<ReturnType<typeof resolveIosColdStartTerminateBackend>>,
    bundleId: string,
  ): Promise<void> {
    try {
      await terminator.terminateApp(bundleId);
    } catch (error) {
      // Cold-start cleanup may find no running app; launching still proceeds.
      logger.debug(`[LaunchApp] Pre-launch termination unavailable: ${errorMessage(error)}`);
    } finally {
      this.cacheInvalidator.invalidate(this.device);
    }
  }

  private requestIosHierarchyForPackage(
    xcTestClient: IOSCtrlProxyClient,
    expectedPackageName: string,
    timeoutMs: number,
  ): Promise<string> {
    return xcTestClient
      .requestHierarchySync(undefined, true, undefined, timeoutMs)
      .then((result) => {
        const pkg = (result?.hierarchy as { packageName?: string } | null)?.packageName;
        if (pkg === expectedPackageName) {
          return "sync";
        }
        // A sync can race the app's first hierarchy push and still return the
        // previous foreground app. Keep waiting for that push or the real
        // timeout instead of letting "wrong app" win the race immediately.
        return new Promise<never>(() => {});
      })
      .catch((err) => {
        logger.warn(`[LaunchApp] iOS hierarchy sync failed during race: ${err}`);
        // A transient sync failure is not terminal while the push listener is
        // still active. The timeout promise remains the readiness bound.
        return new Promise<never>(() => {});
      });
  }

  private isCachedIosHierarchyReady(
    cachedPackageName: string | undefined,
    expectedPackageName?: string,
  ): boolean {
    return Boolean(
      cachedPackageName && (!expectedPackageName || cachedPackageName === expectedPackageName),
    );
  }

  private clearIosHierarchyTimeout(timeoutHandle: NodeJS.Timeout | undefined): void {
    if (timeoutHandle) {
      this.timer.clearTimeout(timeoutHandle);
    }
  }

  private async waitForIosHierarchyReady(
    timeoutMs: number = 5000,
    expectedPackageName?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const xcTestClient = IOSCtrlProxyClient.getInstance(this.device);
    const startTime = this.timer.now();

    // Fast path: if cache already has the correct app's hierarchy, skip the round-trip.
    // This makes warm launches (app already foreground) ~0ms instead of ~133ms.
    const cached = await xcTestClient.getLatestHierarchy(false, 0, undefined, true, 0);
    const cachedPkg = (cached?.hierarchy as { packageName?: string } | null)?.packageName;
    if (this.isCachedIosHierarchyReady(cachedPkg, expectedPackageName)) {
      logger.info(
        `[LaunchApp] iOS hierarchy already cached (pkg=${cachedPkg}, ${this.timer.now() - startTime}ms)`,
      );
      return;
    }

    // Race a push listener against a forced sync request. Push notifications only
    // fire for unsolicited hierarchy_update messages (periodic pushes), while sync
    // responses go through requestManager.resolve() without notifying push listeners.
    // By racing both, we resolve as soon as either path delivers the correct app.
    if (expectedPackageName) {
      let pushUnsubscribe: (() => void) | undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const pushPromise = new Promise<string>((resolve) => {
        timeoutHandle = this.timer.setTimeout(() => resolve("timeout"), timeoutMs);
        pushUnsubscribe = xcTestClient.onPushUpdate((hierarchy) => {
          if (hierarchy.packageName === expectedPackageName) {
            resolve("push");
          }
        });
      });

      const syncPromise = this.requestIosHierarchyForPackage(
        xcTestClient,
        expectedPackageName,
        timeoutMs,
      );

      let winner: string;
      try {
        winner = await raceWithDeadline([pushPromise, syncPromise], {
          timer: this.timer,
          signal,
          label: "iOS hierarchy readiness",
          relabelDefaultAbort: false,
        });
        signal?.throwIfAborted();
      } finally {
        pushUnsubscribe?.();
        this.clearIosHierarchyTimeout(timeoutHandle);
      }

      if (winner === "push" || winner === "sync") {
        logger.info(
          `[LaunchApp] iOS hierarchy ready via ${winner} after ${this.timer.now() - startTime}ms (pkg=${expectedPackageName})`,
        );

        return;
      }
    } else {
      // No expected packageName — just do one forced sync to get any hierarchy
      try {
        await xcTestClient.requestHierarchySync(undefined, true, undefined, timeoutMs);
        logger.info(`[LaunchApp] iOS hierarchy ready after ${this.timer.now() - startTime}ms`);
        return;
      } catch (error) {
        logger.warn(`[LaunchApp] iOS hierarchy sync failed: ${errorMessage(error)}`);
      }
    }

    logger.warn(
      `[LaunchApp] Timed out waiting for iOS hierarchy after ${timeoutMs}ms (expected=${expectedPackageName})`,
    );
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
    logger.info(`[LaunchApp] Found ${installedApps.length} installed app(s)`);
    logger.info(`[LaunchApp] Looking for package: ${packageName}`);
    logger.info(`[LaunchApp] Installed apps: ${installedApps.join(", ")}`);
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

    let didTerminateOrClear = false;
    let alreadyForeground: boolean | null = false;

    if (isRunning) {
      if (clearAppData) {
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
        didTerminateOrClear = true;
      } else if (coldBoot) {
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
        didTerminateOrClear = true;
      }

      // Skip foreground check if we just terminated or cleared - we know app is not in foreground
      if (!didTerminateOrClear) {
        // Check if app is in foreground - use getForegroundApp which returns user context
        const foregroundApp = await perf.track(`checkForeground`, async () => {
          return this.adb.getForegroundApp();
        });
        this.assertLaunchNotAborted(signal);

        alreadyForeground =
          foregroundApp &&
          foregroundApp.packageName === packageName &&
          foregroundApp.userId === targetUserId;

        if (alreadyForeground) {
          logger.info(
            `[LaunchApp] App ${packageName} is already in foreground in user ${targetUserId}`,
          );
        }
      }
    } else {
      if (clearAppData) {
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
      }
    }

    if (alreadyForeground) {
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
          changeExpected: false,
          perf,
          packageName,
          signal,
          skipPreviousObserve: true,
          skipUiStability: skipUiStability ?? false,
          deferPostActionScreenshot: true,
        },
      );
      // The foreground read and this observation are two separate device reads,
      // so another app or a system surface can take over in between. Reconcile
      // through the SAME validation the launch path uses rather than asserting
      // `alreadyForeground: true` over a capture of a different app, which
      // `buildLaunchAppResponse` would surface as a clean success with a
      // mismatched `observedAppId` and no error (issue #6868 review).
      const settledResult = await this.ensureLaunchObservationMatchesPackage(
        result,
        packageName,
        ANDROID_LAUNCH_OBSERVATION_TIMEOUT_MS,
        undefined,
        signal,
        { coldBoot, expectedUserId: targetUserId },
      );
      await this.captureTerminalObservationScreenshot(settledResult.observation, perf, signal);
      return settledResult;
    }

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

    const foregroundWaitTimeoutMs = 5000;
    const foregroundPollIntervalMs = 200;
    let observationTimestampMs: number | undefined;

    const launchResult = await this.observedInteraction(
      async () => {
        if (displayedMetricsCollector) {
          displayedMetricsStartMs = await perf.track("displayedLogcatStartTime", () =>
            this.adb.getDeviceTimestampMs(),
          );
        }
        const launchOutcome = await this.performLaunch(
          packageName,
          activityName,
          targetUserId,
          perf,
          signal,
        );
        signal?.throwIfAborted();
        const foregroundReady = await this.waitForAppForeground(
          packageName,
          targetUserId,
          foregroundWaitTimeoutMs,
          foregroundPollIntervalMs,
          perf,
          signal,
        );
        if (!foregroundReady) {
          logger.warn(
            `[LaunchApp] ${packageName} did not become the foreground app before observation; continuing to validate launch observation`,
          );
        }
        observationTimestampMs = await this.adb.getDeviceTimestampMs();
        return launchOutcome;
      },
      {
        changeExpected: false,
        perf,
        skipPreviousObserve: true,
        skipUiStability: skipUiStability ?? false,
        packageName,
        foregroundAppMayChange: true,
        observationTimestampProvider: () => observationTimestampMs,
        deferPostActionScreenshot: true,
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
      ANDROID_LAUNCH_OBSERVATION_TIMEOUT_MS,
      undefined,
      signal,
      { coldBoot, expectedUserId: targetUserId },
    );
    if (clearAppData && settledLaunchResult.success && settledLaunchResult.observation) {
      await this.waitForAndroidColdStableFrame(settledLaunchResult, packageName, signal);
    }
    await this.captureTerminalObservationScreenshot(settledLaunchResult.observation, perf, signal);

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

    return settledLaunchResult;
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

  private async ensureLaunchObservationMatchesPackage(
    result: LaunchAppResult,
    expectedPackageName: string,
    timeoutMs: number = LAUNCH_OBSERVATION_TIMEOUT_MS,
    pollIntervalMs: number = LAUNCH_OBSERVATION_POLL_INTERVAL_MS,
    signal: AbortSignal | undefined,
    options: { coldBoot?: boolean; expectedUserId?: number },
  ): Promise<LaunchAppResult> {
    const { coldBoot, expectedUserId } = options;
    signal?.throwIfAborted();
    result = await this.collapseNotificationShadeIfCovering(result, signal);
    if (
      !result.observation ||
      this.launchObservationMatchesPackage(result.observation, expectedPackageName)
    ) {
      return result;
    }

    if (!result.success) {
      return this.withoutStaleLaunchObservation(result, expectedPackageName, result.observation);
    }

    if (
      this.settleLaunchObservation(result, result.observation, expectedPackageName, expectedUserId)
    ) {
      return result;
    }

    const startTime = this.timer.now();
    let latestObservation = result.observation;
    // Space collapse attempts by one second to avoid an ADB command on every poll.
    let nextShadeCollapseTime = startTime + SHADE_COLLAPSE_RETRY_INTERVAL_MS;

    while (this.timer.now() - startTime < timeoutMs) {
      signal?.throwIfAborted();
      logger.info(
        `[LaunchApp] Launch observation still reports previous app; re-observing for ${expectedPackageName}`,
      );
      await this.timer.sleep(pollIntervalMs);
      latestObservation = await this.observeScreen.execute({
        freshness: "fresh",
        signal,
        skipScreenshot: true,
        skipAccessibilityAudit: true,
        // These are control-flow polls, not user-authored observations. Running
        // the opt-in performance audit here starts its multi-sample ADB loop on
        // every poll, so one 15-second package reconciliation can expand into
        // effectively unbounded sampling and prevent launch from returning.
        skipPerformanceAudit: true,
      });
      signal?.throwIfAborted();
      const collapseRetry = await this.retryNotificationShadeCollapseIfDue(
        result,
        latestObservation,
        expectedPackageName,
        nextShadeCollapseTime,
        signal,
      );
      latestObservation = collapseRetry.observation;
      nextShadeCollapseTime = collapseRetry.nextShadeCollapseTime;
      if (
        this.settleLaunchObservation(result, latestObservation, expectedPackageName, expectedUserId)
      ) {
        return result;
      }
    }

    return this.resolveLaunchObservationTimeout(
      result,
      latestObservation,
      expectedPackageName,
      timeoutMs,
      { coldBoot, expectedUserId, signal },
    );
  }

  private async retryNotificationShadeCollapseIfDue(
    result: LaunchAppResult,
    observation: ObserveResult,
    expectedPackageName: string,
    nextShadeCollapseTime: number,
    signal?: AbortSignal,
  ): Promise<{ observation: ObserveResult; nextShadeCollapseTime: number }> {
    const activeWindow = observation.activeWindow;
    if (
      this.device.platform !== "android" ||
      activeWindow?.appId !== "com.android.systemui" ||
      activeWindow.systemOverlay !== true ||
      this.launchObservationMatchesPackage(observation, expectedPackageName) ||
      this.timer.now() < nextShadeCollapseTime
    ) {
      return { observation, nextShadeCollapseTime };
    }

    const collapseResult = await this.collapseNotificationShadeIfCovering(
      { ...result, observation },
      signal,
    );
    return {
      observation: collapseResult.observation ?? observation,
      nextShadeCollapseTime: this.timer.now() + SHADE_COLLAPSE_RETRY_INTERVAL_MS,
    };
  }

  private async collapseNotificationShadeIfCovering(
    result: LaunchAppResult,
    signal?: AbortSignal,
  ): Promise<LaunchAppResult> {
    const activeWindow = result.observation?.activeWindow;
    if (
      this.device.platform !== "android" ||
      activeWindow?.appId !== "com.android.systemui" ||
      activeWindow.systemOverlay !== true
    ) {
      return result;
    }

    try {
      await this.adb.executeCommand(
        "shell cmd statusbar collapse",
        undefined,
        undefined,
        undefined,
        combineWithAmbientAbort(signal),
      );
    } catch (error) {
      logger.warn(
        `[LaunchApp] Failed to collapse notification shade: ${errorMessage(error)}`,
        error,
      );
      return result;
    }

    try {
      const observation = await this.observeScreen.execute({
        freshness: "fresh",
        signal,
        skipScreenshot: true,
        skipAccessibilityAudit: true,
        skipPerformanceAudit: true,
      });
      return {
        ...result,
        observation: this.preserveLaunchObservationMetadata(
          observation,
          result.observation ?? observation,
        ),
      };
    } catch (error) {
      logger.warn(
        `[LaunchApp] Failed to re-observe after collapsing notification shade: ${errorMessage(error)}`,
        error,
      );
      return result;
    }
  }

  private async resolveLaunchObservationTimeout(
    result: LaunchAppResult,
    latestObservation: ObserveResult,
    expectedPackageName: string,
    timeoutMs: number,
    options: { coldBoot?: boolean; expectedUserId?: number; signal?: AbortSignal },
  ): Promise<LaunchAppResult> {
    const { coldBoot, expectedUserId, signal } = options;
    // Distinguish "genuinely launched but no foreground window could be read at
    // all" from "observed a different/stale app" (issue #6220 follow-up). The
    // latter is a real mismatch — reject and strip the stale observation, as
    // before. The former is checked via `isMissingForegroundWindow`, a
    // MACHINE-READABLE verdict reused verbatim from the observe freshness gate
    // rather than re-derived from package-name absence: a status-bar-only
    // capture can still carry STALE `packageName`/`foregroundActivity`
    // metadata left over from a previously-resumed app, so "has package
    // names" alone would wrongly classify it as a wrong-app mismatch (issue
    // #6239 review follow-up). Checking the verdict FIRST — before
    // package-count — means a status-bar-only/no-window capture is preserved
    // as a structured `verified: false` + `verifyFailureReason` no matter what
    // stale attribution it still carries; only a genuinely COMPLETE capture (a
    // real foreground window) naming a different app falls through to the
    // wrong-app reject path below.
    if (this.isMissingForegroundWindow(latestObservation)) {
      logger.warn(
        `[LaunchApp] Launch observation for ${expectedPackageName} reports no foreground window after ${timeoutMs}ms; preserving it for the response instead of rejecting it as a stale/wrong-app capture`,
      );
      result.observation = this.preserveLaunchObservationMetadata(
        latestObservation,
        result.observation ?? latestObservation,
      );
      return result;
    }

    if (
      this.verifyLaunchObservationFromTaskRoot(
        result,
        latestObservation,
        expectedPackageName,
        expectedUserId,
      )
    ) {
      return result;
    }

    const foregroundDescription = this.describeLaunchObservationPackages(latestObservation);
    const lock = await this.resolveLockForLaunchBlocker(latestObservation, signal);
    return this.withoutStaleLaunchObservation(
      {
        ...result,
        success: false,
        error: `Timed out waiting for launch observation to show ${expectedPackageName}; last observation reported ${foregroundDescription} in the foreground — ${this.describeLaunchObservationBlocker(latestObservation, lock, foregroundDescription, expectedPackageName, coldBoot)}`,
      },
      expectedPackageName,
      latestObservation,
    );
  }

  private isSystemUiOverlayObservation(observation: ObserveResult): boolean {
    const activeWindow = observation.activeWindow;
    return activeWindow?.appId === "com.android.systemui" && activeWindow.systemOverlay === true;
  }

  /**
   * The lock sample the timeout message is based on (#10182). The observation's
   * own sample can be absent (the `dumpsys window policy` read failed or lacked
   * the keyguard fields) or taken before the keyguard settled, so when a SystemUI
   * surface covers the app and the observation does not already say the device is
   * locked, take one more read bounded by the request signal and a short
   * deadline. A failed re-read falls back to the observation's sample, then to
   * `undefined` (unknown) — never to a guessed "unlocked".
   */
  private async resolveLockForLaunchBlocker(
    observation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<DeviceLockState | undefined> {
    if (
      this.device.platform !== "android" ||
      !this.isSystemUiOverlayObservation(observation) ||
      observation.deviceLock?.locked === true ||
      signal?.aborted
    ) {
      return observation.deviceLock;
    }
    try {
      const fresh = await raceWithDeadline(() => this.adb.getDeviceLock(signal), {
        timer: this.timer,
        timeoutMs: LAUNCH_BLOCKER_LOCK_REREAD_TIMEOUT_MS,
        signal,
        label: "Launch blocker lock re-read",
        relabelDefaultAbort: false,
      });
      return fresh ?? observation.deviceLock;
    } catch (error) {
      logger.warn(
        `[LaunchApp] Lock re-read for the launch timeout message failed: ${errorMessage(error)}`,
        error,
      );
      return observation.deviceLock;
    }
  }

  private describeLaunchObservationBlocker(
    latestObservation: ObserveResult,
    lock: DeviceLockState | undefined,
    foregroundDescription: string,
    expectedPackageName: string,
    coldBoot?: boolean,
  ): string {
    // The hierarchy read itself can name the keyguard (`device_locked`) when the
    // lock sample is missing from the observation.
    if (
      lock?.locked === true ||
      latestObservation.viewHierarchy?.hierarchy?.unavailableReason === "device_locked"
    ) {
      return "the device is locked (the lock screen is covering the app); call `wakeAndUnlock` first.";
    }

    if (this.isSystemUiOverlayObservation(latestObservation)) {
      // Only a lock sample that says "not locked" makes the shade the evidence-backed
      // cause. Without one, a keyguard the lock read missed looks identical (#10182).
      return lock?.locked === false
        ? "the system UI (notification shade) is covering the app."
        : "the system UI is covering the app and the lock state could not be determined, so it may be the lock screen or the notification shade; call `wakeAndUnlock` to clear a lock screen, or collapse the shade, then retry.";
    }

    if (coldBoot) {
      return `\`${foregroundDescription}\` is in the foreground instead of \`${expectedPackageName}\`; terminate it or verify the launch target.`;
    }

    return "pass coldBoot: true to reset to the launcher activity, or call terminateApp first.";
  }

  private settleLaunchObservation(
    result: LaunchAppResult,
    observation: ObserveResult,
    expectedPackageName: string,
    expectedUserId?: number,
  ): boolean {
    if (this.launchObservationMatchesPackage(observation, expectedPackageName)) {
      result.observation = this.preserveLaunchObservationMetadata(
        observation,
        result.observation ?? observation,
      );
      return true;
    }

    return this.verifyLaunchObservationFromTaskRoot(
      result,
      observation,
      expectedPackageName,
      expectedUserId,
    );
  }

  private withoutStaleLaunchObservation(
    result: LaunchAppResult,
    expectedPackageName: string,
    staleObservation: ObserveResult,
  ): LaunchAppResult {
    this.cacheInvalidator.invalidate(this.device);
    const reportedPackages = this.describeLaunchObservationPackages(staleObservation);
    logger.warn(
      `[LaunchApp] Omitting stale launch observation for ${expectedPackageName}; ` +
        `last observation reported ${reportedPackages}`,
    );
    const resultWithoutObservation = { ...result };
    delete resultWithoutObservation.observation;
    // Explain the omission (issue #5872) so the payload shape is deterministic:
    // a launch either carries `observation` or carries `observationOmitted`
    // naming why, never a silently-vanishing observation.
    resultWithoutObservation.observationOmitted = {
      reason: "stale_launch_observation",
      expectedPackage: expectedPackageName,
      reportedPackages,
    };
    return resultWithoutObservation;
  }

  private preserveLaunchObservationMetadata(
    observation: ObserveResult,
    previousObservation: ObserveResult,
  ): ObserveResult {
    return {
      ...observation,
      gfxMetrics: observation.gfxMetrics ?? previousObservation.gfxMetrics,
      perfTiming: observation.perfTiming ?? previousObservation.perfTiming,
    };
  }

  private launchObservationMatchesPackage(
    observation: ObserveResult,
    expectedPackageName: string,
  ): boolean {
    if (!this.isLaunchObservationFresh(observation)) {
      return false;
    }

    if (this.isLaunchPermissionDialogObservation(observation)) {
      return true;
    }

    const packageNames = this.getLaunchObservationPackageNames(observation);
    return (
      packageNames.length === 0 ||
      packageNames.every((packageName) => packageName === expectedPackageName)
    );
  }

  private isLaunchPermissionDialogObservation(observation: ObserveResult): boolean {
    return isLaunchPermissionDialogObservation(observation);
  }

  private describeLaunchObservationPackages(observation: ObserveResult): string {
    const packageNames = this.getLaunchObservationPackageNames(observation);
    return packageNames.length > 0 ? packageNames.join(", ") : "unknown app";
  }

  private getLaunchObservationPackageNames(observation: ObserveResult): string[] {
    return getLaunchObservationPackageNames(observation);
  }

  /**
   * Whether an observation is safe to use for launch verification (issue #7218
   * P1 follow-up): reconnect or other stale captures must not verify either
   * direct foreground identity or a matching task root.
   */
  private isLaunchObservationFresh(observation: ObserveResult): boolean {
    return observation.freshness?.isFresh !== false && observation.freshness?.verified !== false;
  }

  /**
   * Whether the foreground task belongs to the launched app even though its top
   * activity belongs to a helper package (issue #7218).
   */
  private isForegroundTaskRootedAtPackage(
    observation: ObserveResult,
    expectedPackageName: string,
    expectedUserId?: number,
  ): boolean {
    const currentTaskId = observation.backStack?.currentTaskId;
    if (currentTaskId === undefined) {
      return false;
    }

    const currentTask = observation.backStack?.tasks.find((task) => task.id === currentTaskId);
    return (
      (expectedUserId === undefined ||
        currentTask?.userId === undefined ||
        currentTask.userId === expectedUserId) &&
      (currentTask?.packageName === expectedPackageName ||
        currentTask?.rootActivity?.split("/")[0] === expectedPackageName)
    );
  }

  /** Whether the foreground task's root activity was launched by the expected package. */
  private isForegroundTaskLaunchedByPackage(
    observation: ObserveResult,
    expectedPackageName: string,
    expectedUserId?: number,
  ): boolean {
    const currentTaskId = observation.backStack?.currentTaskId;
    if (currentTaskId === undefined) {
      return false;
    }

    const currentTask = observation.backStack?.tasks.find((task) => task.id === currentTaskId);
    return (
      (expectedUserId === undefined ||
        currentTask?.userId === undefined ||
        currentTask.userId === expectedUserId) &&
      currentTask?.launchedFromPackage === expectedPackageName
    );
  }

  private verifyLaunchObservationFromTaskRoot(
    result: LaunchAppResult,
    observation: ObserveResult,
    expectedPackageName: string,
    expectedUserId?: number,
  ): boolean {
    // Issue #7218 P1 follow-up: a SystemUI surface can cover the previously
    // foregrounded task, so its back stack must not verify the launch.
    if (
      !this.isLaunchObservationFresh(observation) ||
      observation.activeWindow?.systemOverlay === true
    ) {
      return false;
    }

    const foregroundActivityPackage = this.getLaunchObservationPackageNames(observation).find(
      (packageName) => packageName !== expectedPackageName,
    );
    if (!foregroundActivityPackage) {
      return false;
    }

    if (this.isForegroundTaskRootedAtPackage(observation, expectedPackageName, expectedUserId)) {
      result.observation = this.preserveLaunchObservationMetadata(
        observation,
        result.observation ?? observation,
      );
      result.foregroundActivityPackage = foregroundActivityPackage;
      result.verifiedBy = "task-root";
      return true;
    }

    // Provenance alone is intentional: a companion task started by the target
    // in an earlier session (or restored after the target crashes during launch)
    // can false-verify because no pre-launch task snapshot exists to age it out.
    if (!this.isForegroundTaskLaunchedByPackage(observation, expectedPackageName, expectedUserId)) {
      return false;
    }

    result.observation = this.preserveLaunchObservationMetadata(
      observation,
      result.observation ?? observation,
    );
    result.foregroundActivityPackage = foregroundActivityPackage;
    result.verifiedBy = "task-provenance";
    return true;
  }

  /**
   * Whether an observation reports no foreground window at all (issue #6220
   * follow-up, #6239 review): either the same machine-readable verdict the
   * observe freshness gate uses (`resolveMissingForegroundWindow` — catches a
   * status-bar-only capture even when it still carries stale identity
   * metadata), or the plain "no package names at all" case that verdict
   * doesn't cover (e.g. no `viewHierarchy` at all).
   */
  private isMissingForegroundWindow(observation: ObserveResult): boolean {
    return (
      resolveMissingForegroundWindow(observation) !== undefined ||
      this.getLaunchObservationPackageNames(observation).length === 0
    );
  }

  /**
   * Wait for the target app to enter the foreground.
   */
  private async waitForAppForeground(
    packageName: string,
    userId: number,
    timeoutMs: number,
    pollIntervalMs: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const waitForForeground = async (): Promise<boolean> => {
      const startTime = this.timer.now();

      logger.info(
        `[LaunchApp] Waiting for ${packageName} to reach foreground (timeout: ${timeoutMs}ms)`,
      );

      while (true) {
        signal?.throwIfAborted();
        const isForeground = await this.checkAppForeground(packageName, perf, userId);
        if (isForeground) {
          logger.info(
            `[LaunchApp] App ${packageName} reached foreground after ${this.timer.now() - startTime}ms`,
          );
          return true;
        }

        if (this.timer.now() - startTime >= timeoutMs) {
          break;
        }

        await this.timer.sleep(pollIntervalMs);
        signal?.throwIfAborted();
      }

      logger.warn(
        `[LaunchApp] Timed out waiting for ${packageName} to reach foreground after ${timeoutMs}ms`,
      );
      return false;
    };

    if (perf) {
      return perf.track("waitForForeground", waitForForeground);
    }

    return waitForForeground();
  }

  /**
   * Check if app is in foreground
   * @param packageName - Package name to check
   * @param perf - Optional performance tracker
   */
  private async checkAppForeground(
    packageName: string,
    perf?: PerformanceTracker,
    userId?: number,
  ): Promise<boolean> {
    logger.info("[LaunchApp] Checking if app is in foreground");

    const foregroundApp = perf
      ? await perf.track("foregroundApp", () => this.adb.getForegroundApp())
      : await this.adb.getForegroundApp();

    if (foregroundApp) {
      const matchesPackage = foregroundApp.packageName === packageName;
      const matchesUser = userId === undefined || foregroundApp.userId === userId;
      const isForeground = matchesPackage && matchesUser;
      logger.info(`[LaunchApp] Foreground app match (adb): ${isForeground}`);
      if (isForeground) {
        return true;
      }
    }

    return this.checkForegroundDumpsys(packageName, perf);
  }

  /**
   * Foreground check using a single dumpsys call.
   */
  private async checkForegroundDumpsys(
    packageName: string,
    perf?: PerformanceTracker,
  ): Promise<boolean> {
    try {
      // Use a single dumpsys activity activities call and parse the output
      const cmd = `shell dumpsys activity activities | grep -E "(mResumedActivity|mFocusedActivity|topResumedActivity)" | head -5`;
      logger.info(`[LaunchApp] Dumpsys check: ${cmd}`);

      const checkResult = perf
        ? await perf.track("dumpsysCheck", () => this.adb.executeCommand(cmd))
        : await this.adb.executeCommand(cmd);

      const output = (checkResult && checkResult.stdout ? checkResult.stdout : "").trim();
      logger.info(`[LaunchApp] Dumpsys check output: "${output}" (${output.length} chars)`);

      const isForeground = output.includes(packageName);
      logger.info(`[LaunchApp] Final foreground status (dumpsys): ${isForeground}`);
      return isForeground;
    } catch (error) {
      logger.warn(`[LaunchApp] Dumpsys foreground check failed:`, error);
      return false;
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
      // Let PackageManager resolve the app's launcher activity instead of guessing MainActivity.
      const intentCmd = `shell am start --user ${userId} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${shellQuote(packageName)}`;
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

  private async performLaunch(
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
        return this.extractLauncherActivities(packageName, userId, perf, signal);
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
