import { errorMessage } from "../../utils/describeUnknownError";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { UninstallAppResult } from "../../models/UninstallAppResult";
import { BootedDevice } from "../../models";
import { ListInstalledApps } from "../observe/ListInstalledApps";
import { getIosInstalledAppBundleId } from "../../utils/ios-cmdline-tools/iosInstalledApp";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { logger } from "../../utils/logger";
import { IOSCtrlProxyClient } from "../observe/ios";
import { InstalledAppsRepository, type InstalledAppsStore } from "../../db/installedAppsRepository";
import { getDbWriteBarrier } from "../../db/dbWriteBarrier";
import { getInstalledAppsCacheWriteCoordinator } from "../../db/installedAppsCacheWriteCoordinator";
import { AdbCommandTimeoutError } from "../../utils/android-cmdline-tools/AdbClient";
import { throwIfAborted } from "../../utils/toolUtils";

const ANDROID_UNINSTALL_TIMEOUT_MS = 20_000;
const ANDROID_UNINSTALL_RECOVERY_TIMEOUT_MS = 5_000;

export interface DeviceAppUninstaller {
  uninstallApp(deviceUdid: string, bundleId: string, isSimulator?: boolean): Promise<void>;
}

export class UninstallApp {
  private device: BootedDevice;
  private adbFactory: AdbClientFactory;
  private adb: AdbExecutor;
  private simctl: SimCtlClient;
  private deviceAppUninstaller: DeviceAppUninstaller;
  private installedAppsRepository: InstalledAppsStore;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    simctl: SimCtlClient | null = null,
    deviceAppUninstaller: DeviceAppUninstaller | null = null,
    installedAppsRepository: InstalledAppsStore = new InstalledAppsRepository(),
  ) {
    this.device = device;
    this.adbFactory = adbFactory;
    this.adb = adbFactory.create(device);
    this.simctl = simctl || new SimCtlClient(device);
    this.deviceAppUninstaller = deviceAppUninstaller || new DeviceAppManager();
    this.installedAppsRepository = installedAppsRepository;
  }

  private isSimulator(): boolean {
    return isIosSimulatorUdid(this.device.deviceId);
  }

  /**
   * Uninstall an app - routes to platform-specific implementation
   * @param packageName - The package name or bundle identifier to uninstall
   * @param keepData - Whether to keep app data (Android only, ignored on iOS)
   * @param userId - Optional Android user ID (auto-detected if not provided)
   */
  async execute(
    packageName: string,
    keepData: boolean = false,
    userId?: number,
    signal?: AbortSignal,
  ): Promise<UninstallAppResult> {
    throwIfAborted(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("uninstallApp");

    // Validate package name
    if (!packageName || !packageName.trim()) {
      perf.end();
      return {
        success: false,
        packageName: packageName || "",
        wasInstalled: false,
        keepData,
        error: "Invalid package name provided",
      };
    }

    switch (this.device.platform) {
      case "ios":
        return perf.track("iOSUninstall", () => this.executeiOS(packageName));
      case "android":
        return perf.track("androidUninstall", () =>
          this.executeAndroid(packageName, keepData, userId, signal),
        );
      default:
        perf.end();
        throw new Error(`Unsupported platform: ${this.device.platform}`);
    }
  }

  /**
   * Uninstall an iOS app by bundle identifier
   * @param bundleId - The bundle identifier to uninstall
   */
  private async executeiOS(bundleId: string): Promise<UninstallAppResult> {
    try {
      const simulator = this.isSimulator();

      // Check if app is installed. Keep the cache disabled so the pre-uninstall
      // check always reflects live device state (the previous executor-arg path
      // left caching off; passing the default factory would silently enable it).
      const listApps = new ListInstalledApps(this.device, this.adbFactory, this.simctl, {
        cacheEnabled: false,
      });
      // `execute()` collapses a failed listing into an empty array, which reads
      // as "the app is absent" and turns a broken listing into a silent
      // success no-op (issue #5621). Consume the detailed result so a failed
      // listing is reported as a failure instead.
      const preCheck = await listApps.executeIosDetailedResult();
      if (!preCheck.successful) {
        return {
          success: false,
          packageName: bundleId,
          keepData: false,
          error:
            `Could not determine whether ${bundleId} is installed on iOS device ` +
            `${this.device.deviceId}: the installed-app listing failed. Confirm the device ` +
            `is connected and unlocked and that Xcode command line tools are available, ` +
            `then retry.`,
        };
      }
      const installed = preCheck.apps.some((app) => getIosInstalledAppBundleId(app) === bundleId);

      if (!installed) {
        IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.clearSdkScreenIdentity(
          bundleId,
        );
        return {
          success: true,
          packageName: bundleId,
          wasInstalled: false,
          keepData: false,
        };
      }

      // Terminate app if it's running before uninstalling
      if (simulator) {
        try {
          await this.simctl.terminateApp(bundleId, this.device.deviceId);
        } catch (error) {
          logger.warn(`[UninstallApp] Failed to terminate iOS app before uninstall: ${error}`);
        }
      }

      // Uninstall the app via simctl (simulator) or devicectl (physical)
      await this.deviceAppUninstaller.uninstallApp(this.device.deviceId, bundleId, simulator);
      await this.markInstalledAppsCacheStale();

      // Verify the app was uninstalled. A listing that fails here is
      // inconclusive rather than a contradiction: the uninstall command itself
      // already succeeded, so trust it and only log the lost verification.
      const verification = await listApps.executeIosDetailedResult();
      if (!verification.successful) {
        logger.warn(
          `[UninstallApp] Could not verify removal of ${bundleId}: the post-uninstall listing failed; trusting the uninstall command`,
        );
      }
      const isStillInstalled =
        verification.successful &&
        verification.apps.some((app) => getIosInstalledAppBundleId(app) === bundleId);

      if (isStillInstalled) {
        return {
          success: false,
          packageName: bundleId,
          wasInstalled: true,
          keepData: false,
          error: "Failed to uninstall application",
        };
      }

      IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.clearSdkScreenIdentity(
        bundleId,
      );

      return {
        success: true,
        packageName: bundleId,
        wasInstalled: true,
        keepData: false, // iOS doesn't support keeping data during uninstall
      };
    } catch (error) {
      return {
        success: false,
        packageName: bundleId,
        wasInstalled: true,
        keepData: false,
        error: errorMessage(error),
      };
    }
  }

  /**
   * Uninstall an Android app by package name
   * @param packageName - The package name to uninstall
   * @param keepData - Whether to keep app data
   * @param userId - Optional Android user ID (auto-detected if not provided)
   */
  private async executeAndroid(
    packageName: string,
    keepData: boolean,
    userId?: number,
    signal?: AbortSignal,
  ): Promise<UninstallAppResult> {
    try {
      // Auto-detect target user if not specified
      const targetUserId = (
        await new AndroidUserTargetResolver(this.adb).resolve({
          packageName,
          explicitUserId: userId,
          signal,
        })
      ).userId;

      const installed = await this.isInstalledForUser(packageName, targetUserId, undefined, signal);

      if (!installed) {
        return {
          success: true,
          packageName,
          wasInstalled: false,
          keepData,
          userId: targetUserId,
        };
      }

      // TODO: query if app was running and needed to be stopped
      await this.adb.executeCommand(
        `shell am force-stop --user ${targetUserId} ${packageName}`,
        undefined,
        undefined,
        false,
        signal,
      );

      const cmd = keepData
        ? `shell pm uninstall --user ${targetUserId} -k ${packageName}`
        : `shell pm uninstall --user ${targetUserId} ${packageName}`;

      try {
        await this.adb.executeCommand(cmd, ANDROID_UNINSTALL_TIMEOUT_MS, undefined, true, signal);
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof AdbCommandTimeoutError) {
          return this.recoverTimedOutAndroidUninstall(
            packageName,
            keepData,
            targetUserId,
            cmd,
            signal,
          );
        }
        throw error;
      }

      await this.markInstalledAppsCacheStale();

      // Verify the app was uninstalled
      const isStillInstalled = await this.isInstalledForUser(
        packageName,
        targetUserId,
        undefined,
        signal,
      );

      if (isStillInstalled) {
        return {
          success: false,
          packageName,
          wasInstalled: true,
          keepData,
          userId: targetUserId,
          error: "Failed to uninstall application",
        };
      }

      return {
        success: true,
        packageName,
        wasInstalled: true,
        keepData,
        userId: targetUserId,
      };
    } catch (error) {
      throwIfAborted(signal);
      return {
        success: false,
        packageName,
        wasInstalled: true,
        keepData,
        error: errorMessage(error),
      };
    }
  }

  private async recoverTimedOutAndroidUninstall(
    packageName: string,
    keepData: boolean,
    userId: number,
    command: string,
    signal?: AbortSignal,
  ): Promise<UninstallAppResult> {
    await this.markInstalledAppsCacheStale();

    let isStillInstalled: boolean;
    try {
      isStillInstalled = await this.isInstalledForUser(
        packageName,
        userId,
        ANDROID_UNINSTALL_RECOVERY_TIMEOUT_MS,
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      return this.androidUninstallTimeoutFailure(
        packageName,
        keepData,
        userId,
        `Package-state check failed: ${errorMessage(error)}`,
      );
    }

    if (!isStillInstalled) {
      return this.successfulAndroidUninstall(packageName, keepData, userId);
    }

    logger.warn(
      `[UninstallApp] Android uninstall timed out for ${packageName} (user ${userId}); package remains installed, retrying once.`,
    );
    let retryTimedOut = false;
    try {
      await this.adb.executeCommand(
        command,
        ANDROID_UNINSTALL_RECOVERY_TIMEOUT_MS,
        undefined,
        true,
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      if (!(error instanceof AdbCommandTimeoutError)) {
        return this.androidUninstallTimeoutFailure(
          packageName,
          keepData,
          userId,
          `One bounded retry failed: ${errorMessage(error)}`,
        );
      }
      retryTimedOut = true;
    }

    await this.markInstalledAppsCacheStale();
    try {
      isStillInstalled = await this.isInstalledForUser(
        packageName,
        userId,
        ANDROID_UNINSTALL_RECOVERY_TIMEOUT_MS,
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      return this.androidUninstallTimeoutFailure(
        packageName,
        keepData,
        userId,
        `Post-retry package-state check failed: ${errorMessage(error)}`,
      );
    }

    if (!isStillInstalled) {
      return this.successfulAndroidUninstall(packageName, keepData, userId);
    }

    return this.androidUninstallTimeoutFailure(
      packageName,
      keepData,
      userId,
      retryTimedOut
        ? "Package remains installed after one bounded retry timed out."
        : "Package remains installed after one bounded retry.",
    );
  }

  private successfulAndroidUninstall(
    packageName: string,
    keepData: boolean,
    userId: number,
  ): UninstallAppResult {
    return {
      success: true,
      packageName,
      wasInstalled: true,
      keepData,
      userId,
    };
  }

  private androidUninstallTimeoutFailure(
    packageName: string,
    keepData: boolean,
    userId: number,
    detail: string,
  ): UninstallAppResult {
    return {
      success: false,
      packageName,
      wasInstalled: true,
      keepData,
      userId,
      error: `Android uninstall timed out after ${ANDROID_UNINSTALL_TIMEOUT_MS}ms for package ${packageName} (user ${userId}). ${detail}`,
    };
  }

  private async isInstalledForUser(
    packageName: string,
    userId: number,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.adb.executeCommand(
      `shell pm list packages --user ${userId}`,
      timeoutMs,
      undefined,
      true,
      signal,
    );
    return result.stdout.split("\n").some((line) => line.trim() === `package:${packageName}`);
  }

  private async markInstalledAppsCacheStale(): Promise<void> {
    try {
      await getInstalledAppsCacheWriteCoordinator().invalidate(this.device.deviceId, () =>
        getDbWriteBarrier()
          .track(() => this.installedAppsRepository.markDeviceStale(this.device.deviceId))
          .then(() => undefined),
      );
    } catch (error) {
      logger.warn(`[UninstallApp] Failed to invalidate installed apps cache: ${error}`);
    }
  }
}
