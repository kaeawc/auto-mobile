import { ActionableError, BootedDevice, ClearAppDataResult } from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { getAppDataContainerPath, IOS_APP_DATA_FOLDERS, terminateAppIfRunning } from "../../utils/ios-cmdline-tools/iosAppContainer";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { logger } from "../../utils/logger";
import { promises as fs } from "fs";
import * as path from "path";

/** Reinstall-based data clear for physical iOS devices (devicectl). */
export interface IosAppReinstaller {
  clearAppDataViaReinstall(deviceUdid: string, bundleId: string): Promise<void>;
}

/**
 * Clears an iOS app's data, picking the fastest mechanism per device type:
 *
 * - **Simulator**: resolve the app's data container via `simctl get_app_container`
 *   and delete its standard data folders. The app stays installed, so there is
 *   no reinstall and no loss of TCC/permission grants. (~100-300ms)
 * - **Physical device**: iOS exposes no on-device data wipe, so we uninstall and
 *   reinstall via `devicectl` (copying the device-signed bundle off first). The
 *   app returns in a fresh state. Slower, and permission grants are reset.
 *
 * The app is terminated before clearing on the simulator (uninstall terminates
 * it on physical devices).
 */
export class ClearAppDataIos {
  private device: BootedDevice;
  private simctl: SimCtlClient;
  private reinstaller: IosAppReinstaller;
  private isSimulator: () => boolean;

  constructor(
    device: BootedDevice,
    simctl?: SimCtlClient,
    reinstaller?: IosAppReinstaller,
    isSimulatorFn?: () => boolean
  ) {
    if (device.platform !== "ios") {
      throw new ActionableError("ClearAppDataIos is only supported for iOS devices");
    }
    this.device = device;
    this.simctl = simctl || new SimCtlClient(device);
    this.reinstaller = reinstaller || new DeviceAppManager();
    this.isSimulator = isSimulatorFn || (() => isIosSimulatorUdid(device.deviceId));
  }

  async execute(bundleId: string): Promise<ClearAppDataResult> {
    return this.isSimulator()
      ? this.clearSimulator(bundleId)
      : this.clearPhysical(bundleId);
  }

  private async clearSimulator(bundleId: string): Promise<ClearAppDataResult> {
    logger.info(`[iOS] Clearing app data for ${bundleId} on simulator ${this.device.deviceId}`);

    // The container can't be safely wiped while the app holds open file handles.
    await terminateAppIfRunning(this.simctl, this.device.deviceId, bundleId);

    const containerPath = await getAppDataContainerPath(this.simctl, this.device.deviceId, bundleId);
    if (!containerPath) {
      return {
        success: false,
        packageName: bundleId,
        error: `Could not resolve data container for ${bundleId} (is it installed?)`
      };
    }

    try {
      // Folders are independent — wipe them concurrently. force:true so a missing
      // folder (e.g. an app that never wrote Documents) is a no-op, not an error.
      await Promise.all(IOS_APP_DATA_FOLDERS.map(folder =>
        fs.rm(path.join(containerPath, folder), { recursive: true, force: true })
      ));
      logger.info(`[iOS] Cleared app data for ${bundleId}`);
      return { success: true, packageName: bundleId };
    } catch (error) {
      logger.warn(`[iOS] Failed to clear app data for ${bundleId}: ${error}`);
      return { success: false, packageName: bundleId, error: (error as Error).message };
    }
  }

  private async clearPhysical(bundleId: string): Promise<ClearAppDataResult> {
    logger.info(`[iOS] Clearing app data for ${bundleId} via devicectl uninstall+reinstall on ${this.device.deviceId}`);
    try {
      await this.reinstaller.clearAppDataViaReinstall(this.device.deviceId, bundleId);
      logger.info(`[iOS] Cleared app data for ${bundleId} (reinstalled)`);
      return { success: true, packageName: bundleId };
    } catch (error) {
      logger.warn(`[iOS] Failed to clear app data for ${bundleId} via reinstall: ${error}`);
      return { success: false, packageName: bundleId, error: (error as Error).message };
    }
  }
}
