import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { BaseVisualChange } from "./BaseVisualChange";
import { BootedDevice, ClearAppDataResult, LaunchAppResult, ObserveResult, TerminateAppResult } from "../../models";
import { ActionableError } from "../../models";
import { TerminateApp } from "./TerminateApp";
import { ClearAppData } from "./ClearAppData";
import { logger } from "../../utils/logger";
import { ListInstalledApps } from "../observe/ListInstalledApps";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { createGlobalPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { DisplayedTimeMetricsCollector } from "../performance/DisplayedTimeMetricsCollector";
import { setLastTtiMs } from "../performance/PerformanceMonitor";
import { serverConfig } from "../../utils/ServerConfig";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient } from "../observe/ios";
import { IOSCtrlProxyManager } from "../../utils/IOSCtrlProxyManager";
import { AndroidCtrlProxyClient } from "../observe/android";

const LAUNCH_OBSERVATION_TIMEOUT_MS = 5000;
const LAUNCH_OBSERVATION_POLL_INTERVAL_MS = 200;

export interface TargetUserDetector {
  detectTargetUserId(packageName: string, userId?: number): Promise<number>;
}

export interface InstalledAppsProvider {
  listInstalledApps(): Promise<string[]>;
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
    options?: { skipObservation?: boolean; userId?: number }
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
    options?: { terminateExisting?: boolean }
  ): Promise<{ success: boolean; pid?: number; error?: string }>;
}

interface LaunchAppDependencies {
  targetUserDetector?: TargetUserDetector;
  installedAppsProvider?: InstalledAppsProvider;
  performanceTrackerFactory?: () => PerformanceTracker;
  deviceAppLauncher?: DeviceAppLauncher;
  clearAppDataFactory?: (device: BootedDevice, simctl: SimCtlClient) => IosClearAppDataRunner;
  createAndroidClearAppData?: (device: BootedDevice) => AndroidClearAppDataAction;
  createAndroidColdBoot?: (device: BootedDevice) => AndroidColdBootAction;
}

export class LaunchApp extends BaseVisualChange {

