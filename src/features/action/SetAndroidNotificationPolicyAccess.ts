import { errorMessage } from "../../utils/describeUnknownError";
import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidDeviceShellToolResult, BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { shellQuote } from "../../utils/shellQuote";


export interface SetAndroidNotificationPolicyAccessInput {
  /** When true, runs `cmd notification allow_dnd`; when false, `disallow_dnd` (best-effort). */
  allowed: boolean;
}


/**
 * Toggle notification policy access (Do Not Disturb / interruption filter) for a package via
 * `adb shell cmd notification allow_dnd|disallow_dnd`.
 */
export class SetAndroidNotificationPolicyAccess {
  private device: BootedDevice;

  private adb: AdbExecutor;

  constructor(device: BootedDevice, adbFactory: AdbClientFactory = defaultAdbClientFactory) {
    this.device = device;
    this.adb = adbFactory.create(device);
  }

  async execute(
    packageName: string,
    input: SetAndroidNotificationPolicyAccessInput
  ): Promise<AndroidDeviceShellToolResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("setAndroidNotificationPolicyAccess");

    if (this.device.platform !== "android") {
      perf.end();
      return {
        success: false,
        appId: packageName,
        error: "setAndroidNotificationPolicyAccess is only supported on Android devices",
      };
    }

    const sub = input.allowed ? "allow_dnd" : "disallow_dnd";
    const cmd = `shell cmd notification ${sub} ${shellQuote(packageName)}`;

    try {
      await perf.track(sub, async () => {
        const execResult = await this.adb.executeCommand(cmd, undefined, undefined, true);
        const stdout = execResult.stdout ?? "";
        const stderr = execResult.stderr ?? "";
        const bad = outputLooksLikeShellFailure(stdout, stderr);

        if (input.allowed) {
          if (bad) {
            const message = `${stdout}\n${stderr}`.trim() || "allow_dnd reported an error";
            throw new Error(message);
          }
          logger.info(`[SetAndroidNotificationPolicyAccess] allow_dnd ok for ${packageName}`);
          return;
        }

        if (bad) {
          logger.warn(
            `[SetAndroidNotificationPolicyAccess] disallow_dnd non-fatal output for ${packageName}: ${stdout}\n${stderr}`
          );
        } else {
          logger.info(`[SetAndroidNotificationPolicyAccess] disallow_dnd ok for ${packageName}`);
        }
      });
      perf.end();
      return { success: true, appId: packageName };
    } catch (cause) {
      perf.end();
      const message = errorMessage(cause);
      if (input.allowed) {
        logger.warn(`[SetAndroidNotificationPolicyAccess] allow_dnd failed for ${packageName}: ${message}`);
        return { success: false, appId: packageName, error: message };
      }
      logger.warn(`[SetAndroidNotificationPolicyAccess] disallow_dnd threw for ${packageName}: ${message}`);
      return { success: true, appId: packageName };
    }
  }
}
