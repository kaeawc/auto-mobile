import { getAbortSignal } from "../../utils/AbortContext";
import { throwIfAborted } from "../../utils/toolUtils";
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

export interface SetAndroidNotificationPolicyAccessInput {
  /** When true, runs `cmd notification allow_dnd`; when false, `disallow_dnd`. A shell error in either direction is a failure. */
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
    input: SetAndroidNotificationPolicyAccessInput,
  ): Promise<AndroidDeviceShellToolResult> {
    const signal = getAbortSignal();
    throwIfAborted(signal);
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
        throwIfAborted(signal);
        const stdout = execResult.stdout;
        const stderr = execResult.stderr ?? "";
        const bad = outputLooksLikeShellFailure(stdout, stderr);

        if (bad) {
          const message = `${stdout}\n${stderr}`.trim() || `${sub} reported an error`;
          throw new Error(message);
        }
        logger.info(`[SetAndroidNotificationPolicyAccess] ${sub} ok for ${packageName}`);
      });
      perf.end();
      return { success: true, appId: packageName };
    } catch (cause) {
      perf.end();
      const message = errorMessage(cause);
      logger.warn(
        `[SetAndroidNotificationPolicyAccess] ${sub} failed for ${packageName}: ${message}`,
      );
      throwIfAborted(signal);
      return { success: false, appId: packageName, error: message };
    }
  }
}
