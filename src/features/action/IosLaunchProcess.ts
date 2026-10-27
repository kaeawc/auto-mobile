import { BootedDevice, LaunchAppResult } from "../../models";
import { DeviceWindowCacheInvalidator } from "./TerminateApp";
import { logger } from "../../utils/logger";
import { resolveIosColdAppCheckKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import {
  resolveIosLaunchBackend,
  resolveIosColdStartTerminateBackend,
} from "../../utils/ios-cmdline-tools/IosDeviceBackend";
import { PerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient, type IosCtrlProxy } from "../observe/ios";
import { IOSCtrlProxyManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type {
  DeviceAppLauncher,
  LaunchAppSimctl,
  InstalledAppsProvider,
  IosClearAppDataRunner,
} from "./LaunchApp";
/** Cold starts can take a long time before CtrlProxy publishes a hierarchy. */
const IOS_HIERARCHY_READY_TIMEOUT_MS = 60_000;
const IOS_RETARGET_ABORT_SETTLEMENT_GRACE_MS = 1_000;
export interface IosLaunchProcessOptions {
  launchArguments?: string[];
  launchEnvironment?: Record<string, string>;
}
interface IosLaunchRequest {
  bundleId: string;
  clearAppData: boolean;
  coldBoot: boolean;
  signal?: AbortSignal;
  processOptions: IosLaunchProcessOptions;
  perf: PerformanceTracker;
}
interface IosLaunchProcessDependencies {
  device: BootedDevice;
  simctl: LaunchAppSimctl;
  deviceAppLauncher: DeviceAppLauncher;
  installedAppsProvider: InstalledAppsProvider;
  clearAppDataFactory: (device: BootedDevice, simctl: LaunchAppSimctl) => IosClearAppDataRunner;
  cacheInvalidator: DeviceWindowCacheInvalidator;
  timer: Timer;
  waitForIosHierarchyReady: (
    timeoutMs: number,
    expectedPackageName: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}
function needsIosColdStart(
  coldBoot: boolean,
  clearAppData: boolean,
  { launchArguments, launchEnvironment }: IosLaunchProcessOptions,
): boolean {
  return (
    coldBoot || clearAppData || Boolean(launchArguments?.length) || launchEnvironment !== undefined
  );
}
function coldIosLaunchOptions({ launchArguments, launchEnvironment }: IosLaunchProcessOptions) {
  return {
    foregroundIfRunning: false,
    launchArguments,
    ...(launchEnvironment === undefined ? {} : { environment: launchEnvironment }),
  };
}
/** Starts or activates an iOS process and synchronizes CtrlProxy with its hierarchy. */
export class IosLaunchProcess {
  constructor(private readonly deps: IosLaunchProcessDependencies) {}
  private assertLaunchNotAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
  }

  async run({
    bundleId,
    clearAppData,
    coldBoot,
    signal,
    processOptions,
    perf,
  }: IosLaunchRequest): Promise<LaunchAppResult> {
    const { launchArguments } = processOptions;
    const isSystemBundleId = bundleId.startsWith("com.apple.");

    this.assertLaunchNotAborted(signal);
    // Clearing app data always implies a fresh process: the app is
    // terminated, its sandbox wiped, then relaunched. Treat it as a cold
    // boot so we go through the terminate → clearCache → launch path.
    // Arguments and the environment are consumed only when a new app process starts.
    const needsColdStart = needsIosColdStart(coldBoot, clearAppData, processOptions);

    // Simulators launch/terminate via simctl; physical devices via devicectl
    // (parity with installApp/uninstallApp). Resolve once so cold and warm
    // paths agree on the transport.
    const backend = resolveIosLaunchBackend(this.deps.device.deviceId, {
      simctl: this.deps.simctl,
      deviceAppLauncher: this.deps.deviceAppLauncher,
    });
    const simulator = backend.kind === "simulator";

    // Reject missing apps before termination, data clearing, or CtrlProxy
    // targeting only with a trustworthy inventory. Unknown IDs cannot
    // safely use the physical lister: its routing differs from launch.
    const missingBeforeLaunch = await this.checkBeforeColdLaunch(
      bundleId,
      needsColdStart,
      isSystemBundleId,
      perf,
      signal,
    );
    if (missingBeforeLaunch) {
      return missingBeforeLaunch;
    }

    // Set bundle ID before starting CtrlProxy so it targets the app, not SpringBoard
    if (!isSystemBundleId) {
      IOSCtrlProxyManager.getInstance(this.deps.device).setTargetBundleId(bundleId);
    }
    const ctrlProxyClient = IOSCtrlProxyClient.getInstance(this.deps.device);

    let launchResult: { success: boolean; pid?: number; error?: string };

    if (needsColdStart) {
      const failure = await this.prepareColdLaunch({
        bundleId,
        clearAppData,
        isSystemBundleId,
        ctrlProxyClient,
        perf,
        signal,
      });
      if (failure) {
        return failure;
      }

      launchResult = await perf.track("launch", () =>
        backend.launchApp(bundleId, coldIosLaunchOptions(processOptions)),
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

      const missingAfterLaunch = await this.checkWarmLaunchFailure({
        launchResult,
        bundleId,
        isSystemBundleId,
        simulator,
        perf,
        signal,
      });
      if (missingAfterLaunch) {
        return missingAfterLaunch;
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
      this.deps.waitForIosHierarchyReady(IOS_HIERARCHY_READY_TIMEOUT_MS, bundleId, signal),
    );
    perf.end();
    return {
      success: true,
      packageName: bundleId,
      pid: launchResult.pid,
    };
  }

  private async checkWarmLaunchFailure({
    launchResult,
    bundleId,
    isSystemBundleId,
    simulator,
    perf,
    signal,
  }: {
    launchResult: { success: boolean; error?: string };
    bundleId: string;
    isSystemBundleId: boolean;
    simulator: boolean;
    perf: PerformanceTracker;
    signal?: AbortSignal;
  }): Promise<LaunchAppResult | undefined> {
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
    return undefined;
  }

  private async checkBeforeColdLaunch(
    bundleId: string,
    needsColdStart: boolean,
    isSystemBundleId: boolean,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<LaunchAppResult | undefined> {
    if (
      needsColdStart &&
      !isSystemBundleId &&
      resolveIosColdAppCheckKind(this.deps.device) !== undefined
    ) {
      const missingApp = await this.checkIosAppNotInstalled(bundleId, perf, signal, true);
      if (missingApp) {
        perf.end();
        return missingApp;
      }
    }
    return undefined;
  }

  private async prepareColdLaunch({
    bundleId,
    clearAppData,
    isSystemBundleId,
    ctrlProxyClient,
    perf,
    signal,
  }: {
    bundleId: string;
    clearAppData: boolean;
    isSystemBundleId: boolean;
    ctrlProxyClient: IosCtrlProxy;
    perf: PerformanceTracker;
    signal?: AbortSignal;
  }): Promise<LaunchAppResult | undefined> {
    // Cold boot: use simctl (simulator) / devicectl (device) directly.
    // XCUIApplication.launch() is slow for heavy apps (10s+ timeout) while
    // simctl launch completes in ~500ms. CtrlProxy's value is in the
    // activate() fast path, not cold boot.
    const terminator = resolveIosColdStartTerminateBackend(this.deps.device.deviceId, {
      simctl: this.deps.simctl,
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
        this.deps.clearAppDataFactory(this.deps.device, this.deps.simctl).execute(bundleId),
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
    IOSCtrlProxyClient.getExistingInstance(this.deps.device.deviceId)?.clearSdkScreenIdentity(
      bundleId,
    );
    return undefined;
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
      this.deps.installedAppsProvider.listInstalledApps(signal),
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

  private requestIosLaunchRetarget(
    ctrlProxyClient: IosCtrlProxy,
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
      this.deps.cacheInvalidator.invalidate(this.deps.device);
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
        timer: this.deps.timer,
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
        // The request may ignore cancellation; the settlement grace remains a hard bound.
        void retarget.catch((lateError) =>
          logger.debug("[LaunchApp] Retarget failed after cancellation", lateError),
        );
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
          timer: this.deps.timer,
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
}
