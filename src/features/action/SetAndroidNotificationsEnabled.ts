import { errorMessage } from "../../utils/describeUnknownError";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidDeviceShellToolResult, BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { shellQuote } from "../../utils/shellQuote";

export interface SetAndroidNotificationsEnabledInput {
  enabled: boolean;
}

/**
 * Enables or disables notifications for a package independently of its
 * POST_NOTIFICATIONS runtime permission.
 */
export class SetAndroidNotificationsEnabled {
  private device: BootedDevice;

  private adb: AdbExecutor;

  constructor(device: BootedDevice, adbFactory: AdbClientFactory = defaultAdbClientFactory) {
    this.device = device;
    this.adb = adbFactory.create(device);
  }

  async execute(
    packageName: string,
    input: SetAndroidNotificationsEnabledInput,
  ): Promise<AndroidDeviceShellToolResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("setAndroidNotificationsEnabled");

    if (this.device.platform !== "android") {
      perf.end();
      return {
        success: false,
        appId: packageName,
        error: "setAndroidNotificationsEnabled is only supported on Android devices",
      };
    }

    const command = `shell cmd notification set_enabled ${shellQuote(packageName)} ${input.enabled}`;
    try {
      await perf.track("setEnabled", async () => {
        const result = await this.adb.executeCommand(command, undefined, undefined, true);
        const stdout = result.stdout ?? "";
        const stderr = result.stderr ?? "";
        if (outputLooksLikeShellFailure(stdout, stderr)) {
          throw new Error(
            `${stdout}\n${stderr}`.trim() || "cmd notification set_enabled reported an error",
          );
        }
      });
      logger.info(
        `[SetAndroidNotificationsEnabled] ${input.enabled ? "enabled" : "disabled"} notifications for ${packageName}`,
      );
      return { success: true, appId: packageName };
    } catch (cause) {
      const message = errorMessage(cause);
      logger.warn(`[SetAndroidNotificationsEnabled] failed for ${packageName}: ${message}`);
      return { success: false, appId: packageName, error: message };
    } finally {
      perf.end();
    }
  }
}
