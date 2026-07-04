import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { BootedDevice, TerminateAppResult } from "../../models";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppInspector } from "../../utils/ios-cmdline-tools/DeviceAppInspector";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";

/**
 * Physical-device app terminator. `DeviceAppInspector` satisfies this
 * structurally (via `xcrun devicectl device process signal`); tests inject a
 * fake so the physical path is exercised without a real device. Mirrors the
 * `DeviceAppUninstaller`/`DeviceAppLauncher` injection in the sibling tools.
 */
export interface DeviceAppTerminator {
  terminateApp(deviceUdid: string, bundleId: string): Promise<{ wasInstalled: boolean; wasRunning: boolean }>;
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
    deviceTerminator: DeviceAppTerminator | null = null
  ) {
    super(device, adb, timer);
    this.device = device;
    this.simctl = simctl || new SimCtlClient(device);
    this.deviceTerminator = deviceTerminator || new DeviceAppInspector();
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
    }
  ): Promise<TerminateAppResult> {
    if (this.device.platform === "ios") {
      return this.executeiOS(packageName, options);
    }

    const perf = createGlobalPerformanceTracker();
    perf.serial("terminateApp");

    const terminateLogic = async (): Promise<TerminateAppResult> => {
      // Auto-detect target user if not specified
      const targetUserId = await perf.track("detectTargetUser", async () => {
        if (options?.userId !== undefined) {
          return options.userId;
        }

        // Check if app is in foreground and get its user
        const foregroundApp = await this.adb.getForegroundApp();
        if (foregroundApp && foregroundApp.packageName === packageName) {
          return foregroundApp.userId;
        }

        // Get list of users and prefer work profile
        const users = await this.adb.listUsers();

        // Find first work profile (userId > 0 and running)
        const workProfile = users.find(u => u.userId > 0 && u.running);
        if (workProfile) {
          return workProfile.userId;
        }

        // Fall back to primary user
        return 0;
      });

      // Check if app is installed
      const isInstalled = await perf.track("checkInstalled", async () => {
        try {
          const a11y = AndroidCtrlProxyClient.getInstance(this.device);
          const result = await a11y.requestInstalledPackages(true, undefined, 3000);
          if (result.success && result.userId === targetUserId) {
            return result.packages.some(p => p.packageName === packageName);
          }
        } catch {
          // fall through
        }
        try {
          const isInstalledCmd = `shell pm list packages --user ${targetUserId} -f ${packageName} | grep -c ${packageName}`;
          const isInstalledOutput = await this.adb.executeCommand(isInstalledCmd, undefined, undefined, true);
          return parseInt(isInstalledOutput.trim(), 10) > 0;
        } catch {
          return false;
        }
      });

      if (!isInstalled) {
        perf.end();
        return {
          success: true,
          packageName,
          wasInstalled: false,
          wasRunning: false,
          wasForeground: false,
          userId: targetUserId
        };
      }

      // Check if app is running
      const isRunning = true;

      if (!isRunning) {
        perf.end();
        return {
          success: true,
          packageName,
          wasInstalled: true,
          wasRunning: false,
          wasForeground: false,
          userId: targetUserId
        };
      }

      // Check if app is in foreground using getForegroundApp (which returns user context)
      const isForeground = await perf.track("checkForeground", async () => {
        const foregroundApp = await this.adb.getForegroundApp();
        return foregroundApp !== null &&
               foregroundApp.packageName === packageName &&
               foregroundApp.userId === targetUserId;
      });

      await perf.track("forceStop", async () => {
        await this.adb.executeCommand(`shell am force-stop --user ${targetUserId} ${packageName}`);
      });

      perf.end();
      return {
        success: true,
        packageName,
        wasInstalled: true,
        wasRunning: true,
        wasForeground: isForeground,
        userId: targetUserId
      };
    };

    // Skip observation when called internally (e.g., from LaunchApp)
    if (options?.skipObservation) {
      return terminateLogic();
    }

    return this.observedInteraction(
      terminateLogic,
      {
        changeExpected: false,
        progress: options?.progress,
        skipUiStability: options?.skipUiStability,
        perf
      }
    );
  }

  private async executeiOS(
    bundleId: string,
    options?: {
      progress?: ProgressCallback;
      skipObservation?: boolean;
      skipUiStability?: boolean;
    }
  ): Promise<TerminateAppResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("terminateApp");

    // Physical iOS devices (00008XXX / 40-char UDID) can't be driven by simctl;
    // route them through devicectl instead. Simulators keep the simctl path.
    const terminateLogic = isIosSimulatorUdid(this.device.deviceId)
      ? () => this.terminateSimulator(bundleId, perf)
      : () => this.terminatePhysicalDevice(bundleId, perf);

    if (options?.skipObservation) {
      return terminateLogic();
    }

    return this.observedInteraction(
      terminateLogic,
      {
        changeExpected: false,
        progress: options?.progress,
        skipUiStability: options?.skipUiStability,
        perf
      }
    );
  }

  /**
   * Simulator terminate via simctl (unchanged from the original iOS path):
   * check install via `simctl listapps`, then `simctl terminate`, treating a
   * "nothing to terminate" error as wasRunning=false.
   */
  private async terminateSimulator(
    bundleId: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>
  ): Promise<TerminateAppResult> {
    const installedApps = await perf.track("checkInstalled", () => this.simctl.listApps(this.device.deviceId));
    const wasInstalled = installedApps.some(app => this.getBundleId(app) === bundleId);

    if (!wasInstalled) {
      perf.end();
      return {
        success: true,
        packageName: bundleId,
        wasInstalled: false,
        wasRunning: false,
        wasForeground: false
      };
    }

    let wasRunning = true;
    let errorMessage: string | undefined;

    try {
      await perf.track("terminateApp", () => this.simctl.terminateApp(bundleId, this.device.deviceId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isSimctlNotRunningError(message)) {
        wasRunning = false;
      } else {
        errorMessage = message;
      }
    }

    perf.end();
    return {
      success: !errorMessage,
      packageName: bundleId,
      wasInstalled: true,
      wasRunning,
      wasForeground: false,
      ...(errorMessage ? { error: errorMessage } : {})
    };
  }

  /**
   * Physical iOS device terminate via devicectl (iOS 17+). The injected
   * terminator resolves the bundle id to a PID and force-kills it (SIGKILL),
   * reporting install/running status. Matches Android `am force-stop` semantics
   * for `wasRunning`. A devicectl / macOS-guard / iOS<=16 failure surfaces as a
   * clear, non-crashing `success:false` result rather than throwing.
   */
  private async terminatePhysicalDevice(
    bundleId: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>
  ): Promise<TerminateAppResult> {
    try {
      const { wasInstalled, wasRunning } = await perf.track(
        "terminateApp",
        () => this.deviceTerminator.terminateApp(this.device.deviceId, bundleId)
      );
      perf.end();
      return {
        success: true,
        packageName: bundleId,
        wasInstalled,
        wasRunning,
        wasForeground: false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Return a typed failure (matching the simulator path) instead of throwing,
      // but log first so the trace survives even when the client only sees the
      // summarized error (CLAUDE.md error-handling convention #2).
      logger.warn(`[TerminateApp] Physical iOS terminate failed for ${bundleId}: ${message}`, error);
      perf.end();
      // Omit wasInstalled/wasRunning: install state is unknown at throw time (a
      // devicectl failure can occur after the app was confirmed installed), so
      // reporting them as `false` would assert a fact we never established.
      return {
        success: false,
        packageName: bundleId,
        wasForeground: false,
        error: message
      };
    }
  }

  private isSimctlNotRunningError(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes("no such process")
      || normalized.includes("not running")
      || normalized.includes("found nothing to terminate");
  }

  private getBundleId(app: any): string | undefined {
    if (!app || typeof app !== "object") {
      return undefined;
    }
    if (typeof app.bundleId === "string" && app.bundleId.trim().length > 0) {
      return app.bundleId;
    }
    if (typeof app.bundleIdentifier === "string" && app.bundleIdentifier.trim().length > 0) {
      return app.bundleIdentifier;
    }
    if (typeof app.CFBundleIdentifier === "string" && app.CFBundleIdentifier.trim().length > 0) {
      return app.CFBundleIdentifier;
    }
    return undefined;
  }
}