  private simctl: SimCtlClient;
  private deviceAppLauncher: DeviceAppLauncher;
  private targetUserDetector: TargetUserDetector;
  private installedAppsProvider: InstalledAppsProvider;
  private performanceTrackerFactory: () => PerformanceTracker;
  private clearAppDataFactory: (device: BootedDevice, simctl: SimCtlClient) => IosClearAppDataRunner;
  private createAndroidClearAppData: (device: BootedDevice) => AndroidClearAppDataAction;
  private createAndroidColdBoot: (device: BootedDevice) => AndroidColdBootAction;
  /**
   * Create an LaunchApp instance
   * @param device - Optional device
   * @param adb - Optional AdbClient instance for testing
   * @param simctl - Optional SimCtlClient instance for testing
   * @param timer - Optional Timer instance for testing
   */
  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    simctl: SimCtlClient | null = null,
    timer: Timer = defaultTimer,
    dependencies: LaunchAppDependencies = {}) {
    super(device, adb, timer);
    this.device = device;
    this.simctl = simctl || new SimCtlClient(this.device);
    this.deviceAppLauncher = dependencies.deviceAppLauncher ?? new DeviceAppManager();
    this.targetUserDetector = dependencies.targetUserDetector ?? {
      detectTargetUserId: (packageName: string, userId?: number) => this.detectTargetUserId(packageName, userId)
    };
    this.installedAppsProvider = dependencies.installedAppsProvider ?? {
      listInstalledApps: () => this.listInstalledApps()
    };
    this.performanceTrackerFactory = dependencies.performanceTrackerFactory ?? createGlobalPerformanceTracker;
    this.clearAppDataFactory = dependencies.clearAppDataFactory ?? (
      (device, simctl) => new ClearAppData(device, undefined, simctl)
    );
    this.createAndroidClearAppData = this.resolveAndroidClearAppDataFactory(dependencies.createAndroidClearAppData);
    this.createAndroidColdBoot = this.resolveAndroidColdBootFactory(dependencies.createAndroidColdBoot);
  }

  private resolveAndroidClearAppDataFactory(
    factory: ((device: BootedDevice) => AndroidClearAppDataAction) | undefined
  ): (device: BootedDevice) => AndroidClearAppDataAction {
    return factory ?? (device => new ClearAppData(device));
  }

  private resolveAndroidColdBootFactory(
    factory: ((device: BootedDevice) => AndroidColdBootAction) | undefined
  ): (device: BootedDevice) => AndroidColdBootAction {
    return factory ?? (device => new TerminateApp(device));
  }

  /**
   * Extract launcher activities using targeted adb command
   * @param packageName - Package name we're trying to launch
   * @param perf - Optional performance tracker
   * @returns Array of launcher activity names
   */
  private async extractLauncherActivities(
    packageName: string,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[]> {
    this.assertLaunchNotAborted(signal);
    logger.info("extractLauncherActivities");
    const activities: string[] = [];

    // Try the WebSocket-backed PackageManager launch intent first.
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const result = perf
        ? await perf.track("a11yLaunchIntent", () => a11y.requestLaunchIntent(packageName, 3000))
        : await a11y.requestLaunchIntent(packageName, 3000);
      this.assertLaunchNotAborted(signal);
      if (result.success && result.componentName) {
        // componentName is "package/.Activity" or "package/com.foo.Activity"
        const slash = result.componentName.indexOf("/");
        if (slash >= 0) {
          let activity = result.componentName.slice(slash + 1);
          if (activity.startsWith(".")) {
            activity = packageName + activity;
          }
          activities.push(activity);
          logger.info(`[LaunchApp] Resolved launcher activity via a11y: ${activity}`);
          return activities;
        }
      }
    } catch (error) {
      this.assertLaunchNotAborted(signal);
      logger.debug(`[LaunchApp] a11y launch intent failed, falling back to ADB: ${error}`);
    }

    try {
      logger.info(`[LaunchApp] Extracting launcher activities for ${packageName}`);

      // Try multiple approaches to find the main activity
      const approaches = [
        // Approach 1: Direct pm dump with specific grep
        `shell pm dump ${packageName} | grep -A 5 -B 5 "android.intent.action.MAIN"`,
        // Approach 2: Query resolver activities
        `shell cmd package query-activities --brief android.intent.action.MAIN android.intent.category.LAUNCHER | grep ${packageName}`,
        // Approach 3: Direct pm list activities
        `shell pm list packages -f ${packageName} && pm dump ${packageName} | grep -A 10 "Activity filter"`
      ];

      for (let i = 0; i < approaches.length; i++) {
        this.assertLaunchNotAborted(signal);
        try {
          logger.info(`[LaunchApp] Trying approach ${i + 1}: ${approaches[i]}`);
          const result = perf
            ? await perf.track(`activityApproach_${i + 1}`, () =>
                this.adb.executeCommand(approaches[i], undefined, undefined, undefined, signal)
              )
            : await this.adb.executeCommand(
                approaches[i],
                undefined,
                undefined,
                undefined,
                signal,
              );
          this.assertLaunchNotAborted(signal);
          logger.info(`[LaunchApp] Approach ${i + 1} result: ${result.stdout.length} chars of output`);

          if (result.stdout.trim()) {
            // Extract activity name from various patterns
            const patterns = [
              // Pattern 1: "packageName/activityName"
              new RegExp(`${packageName}/([^\\s]+)`, "g"),
              // Pattern 2: Activity class names
              new RegExp(`${packageName}\\.[^\\s]*Activity[^\\s]*`, "g"),
              // Pattern 3: Full class names in the package
              new RegExp(`${packageName}\\.[^\\s]+`, "g")
            ];

            for (const pattern of patterns) {
              const matches = result.stdout.match(pattern);
              if (matches) {
                logger.info(`[LaunchApp] Found ${matches.length} potential activities with pattern: ${pattern}`);
                for (const match of matches) {
                  if (match.includes("/")) {
                    const activityName = match.split("/")[1];
                    if (activityName && !activities.includes(activityName)) {
                      activities.push(activityName);
                      logger.info(`[LaunchApp] Added activity: ${activityName}`);
                    }
                  } else if (match.startsWith(packageName + ".")) {
                    const activityName = match;
                    if (!activities.includes(activityName)) {
                      activities.push(activityName);
                      logger.info(`[LaunchApp] Added full activity name: ${activityName}`);
                    }
                  }
                }
              }
            }

            if (activities.length > 0) {
              logger.info(`[LaunchApp] Successfully found ${activities.length} activities using approach ${i + 1}`);
              break;
            }
          }
        } catch (error) {
          this.assertLaunchNotAborted(signal);
          logger.warn(`[LaunchApp] Approach ${i + 1} failed:`, error);
        }
      }

      // If no activities found, try a simpler approach
      if (activities.length === 0) {
        this.assertLaunchNotAborted(signal);
        logger.info(`[LaunchApp] No activities found, trying fallback approach`);
        try {
          const simpleResult = perf
            ? await perf.track("activityFallback", () =>
                this.adb.executeCommand(
                  `shell pm dump ${packageName}`,
                  undefined,
                  undefined,
                  undefined,
                  signal,
                )
              )
            : await this.adb.executeCommand(
                `shell pm dump ${packageName}`,
                undefined,
                undefined,
                undefined,
                signal,
              );
          this.assertLaunchNotAborted(signal);
          const lines = simpleResult.stdout.split("\n");

          for (const line of lines) {
            if (line.includes("android.intent.action.MAIN") || line.includes("MainActivity") || line.includes(".Main")) {
              logger.info(`[LaunchApp] Found potential main activity line: ${line.trim()}`);
              // Look for activity names in surrounding lines
              const activityMatch = line.match(new RegExp(`${packageName}[^\\s]*`, "g"));
              if (activityMatch) {
                for (const match of activityMatch) {
                  if (!activities.includes(match)) {
                    activities.push(match);
                    logger.info(`[LaunchApp] Added fallback activity: ${match}`);
                  }
                }
              }
            }
          }
        } catch (error) {
          this.assertLaunchNotAborted(signal);
          logger.warn(`[LaunchApp] Fallback approach failed:`, error);
        }
      }

    } catch (error) {
      this.assertLaunchNotAborted(signal);
      logger.warn(`[LaunchApp] Failed to extract launcher activities for ${packageName}:`, error);
    }

    logger.info(`[LaunchApp] Final activities list: [${activities.join(", ")}]`);
    return activities;
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
  ): Promise<LaunchAppResult> {
    logger.info("execute");
    signal?.throwIfAborted();
    switch (this.device.platform) {
      case "ios":
        return this.executeiOS(packageName, clearAppData, coldBoot, signal);
      case "android":
        return this.executeAndroid(
          packageName,
          clearAppData,
          coldBoot,
          activityName,
          userId,
          skipUiStability,
          signal,
        );
      default:
        throw new ActionableError(`Unsupported platform: ${this.device.platform}`);
    }
  }

  /**
   * True when the active iOS device is a simulator (simctl) rather than a
   * physical device (devicectl). Same runtime signal used across the iOS tooling.
   */
  private isSimulator(): boolean {
    return isIosSimulatorUdid(this.device.deviceId);
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
  ): Promise<LaunchAppResult> {
    const perf = this.performanceTrackerFactory();
    perf.serial("launchApp");

    logger.info(`executeiOS bundleId ${bundleId}`);

    const isSystemBundleId = bundleId.startsWith("com.apple.");

    const result = await this.observedInteraction(
      async () => {
        this.assertLaunchNotAborted(signal);
        // Set bundle ID before starting CtrlProxy so it targets the app, not SpringBoard
        if (!isSystemBundleId) {
          IOSCtrlProxyManager.getInstance(this.device).setTargetBundleId(bundleId);
        }

        let launchResult: { success: boolean; pid?: number; error?: string };

        // Clearing app data always implies a fresh process: the app is
        // terminated, its sandbox wiped, then relaunched. Treat it as a cold
        // boot so we go through the terminate → clearCache → launch path.
        const needsColdStart = coldBoot || clearAppData;

        // Simulators launch/terminate via simctl; physical devices via devicectl
        // (parity with installApp/uninstallApp). Resolve once so cold and warm
        // paths agree on the transport.
        const simulator = this.isSimulator();

        if (needsColdStart) {
          // Cold boot: use simctl (simulator) / devicectl (device) directly.
          // XCUIApplication.launch() is slow for heavy apps (10s+ timeout) while
          // simctl launch completes in ~500ms. CtrlProxy's value is in the
          // activate() fast path, not cold boot.
          if (simulator) {
            // simctl launch does not terminate an already-running instance, so
            // terminate first for cold-boot semantics. Physical devices skip this:
            // the devicectl launch below passes `--terminate-existing`, which is
            // the authoritative cold-boot relaunch (an explicit pre-terminate
            // would add a redundant round-trip).
            await perf.track("terminateApp", async () => {
              try {
                await this.simctl.terminateApp(bundleId);
              } catch {
                // App might not be running
              }
            });
            this.assertLaunchNotAborted(signal);
          }

          // Wipe the app's data container (fastest iOS "clear data": no reinstall,
          // keeps permission grants). System bundles (com.apple.*) are skipped —
          // we never want to wipe SpringBoard/Settings data.
          if (clearAppData && !isSystemBundleId) {
            const clearResult = await perf.track("clearAppData", () =>
              this.clearAppDataFactory(this.device, this.simctl).execute(bundleId)
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
          const ctrlProxyClient = IOSCtrlProxyClient.getInstance(this.device);
          ctrlProxyClient.clearCache();
          IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.clearSdkScreenIdentity(bundleId);
          launchResult = await perf.track("launch", () =>
            simulator
              ? this.simctl.launchApp(bundleId, { foregroundIfRunning: false })
              // devicectl has no foreground-if-running verb; --terminate-existing
              // gives cold-boot relaunch semantics (a fresh process foregrounds).
              : this.deviceAppLauncher.launchApp(this.device.deviceId, bundleId, { terminateExisting: true })
          );
          this.assertLaunchNotAborted(signal);
        } else {
          // Warm launch. Simulator: simctl launch foregrounds a backgrounded app
          // and is faster than the CtrlProxy WebSocket round-trip (~4-5s). Device:
          // devicectl has no foreground verb, so relaunch via --terminate-existing.
          launchResult = await perf.track("launch", () =>
            simulator
              ? this.simctl.launchApp(bundleId)
              : this.deviceAppLauncher.launchApp(this.device.deviceId, bundleId, { terminateExisting: true })
          );
          this.assertLaunchNotAborted(signal);

          if (!launchResult.success) {
            logger.warn(`[LaunchApp] launch failed: ${launchResult.error ?? "unknown error"}`);

            // Only check installed apps on the fallback path, and only on
            // simulators — simctl listapps is slow (~2s) and returns nothing for
            // a physical device, where devicectl's launch error is authoritative.
            if (!isSystemBundleId && simulator) {
              const installedApps = await perf.track("checkInstalled", () =>
                this.installedAppsProvider.listInstalledApps()
              );
              this.assertLaunchNotAborted(signal);
              if (installedApps.length > 0 && !installedApps.includes(bundleId)) {
                logger.info("App is not installed");
                perf.end();
                return {
                  success: false,
                  packageName: bundleId,
                  error: "App is not installed"
                };
              }
            }
          }

          // CtrlProxy WebSocket launch path (disabled — kept for future comparison):
          // const xcTestClient = IOSCtrlProxyClient.getInstance(this.device);
          // perf.serial("ctrlProxyLaunch");
          // const xcTestLaunchResult = await xcTestClient.requestLaunchApp(
          //   bundleId, undefined, perf, coldBoot
          // );
          // if (xcTestLaunchResult.perfTiming) {
          //   const timings = Array.isArray(xcTestLaunchResult.perfTiming)
          //     ? xcTestLaunchResult.perfTiming
          //     : [xcTestLaunchResult.perfTiming];
          //   perf.addExternalTiming("ctrlProxySwiftBreakdown", timings);
          // }
          // perf.end();
          // launchResult = {
          //   success: xcTestLaunchResult.success,
          //   error: xcTestLaunchResult.error
          // };
        }

        if (launchResult.error) {
          perf.end();
          return {
            success: false,
            packageName: bundleId,
            error: launchResult.error,
          };
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
        // Use minTimestamp=0 so finalObserve returns cached hierarchy without a sync fetch.
        // iOS hierarchy timestamps (Swift Date) and TS timestamps (Date.now) are from
        // different clocks, causing minTimestamp checks to fail and force ~130ms round-trips.
        overrideMinTimestamp: 0,
        signal,
      },
    );

    signal?.throwIfAborted();
    return this.ensureLaunchObservationMatchesPackage(
      result,
      bundleId,
      undefined,
      undefined,
      signal,
    );
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
    if (cachedPkg && (!expectedPackageName || cachedPkg === expectedPackageName)) {
      logger.info(`[LaunchApp] iOS hierarchy already cached (pkg=${cachedPkg}, ${this.timer.now() - startTime}ms)`);
      return;
    }

    // Race a push listener against a forced sync request. Push notifications only
    // fire for unsolicited hierarchy_update messages (periodic pushes), while sync
    // responses go through requestManager.resolve() without notifying push listeners.
    // By racing both, we resolve as soon as either path delivers the correct app.
    if (expectedPackageName) {
      let pushUnsubscribe: (() => void) | undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;

      const pushPromise = new Promise<string>(resolve => {
        timeoutHandle = this.timer.setTimeout(() => resolve("timeout"), timeoutMs);
        pushUnsubscribe = xcTestClient.onPushUpdate(hierarchy => {
          if (hierarchy.packageName === expectedPackageName) {
            resolve("push");
          }
        });
      });

      const syncPromise = xcTestClient.requestHierarchySync(undefined, true, undefined, timeoutMs)
        .then(result => {
          const pkg = (result?.hierarchy as { packageName?: string } | null)?.packageName;
          return pkg === expectedPackageName ? "sync" : "wrong_app";
        })
        .catch(err => {
          logger.warn(`[LaunchApp] iOS hierarchy sync failed during race: ${err}`);
          return "error" as string;
        });

      const abortPromise = signal
        ? new Promise<never>((_resolve, reject) => {
            abortListener = () => {
              try {
                signal.throwIfAborted();
              } catch (error) {
                reject(error);
              }
            };
            signal.addEventListener("abort", abortListener, { once: true });
            if (signal.aborted) {
              abortListener();
            }
          })
        : undefined;
      let winner: string;
      try {
        winner = await Promise.race([
          pushPromise,
          syncPromise,
          ...(abortPromise ? [abortPromise] : []),
        ]);
        signal?.throwIfAborted();
      } finally {
        pushUnsubscribe?.();
        if (timeoutHandle) {
          this.timer.clearTimeout(timeoutHandle);
        }
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
      }

      if (winner === "push" || winner === "sync") {
        logger.info(`[LaunchApp] iOS hierarchy ready via ${winner} after ${this.timer.now() - startTime}ms (pkg=${expectedPackageName})`);

        return;
      }
    } else {
      // No expected packageName — just do one forced sync to get any hierarchy
      try {
        await xcTestClient.requestHierarchySync(undefined, true, undefined, timeoutMs);
        logger.info(`[LaunchApp] iOS hierarchy ready after ${this.timer.now() - startTime}ms`);
        return;
      } catch {
        // Fall through to warn
      }
    }

    logger.warn(`[LaunchApp] Timed out waiting for iOS hierarchy after ${timeoutMs}ms (expected=${expectedPackageName})`);
  }

  private async detectTargetUserId(
    packageName: string,
    userId?: number
  ): Promise<number> {
    const target = await new AndroidUserTargetResolver(this.adb).resolve({
      packageName,
      explicitUserId: userId,
    });
    logger.info(`[LaunchApp] Using ${target.source}: user ${target.userId}`);
    return target.userId;
  }

  private async listInstalledApps(): Promise<string[]> {
    return (new ListInstalledApps(this.device, this.adbFactory)).execute();
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
  private async executeAndroid(
    packageName: string,
    clearAppData: boolean,
    coldBoot: boolean,
    activityName?: string,
    userId?: number,
    skipUiStability?: boolean,
    signal?: AbortSignal,
  ): Promise<LaunchAppResult> {
    const perf = this.performanceTrackerFactory();
    perf.serial("launchApp");

    logger.info(`executeAndroid: ${packageName}`);

    const preflight = Promise.allSettled([
      // Auto-detect target user if not specified
      perf.track("detectTargetUser", async () => {
        return this.targetUserDetector.detectTargetUserId(packageName, userId);
      }),
      // Check app status (installation and running)
      perf.track("checkInstalled", async () => {
        return this.installedAppsProvider.listInstalledApps();
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
    const installedApps = installedAppsResult.value;
    logger.info(`[LaunchApp] Found ${installedApps.length} installed app(s)`);
    logger.info(`[LaunchApp] Looking for package: ${packageName}`);
    logger.info(`[LaunchApp] Installed apps: ${installedApps.join(", ")}`);
    if (!installedApps.includes(packageName)) {
      logger.error(`[LaunchApp] App ${packageName} is not installed`);
      logger.error(`[LaunchApp] DEBUG: installedApps.length = ${installedApps.length}`);
      logger.error(`[LaunchApp] DEBUG: installedApps = [${installedApps.join(", ")}]`);
      perf.end();
      return {
        success: false,
        packageName: packageName,
        userId: targetUserId,
        error: "App is not installed"
      };
    }

    // Check if app is running
    const isRunning = await perf.track("checkRunning", async () => {
      const isRunningCmd = `shell ps | grep ${packageName} | grep -v grep | wc -l`;
      logger.info(`[LaunchApp] Checking if app is running: ${isRunningCmd}`);
      const isRunningOutput = await this.adb.executeCommand(isRunningCmd);
      const result = parseInt(isRunningOutput.trim(), 10) > 0;
      logger.info(`[LaunchApp] App running: ${result} (output: "${isRunningOutput.trim()}")`);
      return result;
    });

    let didTerminateOrClear = false;
    let alreadyForeground = false;

    if (isRunning) {
      if (clearAppData) {
        await perf.track("clearAppData", async () => {
          return this.createAndroidClearAppData(this.device).execute(packageName, targetUserId);
        });
        didTerminateOrClear = true;
      } else if (coldBoot) {
        await perf.track("terminateApp", async () => {
          return this.createAndroidColdBoot(this.device).execute(packageName, { skipObservation: true, userId: targetUserId });
        });
        didTerminateOrClear = true;
      }

      // Skip foreground check if we just terminated or cleared - we know app is not in foreground
      if (!didTerminateOrClear) {
        // Check if app is in foreground - use getForegroundApp which returns user context
        const foregroundApp = await perf.track(`checkForeground`, async () => {
          return this.adb.getForegroundApp();
        });

        alreadyForeground = foregroundApp &&
                            foregroundApp.packageName === packageName &&
                            foregroundApp.userId === targetUserId;

        if (alreadyForeground) {
          logger.info(`[LaunchApp] App ${packageName} is already in foreground in user ${targetUserId}`);
        }
      }
    } else {
      if (clearAppData) {
        await perf.track("clearAppData", async () => {
          return this.createAndroidClearAppData(this.device).execute(packageName, targetUserId);
        });
        didTerminateOrClear = true;
      }
    }

    if (alreadyForeground) {
      const result = await this.observedInteraction(
        async () => {
          perf.end();
          return {
            success: true,
            packageName,
            activityName,
            userId: targetUserId
          };
        },
        {
          changeExpected: false,
          perf,
          packageName,
          signal,
          skipPreviousObserve: true,
          skipUiStability: skipUiStability ?? false
        }
      );
      result.error = "App is already in foreground";
      result.success = true;
      return result;
    }

    logger.info(`[LaunchApp] Proceeding with app launch`);

    const captureDisplayedMetrics = serverConfig.isUiPerfModeEnabled();
    logger.info(`[LaunchApp] captureDisplayedMetrics=${captureDisplayedMetrics} (isUiPerfModeEnabled)`);
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
        observationTimestampProvider: () => observationTimestampMs,
        signal,
      },
    );

    signal?.throwIfAborted();
    const settledLaunchResult = await this.ensureLaunchObservationMatchesPackage(
      launchResult,
      packageName,
      undefined,
      undefined,
      signal,
    );

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
        setLastTtiMs(packageName, firstMetric.displayedTimeMs);
        logger.info(`[LaunchApp] Recorded TTI for ${packageName}: ${firstMetric.displayedTimeMs}ms`);
      } else {
        logger.info(`[LaunchApp] No displayed metrics found for ${packageName}`);
      }
    } else {
      logger.info(`[LaunchApp] Skipping TTI capture - conditions not met`);
    }

    return settledLaunchResult;
  }

  private async waitForAndroidPreflight<T>(
    preflight: Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (!signal) {
      return await preflight;
    }
    signal.throwIfAborted();
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        try {
          signal.throwIfAborted();
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) {
        abortListener();
      }
    });
    try {
      return await Promise.race([preflight, aborted]);
    } finally {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private async ensureLaunchObservationMatchesPackage(
    result: LaunchAppResult,
    expectedPackageName: string,
    timeoutMs: number = LAUNCH_OBSERVATION_TIMEOUT_MS,
    pollIntervalMs: number = LAUNCH_OBSERVATION_POLL_INTERVAL_MS,
    signal?: AbortSignal,
  ): Promise<LaunchAppResult> {
    signal?.throwIfAborted();
    if (
      !result.observation ||
      this.launchObservationMatchesPackage(result.observation, expectedPackageName)
    ) {
      return result;
    }

    if (!result.success) {
      return this.withoutStaleLaunchObservation(result, expectedPackageName, result.observation);
    }

    const startTime = this.timer.now();
    let latestObservation = result.observation;

    while (this.timer.now() - startTime < timeoutMs) {
      signal?.throwIfAborted();
      logger.info(
        `[LaunchApp] Launch observation still reports previous app; re-observing for ${expectedPackageName}`,
      );
      await this.timer.sleep(pollIntervalMs);
      latestObservation = await this.observeScreen.execute({
        skipWaitForFresh: false,
        signal,
      });
      signal?.throwIfAborted();
      if (this.launchObservationMatchesPackage(latestObservation, expectedPackageName)) {
        result.observation = this.preserveLaunchObservationMetadata(
          latestObservation,
          result.observation,
        );
        return result;
      }
    }

    return this.withoutStaleLaunchObservation(
      {
        ...result,
        success: false,
        error: `Timed out waiting for launch observation to show ${expectedPackageName}; last observation reported ${this.describeLaunchObservationPackages(latestObservation)}`
      },
      expectedPackageName,
      latestObservation
    );
  }

  private withoutStaleLaunchObservation(
    result: LaunchAppResult,
    expectedPackageName: string,
    staleObservation: ObserveResult
  ): LaunchAppResult {
    logger.warn(
      `[LaunchApp] Omitting stale launch observation for ${expectedPackageName}; ` +
      `last observation reported ${this.describeLaunchObservationPackages(staleObservation)}`
    );
    const resultWithoutObservation = { ...result };
    delete resultWithoutObservation.observation;
    return resultWithoutObservation;
  }

  private preserveLaunchObservationMetadata(
    observation: ObserveResult,
    previousObservation: ObserveResult
  ): ObserveResult {
    return {
      ...observation,
      gfxMetrics: observation.gfxMetrics ?? previousObservation.gfxMetrics,
      perfTiming: observation.perfTiming ?? previousObservation.perfTiming
    };
  }

  private launchObservationMatchesPackage(observation: ObserveResult, expectedPackageName: string): boolean {
    if (this.isLaunchPermissionDialogObservation(observation)) {
      return true;
    }

    const packageNames = this.getLaunchObservationPackageNames(observation);
    return packageNames.length === 0 || packageNames.every(packageName => packageName === expectedPackageName);
  }

  private isLaunchPermissionDialogObservation(observation: ObserveResult): boolean {
    return observation.notificationPermissionDetected === true &&
      observation.activeWindow?.type === "notification_permission_dialog";
  }

  private describeLaunchObservationPackages(observation: ObserveResult): string {
    const packageNames = this.getLaunchObservationPackageNames(observation);
    return packageNames.length > 0 ? packageNames.join(", ") : "unknown app";
  }

  private getLaunchObservationPackageNames(observation: ObserveResult): string[] {
    const packageNames = [
      observation.activeWindow?.appId,
      observation.viewHierarchy?.packageName
    ].filter((packageName): packageName is string => !!packageName);

    return [...new Set(packageNames)];
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
    userId?: number
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
  private async checkForegroundDumpsys(packageName: string, perf?: PerformanceTracker): Promise<boolean> {
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
      const intentResult = await perf.track("intentLaunch", async () => {
        logger.info(`[LaunchApp] Trying am start with intent for user ${userId}`);
        try {
          // Let PackageManager resolve the app's launcher activity instead of guessing MainActivity.
          const intentCmd = `shell am start --user ${userId} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${packageName}`;
          logger.info(`[LaunchApp] Intent command: ${intentCmd}`);
          const result = await this.adb.executeCommand(intentCmd);
          this.assertLaunchNotAborted(signal);
          // am start may report launch errors on stderr while still returning exit code 0.
          if (result.stdout && !result.stdout.includes("Error") && !result.stderr.includes("Error")) {
            logger.info(`[LaunchApp] Intent launch completed successfully`);
            return { success: true };
          }
          logger.info(`[LaunchApp] Intent launch returned error: ${result.stdout}${result.stderr}`);
          return { success: false };
        } catch (error) {
          this.assertLaunchNotAborted(signal);
          logger.info(`[LaunchApp] Intent launch failed: ${error}, falling back to monkey`);
          return { success: false };
        }
      });
      this.assertLaunchNotAborted(signal);

      if (intentResult.success) {
        perf.end();
        return {
          success: true,
          packageName,
          activityName: "intent_launch",
          userId
        };
      }
    }

    // Try monkey launch as fallback (fast but less reliable)
    if (!targetActivity) {
      const monkeyResult = await perf.track("monkeyLaunch", async () => {
        logger.info(`[LaunchApp] Trying monkey launch (fallback approach) for user ${userId}`);
        try {
          const monkeyCmd = `shell monkey -p ${packageName} --user ${userId} 1`;
          logger.info(`[LaunchApp] Monkey command: ${monkeyCmd}`);
          await this.adb.executeCommand(monkeyCmd);
          this.assertLaunchNotAborted(signal);
          logger.info(`[LaunchApp] Monkey launch completed successfully`);
          return { success: true };
        } catch (error) {
          this.assertLaunchNotAborted(signal);
          logger.info(`[LaunchApp] Monkey launch failed: ${error}, falling back to activity discovery`);
          return { success: false };
        }
      });
      this.assertLaunchNotAborted(signal);

      if (monkeyResult.success) {
        perf.end();
        return {
          success: true,
          packageName,
          activityName: "monkey_launch",
          userId
        };
      }
    }

    // If no specific activity provided, get launcher activities from pm dump
    if (!targetActivity) {
      const launcherActivities = await perf.track("extractLauncherActivities", async () => {
        logger.info(`[LaunchApp] No activity specified, extracting launcher activities`);
        return this.extractLauncherActivities(packageName, perf, signal);
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
            `${packageName}.MainLauncherActivity`
          ];

          for (const pattern of commonPatterns) {
            this.assertLaunchNotAborted(signal);
            try {
              logger.info(`[LaunchApp] Trying common pattern: ${pattern}`);
              await this.adb.executeCommand(`shell am start --user ${userId} -n ${packageName}/${pattern}`);
              this.assertLaunchNotAborted(signal);
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
            userId
          };
        }
      }
    }

    // Launch with specific activity if found, otherwise use default method
    if (targetActivity) {
      await perf.track("launchActivity", async () => {
        logger.info(`[LaunchApp] Launching with activity: ${targetActivity} for user ${userId}`);
        const launchCmd = `shell am start --user ${userId} -n ${packageName}/${targetActivity}`;
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
          const launcherCmd = `shell am start --user ${userId} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${packageName}`;
          logger.info(`[LaunchApp] Launcher intent command: ${launcherCmd}`);
          await this.adb.executeCommand(launcherCmd);
          this.assertLaunchNotAborted(signal);
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
      userId
    };
  }
}
