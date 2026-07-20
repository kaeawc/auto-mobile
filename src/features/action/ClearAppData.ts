import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { BootedDevice, ClearAppDataResult } from "../../models";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";

export class ClearAppData {
  private device: BootedDevice;
  private adb: AdbExecutor;

  constructor(device: BootedDevice, adbFactory: AdbClientFactory = defaultAdbClientFactory) {
    this.device = device;
    this.adb = adbFactory.create(device);
  }

  async execute(
    packageName: string,
    userId?: number
  ): Promise<ClearAppDataResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("clearAppData");

    // Auto-detect target user if not specified
    const targetUserId = await perf.track("detectTargetUser", async () => {
      return (await new AndroidUserTargetResolver(this.adb).resolve({
        packageName,
        explicitUserId: userId,
      })).userId;
    });

    try {
      // pm clear both clears data AND stops the app, no need for separate force-stop
      await perf.track("pmClear", async () => {
        await this.adb.executeCommand(`shell pm clear --user ${targetUserId} ${packageName}`);
        logger.info(`Clearing app data was successful for user ${targetUserId}`);
      });

      perf.end();
      return {
        success: true,
        packageName,
        userId: targetUserId
      };
    } catch {
      perf.end();
      return {
        success: false,
        packageName,
        userId: targetUserId,
        error: "Failed to clear application data"
      };
    }
  }
}
