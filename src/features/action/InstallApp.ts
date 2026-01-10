import path from "path";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BootedDevice } from "../../models";
import { createGlobalPerformanceTracker, type PerformanceTracker } from "../../utils/PerformanceTracker";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../../utils/HostCommandExecutor";
import { DefaultAndroidBuildToolsLocator, type AndroidBuildToolsLocator } from "../../utils/android-cmdline-tools/AndroidBuildToolsLocator";
import { OPERATION_CANCELLED_MESSAGE } from "../../utils/constants";

export class InstallApp {
  private adb: AdbExecutor;
  private hostExecutor: HostCommandExecutor;
  private buildToolsLocator: AndroidBuildToolsLocator;
  private createPerformanceTracker: () => PerformanceTracker;

  /**
   * Create an InstallApp instance
   * @param device - Optional device
   * @param adb - Optional AdbExecutor instance for testing
   * @param hostExecutor - Optional host command executor for testing
   * @param buildToolsLocator - Optional build tools locator for testing
   * @param performanceTrackerFactory - Optional performance tracker factory for testing
   */
  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    hostExecutor: HostCommandExecutor | null = null,
    buildToolsLocator: AndroidBuildToolsLocator | null = null,
    performanceTrackerFactory: () => PerformanceTracker = createGlobalPerformanceTracker
  ) {
    this.adb = adb || new AdbClient(device);
    this.hostExecutor = hostExecutor || new DefaultHostCommandExecutor();
    this.buildToolsLocator = buildToolsLocator || new DefaultAndroidBuildToolsLocator();
    this.createPerformanceTracker = performanceTrackerFactory;
  }

  /**
   * Install an APK file
   * @param apkPath - Path to the APK file
   * @param userId - Optional Android user ID (auto-detected if not provided)
   */
  async execute(
    apkPath: string,
    userId?: number,
    signal?: AbortSignal
  ): Promise<{ success: boolean; upgrade: boolean; userId: number }> {
    const perf = this.createPerformanceTracker();
    perf.serial("installApp");

    if (!path.isAbsolute(apkPath)) {
      apkPath = path.resolve(process.cwd(), apkPath);
    }

    // Extract package name from APK
    const packageName = await perf.track("extractPackageName", async () => {
      return this.extractPackageName(apkPath, signal);
    });
    const normalizedPackageName = packageName.trim();

    // Auto-detect target user if not specified
    const targetUserId = await perf.track("detectTargetUser", async () => {
      if (userId !== undefined) {
        return userId;
      }

      // Check if app is in foreground and get its user
      const foregroundApp = await this.adb.getForegroundApp(signal);
      if (foregroundApp && foregroundApp.packageName === normalizedPackageName) {
        return foregroundApp.userId;
      }

      // Get list of users and prefer work profile
      const users = await this.adb.listUsers(signal);

      // Find first work profile (flags 30 typically indicates managed/work profile)
      const workProfile = users.find(u => u.userId > 0 && u.running);
      if (workProfile) {
        return workProfile.userId;
      }

      // Fall back to primary user
      return 0;
    });

    // Check if app is already installed for this user
    const isInstalled = await perf.track("checkInstalled", async () => {
      const isInstalledCmd = `shell pm list packages --user ${targetUserId} -f ${normalizedPackageName} | grep -c ${normalizedPackageName}`;
      const isInstalledOutput = await this.adb.executeCommand(isInstalledCmd, undefined, undefined, true, signal);
      return parseInt(isInstalledOutput.trim(), 10) > 0;
    });

    const success = await perf.track("adbInstall", async () => {
      const installOutput = await this.adb.executeCommand(`install --user ${targetUserId} -r "${apkPath}"`, undefined, undefined, undefined, signal);
      return installOutput.includes("Success");
    });

    perf.end();
    return {
      success: success,
      upgrade: isInstalled && success,
      userId: targetUserId
    };
  }

  private async extractPackageName(apkPath: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    const tool = await this.buildToolsLocator.findAaptTool();
    if (!tool) {
      throw new Error("Unable to locate aapt2 or aapt. Install Android SDK build-tools and ensure they are on PATH or under ANDROID_HOME.");
    }

    const result = await this.hostExecutor.executeCommand(tool.path, ["dump", "badging", apkPath]);
    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/package:\s+name='([^']+)'/);
    if (!match) {
      throw new Error(`Failed to extract package name from ${tool.tool} output.`);
    }

    return match[1];
  }
}
