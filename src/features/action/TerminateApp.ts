import { errorMessage } from "../../utils/describeUnknownError";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { ActionableError, BootedDevice, TerminateAppResult } from "../../models";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { isProcessAlreadyGoneError } from "../../utils/ios-cmdline-tools/iosProcessErrors";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import { ListInstalledApps } from "../observe/ListInstalledApps";
import { getIosInstalledAppBundleId } from "../../utils/ios-cmdline-tools/iosInstalledApp";
import { IOSCtrlProxyClient } from "../observe/ios";

/**
 * Physical-device app terminator. `DeviceAppManager` satisfies this
 * structurally (via `xcrun devicectl device process terminate --kill`); tests
 * inject a fake so the physical path is exercised without a real device. Mirrors
 * the `DeviceAppUninstaller`/`DeviceAppLauncher` injection in the sibling tools.
 */
export interface DeviceAppTerminator {
  terminateApp(
    deviceUdid: string,
    bundleId: string,
  ): Promise<{ wasInstalled: boolean; wasRunning: boolean }>;
}

export class TerminateApp extends BaseVisualChange {
  private simctl: SimCtlClient;
  private deviceTerminator: DeviceAppTerminator;

  /**
   * Create an TerminateApp instance
   * @param device - Optional device
   * @param adb - Optional AdbClient instance for testing
   * @param simctl - Optional SimCtlClient instance for testing
   * @param timer - Optional Timer instance for testing
   * @param deviceTerminator - Optional physical-device terminator for testing
   */
  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    simctl: SimCtlClient | null = null,
    timer: Timer = defaultTimer,
    deviceTerminator: DeviceAppTerminator | null = null,
  ) {
    super(device, adb, timer);
    this.device = device;
    this.simctl = simctl || new SimCtlClient(device);
    this.deviceTerminator = deviceTerminator || new DeviceAppManager();
  }

  /**
   * Terminate an app by package name
   * @param packageName - The package name to terminate
   * @param options - Optional execution options
   */
  async execute(
    packageName: string,
    options?: {
      progress?: ProgressCallback;
      skipObservation?: boolean;
      skipUiStability?: boolean;
      userId?: number;
    },
  ): Promise<TerminateAppResult> {
    if (this.device.platform === "ios") {
      return this.executeiOS(packageName, options);
    }

    const perf = createGlobalPerformanceTracker();
    perf.serial("terminateApp");

    const terminateLogic = async (): Promise<TerminateAppResult> => {
      // Auto-detect target user if not specified
      const targetUserId = await perf.track("detectTargetUser", async () => {
        return (
          await new AndroidUserTargetResolver(this.adb).resolve({
            packageName,
            explicitUserId: options?.userId,
          })
        ).userId;
      });

      // Check if app is installed
      const isInstalled = await perf.track("checkInstalled", async () => {
        try {
          const a11y = AndroidCtrlProxyClient.getInstance(this.device);
          const result = await a11y.requestInstalledPackages(true, targetUserId, 3000);
          if (result.success && result.userId === targetUserId) {
            return result.packages.some((p) => p.packageName === packageName);
          }
        } catch (error) {
          logger.debug(`[TerminateApp] CtrlProxy install check failed: ${error}`, error);
        }
        try {
          const isInstalledCmd = `shell pm list packages --user ${targetUserId} -f ${packageName} | grep -c ${packageName}`;
          const isInstalledOutput = await this.adb.executeCommand(
            isInstalledCmd,
            undefined,
            undefined,
            true,
          );
          return parseInt(isInstalledOutput.trim(), 10) > 0;
        } catch (error) {
          // Both the CtrlProxy call and this shell fallback failed; treating the
          // app as not installed is the safe default for a terminate/uninstall flow.
          logger.debug(`src/features/action/TerminateApp.ts install check failed: ${error}`, error);
          return false;
        }
      });

      if (!isInstalled) {
        return {
          success: true,
          packageName,
          wasInstalled: false,
          wasRunning: false,
          wasForeground: false,
          userId: targetUserId,
        };
      }

      // `force-stop` is destructive, so determine the selected user's process
      // state before changing it. A package running in another profile must not
      // make this operation report that the selected profile was running.
      const isRunning = await perf.track("checkRunning", async () => {
        try {
          // Filter stdout here: grep's exit status conflates an expected
          // no-match (the app is already stopped) with a real ADB failure.
          const result = await this.adb.executeCommand(
            "shell dumpsys activity processes",
            undefined,
            undefined,
            true,
          );
          return result.stdout.includes(`${packageName}/u${targetUserId}a`);
        } catch (error) {
          logger.warn(`[TerminateApp] Running-state check failed for user ${targetUserId}`, error);
          throw new ActionableError(
            `Could not determine whether ${packageName} is running for Android user ${targetUserId}: ${errorMessage(error)}`,
          );
        }
      });

      if (!isRunning) {
        return {
          success: true,
          packageName,
          wasInstalled: true,
          wasRunning: false,
          wasForeground: false,
          userId: targetUserId,
        };
      }

      // Check if app is in foreground using getForegroundApp (which returns user context)
      const isForeground = await perf.track("checkForeground", async () => {
        const foregroundApp = await this.adb.getForegroundApp();
        return (
          foregroundApp !== null &&
          foregroundApp.packageName === packageName &&
          foregroundApp.userId === targetUserId
        );
      });

      await perf.track("forceStop", async () => {
        await this.adb.executeCommand(`shell am force-stop --user ${targetUserId} ${packageName}`);
      });

      return {
        success: true,
        packageName,
        wasInstalled: true,
        wasRunning: true,
        wasForeground: isForeground,
        userId: targetUserId,
      };
    };

    // Skip observation when called internally (e.g., from LaunchApp).
    // `execute` owns the "terminateApp" perf block, so it — not `terminateLogic`
    // — closes it (issue #3037; see the executeiOS note for rationale).
    if (options?.skipObservation) {
      const result = await terminateLogic();
      perf.end();
      return result;
    }

    return this.observedInteraction(terminateLogic, {
      changeExpected: false,
      progress: options?.progress,
      skipUiStability: options?.skipUiStability,
      perf,
    });
  }

  private async executeiOS(
    bundleId: string,
    options?: {
      progress?: ProgressCallback;
      skipObservation?: boolean;
      skipUiStability?: boolean;
    },
  ): Promise<TerminateAppResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("terminateApp");

    // Physical iOS devices (00008XXX / 40-char UDID) can't be driven by simctl;
    // route them through devicectl instead. Simulators keep the simctl path.
    const terminateTransport = isIosSimulatorUdid(this.device.deviceId)
      ? () => this.terminateSimulator(bundleId, perf)
      : () => this.terminatePhysicalDevice(bundleId, perf);
    const terminateLogic = async (): Promise<TerminateAppResult> => {
      const result = await terminateTransport();
      if (result.success) {
        IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.clearSdkScreenIdentity(
          bundleId,
        );
      }
      return result;
    };

    // Perf-tree ownership (issue #3037): `executeiOS` opens the "terminateApp"
    // block, so it — the single owner — must close it. The terminate helpers no
    // longer call `perf.end()` themselves: doing so inside `observedInteraction`
    // popped the block mid-observation, reparenting the later finalObserve /
    // uiStability entries to the root. In the observed path the block stays open
    // and `getTimings()` (in `takeObservation`) closes it after observation, so
    // those entries nest correctly under "terminateApp".
    if (options?.skipObservation) {
      const result = await terminateLogic();
      perf.end();
      return result;
    }

    return this.observedInteraction(terminateLogic, {
      changeExpected: false,
      progress: options?.progress,
      skipUiStability: options?.skipUiStability,
      perf,
    });
  }

  /**
   * Simulator terminate via simctl: check install via the shared
   * `ListInstalledApps` listing, then `simctl terminate`, treating a "nothing
   * to terminate" error as wasRunning=false.
   *
   * The listing goes through `executeIosDetailedResult()` so a listing that
   * *failed* is distinguishable from a device that genuinely has no such app
   * (issue #5621) — the same contract `UninstallApp` uses. Caching stays off so
   * the pre-terminate check always reflects live device state.
   */
  private async terminateSimulator(
    bundleId: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
  ): Promise<TerminateAppResult> {
    const listApps = new ListInstalledApps(this.device, { create: () => this.adb }, this.simctl, {
      cacheEnabled: false,
    });
    const listing = await perf.track("checkInstalled", () => listApps.executeIosDetailedResult());

    if (!listing.successful) {
      // Omit wasInstalled/wasRunning: install state was never established, so
      // reporting them as `false` would assert a fact we do not have.
      return {
        success: false,
        packageName: bundleId,
        wasForeground: false,
        error:
          `Could not determine whether ${bundleId} is installed on iOS device ` +
          `${this.device.deviceId}: the installed-app listing failed. Confirm the device ` +
          `is booted and that Xcode command line tools are available, then retry.`,
      };
    }

    const wasInstalled = listing.apps.some((app) => getIosInstalledAppBundleId(app) === bundleId);

    if (!wasInstalled) {
      return {
        success: true,
        packageName: bundleId,
        wasInstalled: false,
        wasRunning: false,
        wasForeground: false,
      };
    }

    let wasRunning = true;
    let errorMsg: string | undefined;

    try {
      await perf.track("terminateApp", () =>
        this.simctl.terminateApp(bundleId, this.device.deviceId),
      );
    } catch (error) {
      const message = errorMessage(error);
      // Shared already-gone matcher (issue #3076): a simctl "found nothing to
      // terminate" / process-scoped "not running" means the app was already
      // stopped, so report wasRunning:false rather than a hard error. Any other
      // failure (e.g. device-level) surfaces as errorMsg. The simulator path
      // has no tool-specific extras today; add them here (OR-ing the shared
      // helper) if simctl error text ever diverges.
      if (isProcessAlreadyGoneError(message)) {
        wasRunning = false;
      } else {
        errorMsg = message;
      }
    }

    return {
      success: !errorMsg,
      packageName: bundleId,
      wasInstalled: true,
      wasRunning,
      wasForeground: false,
      ...(errorMsg ? { error: errorMsg } : {}),
    };
  }

  /**
   * Physical iOS device terminate via devicectl (iOS 17+). The injected
   * terminator resolves the bundle id to a PID and force-kills it via the
   * dedicated `devicectl device process terminate --kill` verb, reporting
   * install/running status. Matches Android `am force-stop` semantics for
   * `wasRunning`. A devicectl / macOS-guard / iOS<=16 failure surfaces as a
   * clear, non-crashing `success:false` result rather than throwing.
   */
  private async terminatePhysicalDevice(
    bundleId: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
  ): Promise<TerminateAppResult> {
    try {
      const { wasInstalled, wasRunning } = await perf.track("terminateApp", () =>
        this.deviceTerminator.terminateApp(this.device.deviceId, bundleId),
      );
      return {
        success: true,
        packageName: bundleId,
        wasInstalled,
        wasRunning,
        wasForeground: false,
      };
    } catch (error) {
      const message = errorMessage(error);
      // Return a typed failure (matching the simulator path) instead of throwing,
      // but log first so the trace survives even when the client only sees the
      // summarized error (CLAUDE.md error-handling convention #2).
      logger.warn(
        `[TerminateApp] Physical iOS terminate failed for ${bundleId}: ${message}`,
        error,
      );
      // Omit wasInstalled/wasRunning: install state is unknown at throw time (a
      // devicectl failure can occur after the app was confirmed installed), so
      // reporting them as `false` would assert a fact we never established.
      return {
        success: false,
        packageName: bundleId,
        wasForeground: false,
        error: message,
      };
    }
  }
}
