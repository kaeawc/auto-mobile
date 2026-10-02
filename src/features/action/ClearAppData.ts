import { ActionableError, BootedDevice, ClearAppDataResult } from "../../models";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { resolveIosClearDataBackend } from "../../utils/ios-cmdline-tools/IosDeviceBackend";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";

const CLEAR_APP_DATA_TIMEOUT_MS = 60_000;

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
    private readonly backendResolver = resolveIosClearDataBackend,
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
      const result = await perf.track("pmClear", async () => {
        return await adb.executeCommand(
          `shell pm clear --user ${targetUserId} ${shellQuote(packageName)}`,
          CLEAR_APP_DATA_TIMEOUT_MS,
        );
      });

      const output = `${result.stdout}${result.stderr}`.trim();
      const succeeded = result.stdout.split(/\r?\n/).some((line) => line.trim() === "Success");
      if (!succeeded) {
        const error = `Failed to clear application data: ${output || "pm clear returned no output"}`;
        logger.warn(`[ClearAppData] ${error}`);
        perf.end();
        return { success: false, packageName, userId: targetUserId, error };
      }

      logger.info(`Clearing app data was successful for user ${targetUserId}`);
      perf.end();
      return {
        success: true,
        packageName,
        userId: targetUserId,
      };
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(`[ClearAppData] Failed to clear application data: ${message}`, error);
      perf.end();
      return {
        success: false,
        packageName,
        userId: targetUserId,
        error: `Failed to clear application data: ${message}`,
      };
    }
  }

  private async executeIos(bundleId: string): Promise<ClearAppDataResult> {
    const simctl = this.simctlOverride ?? new SimCtlClient(this.device);
    return this.backendResolver(
      this.device.deviceId,
      {
        simctl,
        createReinstaller: () => this.reinstallerOverride ?? new DeviceAppManager(),
      },
      this.isSimulatorOverride,
    ).clearAppData(bundleId);
  }
}
