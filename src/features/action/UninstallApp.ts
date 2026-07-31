import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { UninstallAppResult } from "../../models/UninstallAppResult";
import { BootedDevice } from "../../models";
import { ListInstalledApps } from "../observe/ListInstalledApps";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { logger } from "../../utils/logger";
import { IOSCtrlProxyClient } from "../observe/ios";
import { InstalledAppsRepository, type InstalledAppsStore } from "../../db/installedAppsRepository";
import { getDbWriteBarrier } from "../../db/dbWriteBarrier";
import { getInstalledAppsCacheWriteCoordinator } from "../../db/installedAppsCacheWriteCoordinator";

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
    installedAppsRepository: InstalledAppsStore = new InstalledAppsRepository()
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
    userId?: number
  ): Promise<UninstallAppResult> {
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
        error: "Invalid package name provided"
      };
    }

    switch (this.device.platform) {
      case "ios":
        return perf.track("iOSUninstall", () => this.executeiOS(packageName));
      case "android":
        return perf.track("androidUninstall", () => this.executeAndroid(packageName, keepData, userId));
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
      const listApps = new ListInstalledApps(this.device, this.adbFactory, this.simctl, { cacheEnabled: false });
      const installed = (await listApps.execute()).find(app => app === bundleId) !== undefined;

      if (!installed) {
        IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.clearSdkScreenIdentity(bundleId);
        return {
          success: true,
          packageName: bundleId,
          wasInstalled: false,
          keepData: false
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

      // Verify the app was uninstalled
      const isStillInstalled = (await listApps.execute()).find(app => app === bundleId) !== undefined;

      if (isStillInstalled) {
        return {
          success: false,
          packageName: bundleId,
          wasInstalled: true,
          keepData: false,
          error: "Failed to uninstall application"
        };
      }

      IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.clearSdkScreenIdentity(bundleId);

      return {
        success: true,
        packageName: bundleId,
        wasInstalled: true,
        keepData: false // iOS doesn't support keeping data during uninstall
      };
    } catch (error) {
      return {
        success: false,
        packageName: bundleId,
        wasInstalled: true,
        keepData: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Uninstall an Android app by package name
   * @param packageName - The package name to uninstall
   * @param keepData - Whether to keep app data
   * @param userId - Optional Android user ID (auto-detected if not provided)
   */
  private async executeAndroid(packageName: string, keepData: boolean, userId?: number): Promise<UninstallAppResult> {
    try {
      // Auto-detect target user if not specified
      const targetUserId = (await new AndroidUserTargetResolver(this.adb).resolve({ packageName, explicitUserId: userId })).userId;

      const installed = await this.isInstalledForUser(packageName, targetUserId);

      if (!installed) {
        return {
          success: true,
          packageName,
          wasInstalled: false,
          keepData,
          userId: targetUserId
        };
      }

      // TODO: query if app was running and needed to be stopped
      await this.adb.executeCommand(`shell am force-stop --user ${targetUserId} ${packageName}`);

      const cmd = keepData ?
        `shell pm uninstall --user ${targetUserId} -k ${packageName}` :
        `shell pm uninstall --user ${targetUserId} ${packageName}`;

      await this.adb.executeCommand(cmd);

      await this.markInstalledAppsCacheStale();

      // Verify the app was uninstalled
      const isStillInstalled = await this.isInstalledForUser(packageName, targetUserId);

      if (isStillInstalled) {
        return {
          success: false,
          packageName,
          wasInstalled: true,
          keepData,
          userId: targetUserId,
          error: "Failed to uninstall application"
        };
      }

      return {
        success: true,
        packageName,
        wasInstalled: true,
        keepData,
        userId: targetUserId
      };
    } catch (error) {
      return {
        success: false,
        packageName,
        wasInstalled: true,
        keepData,
        error: "Error occurred during application uninstallation"
      };
    }
  }

  private async isInstalledForUser(packageName: string, userId: number): Promise<boolean> {
    const result = await this.adb.executeCommand(
      `shell pm list packages --user ${userId}`,
      undefined,
      undefined,
      true
    );
    return result.stdout.split("\n").some(line => line.trim() === `package:${packageName}`);
  }

  private async markInstalledAppsCacheStale(): Promise<void> {
    try {
      await getInstalledAppsCacheWriteCoordinator().invalidate(this.device.deviceId, () =>
        getDbWriteBarrier().track(() =>
          this.installedAppsRepository.markDeviceStale(this.device.deviceId)
        ).then(() => undefined)
      );
    } catch (error) {
      logger.warn(`[UninstallApp] Failed to invalidate installed apps cache: ${error}`);
    }
  }
}
