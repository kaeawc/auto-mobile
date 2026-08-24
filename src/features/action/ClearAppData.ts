import { ActionableError, BootedDevice, ClearAppDataResult } from "../../models";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import {
  getAppDataContainerPath,
  IOS_APP_DATA_FOLDERS,
  terminateAppIfRunning,
} from "../../utils/ios-cmdline-tools/iosAppContainer";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { promises as fs } from "fs";
import * as path from "path";

/** Reinstall-based data clear for physical iOS devices (devicectl). */
export interface IosAppReinstaller {
  clearAppDataViaReinstall(deviceUdid: string, bundleId: string): Promise<void>;
}

/**
 * Clears an app's data, dispatching on device platform:
 *
 * - **Android**: `pm clear` for the resolved target user (also stops the app).
 * - **iOS simulator**: resolve the app's data container via
 *   `simctl get_app_container` and delete its standard data folders. The app
 *   stays installed, so there is no reinstall and no loss of TCC/permission
 *   grants. (~100-300ms)
 * - **iOS physical device**: iOS exposes no on-device data wipe, so we
 *   uninstall and reinstall via `devicectl` (copying the device-signed bundle
 *   off first). The app returns in a fresh state. Slower, and permission grants
 *   are reset.
 *
 * On iOS the app is terminated before clearing on the simulator (uninstall
 * terminates it on physical devices). The `userId` argument is Android-only and
 * is ignored on iOS.
 */
export class ClearAppData {
  private device: BootedDevice;
  private adbFactory: AdbClientFactory;
  private simctlOverride?: SimCtlClient;
  private reinstallerOverride?: IosAppReinstaller;
  private isSimulatorOverride?: () => boolean;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    simctl?: SimCtlClient,
    reinstaller?: IosAppReinstaller,
    isSimulatorFn?: () => boolean,
  ) {
    this.device = device;
    this.adbFactory = adbFactory;
    this.simctlOverride = simctl;
    this.reinstallerOverride = reinstaller;
    this.isSimulatorOverride = isSimulatorFn;
  }

  async execute(packageName: string, userId?: number): Promise<ClearAppDataResult> {
    switch (this.device.platform) {
      case "android":
        return this.executeAndroid(packageName, userId);
      case "ios":
        return this.executeIos(packageName);
      default:
        throw new ActionableError(
          `Clear app data is not supported for platform '${this.device.platform}'`,
        );
    }
  }

  private async executeAndroid(packageName: string, userId?: number): Promise<ClearAppDataResult> {
    const adb: AdbExecutor = this.adbFactory.create(this.device);
    const perf = createGlobalPerformanceTracker();
    perf.serial("clearAppData");

    // Auto-detect target user if not specified
    const targetUserId = await perf.track("detectTargetUser", async () => {
      return (
        await new AndroidUserTargetResolver(adb).resolve({
          packageName,
          explicitUserId: userId,
        })
      ).userId;
    });

    try {
      // pm clear both clears data AND stops the app, no need for separate force-stop
      await perf.track("pmClear", async () => {
        await adb.executeCommand(`shell pm clear --user ${targetUserId} ${packageName}`);
        logger.info(`Clearing app data was successful for user ${targetUserId}`);
      });

      perf.end();
      return {
        success: true,
        packageName,
        userId: targetUserId,
      };
    } catch {
      perf.end();
      return {
        success: false,
        packageName,
        userId: targetUserId,
        error: "Failed to clear application data",
      };
    }
  }

  private async executeIos(bundleId: string): Promise<ClearAppDataResult> {
    const simctl = this.simctlOverride ?? new SimCtlClient(this.device);
    const isSimulator =
      this.isSimulatorOverride ?? (() => isIosSimulatorUdid(this.device.deviceId));
    return isSimulator()
      ? this.clearIosSimulator(simctl, bundleId)
      : this.clearIosPhysical(bundleId);
  }

  private async clearIosSimulator(
    simctl: SimCtlClient,
    bundleId: string,
  ): Promise<ClearAppDataResult> {
    logger.info(`[iOS] Clearing app data for ${bundleId} on simulator ${this.device.deviceId}`);

    // The container can't be safely wiped while the app holds open file handles.
    await terminateAppIfRunning(simctl, this.device.deviceId, bundleId);

    const containerPath = await getAppDataContainerPath(simctl, this.device.deviceId, bundleId);
    if (!containerPath) {
      return {
        success: false,
        packageName: bundleId,
        error: `Could not resolve data container for ${bundleId} (is it installed?)`,
      };
    }

    try {
      // Folders are independent — wipe them concurrently. force:true so a missing
      // folder (e.g. an app that never wrote Documents) is a no-op, not an error.
      await Promise.all(
        IOS_APP_DATA_FOLDERS.map((folder) =>
          fs.rm(path.join(containerPath, folder), { recursive: true, force: true }),
        ),
      );
      logger.info(`[iOS] Cleared app data for ${bundleId}`);
      return { success: true, packageName: bundleId };
    } catch (error) {
      logger.warn(`[iOS] Failed to clear app data for ${bundleId}: ${errorMessage(error)}`);
      return { success: false, packageName: bundleId, error: errorMessage(error) };
    }
  }

  private async clearIosPhysical(bundleId: string): Promise<ClearAppDataResult> {
    logger.info(
      `[iOS] Clearing app data for ${bundleId} via devicectl uninstall+reinstall on ${this.device.deviceId}`,
    );
    const reinstaller = this.reinstallerOverride ?? new DeviceAppManager();
    try {
      await reinstaller.clearAppDataViaReinstall(this.device.deviceId, bundleId);
      logger.info(`[iOS] Cleared app data for ${bundleId} (reinstalled)`);
      return { success: true, packageName: bundleId };
    } catch (error) {
      logger.warn(
        `[iOS] Failed to clear app data for ${bundleId} via reinstall: ${errorMessage(error)}`,
      );
      return { success: false, packageName: bundleId, error: errorMessage(error) };
    }
  }
}
