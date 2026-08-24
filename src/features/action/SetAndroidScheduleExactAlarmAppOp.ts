import { errorMessage } from "../../utils/describeUnknownError";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidDeviceShellToolResult, BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { shellQuote } from "../../utils/shellQuote";

const API_LEVEL_SCHEDULE_EXACT_ALARM = 31;

export type ScheduleExactAlarmAppOpMode = "allow" | "deny";

export interface SetAndroidScheduleExactAlarmAppOpInput {
  mode: ScheduleExactAlarmAppOpMode;
}

/**
 * Sets UID-level `SCHEDULE_EXACT_ALARM` appop (`adb shell appops set --uid &lt;package&gt; …`).
 * Deny is API 31+ only and best-effort; allow is required to succeed (strict).
 */
export class SetAndroidScheduleExactAlarmAppOp {
  private device: BootedDevice;

  private adb: AdbExecutor;

  constructor(device: BootedDevice, adbFactory: AdbClientFactory = defaultAdbClientFactory) {
    this.device = device;
    this.adb = adbFactory.create(device);
  }

  async execute(
    packageName: string,
    input: SetAndroidScheduleExactAlarmAppOpInput,
  ): Promise<AndroidDeviceShellToolResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("setAndroidScheduleExactAlarmAppOp");

    if (this.device.platform !== "android") {
      perf.end();
      return {
        success: false,
        appId: packageName,
        error: "setAndroidScheduleExactAlarmAppOp is only supported on Android devices",
      };
    }

    if (input.mode === "deny") {
      const apiLevel = await perf.track("readDeviceApiLevel", async () =>
        readAndroidDeviceApiLevel(this.adb),
      );
      if (apiLevel === null || apiLevel < API_LEVEL_SCHEDULE_EXACT_ALARM) {
        perf.end();
        return {
          success: true,
          appId: packageName,
          skipped: true,
          skipReason:
            apiLevel === null
              ? `Could not read API level; SCHEDULE_EXACT_ALARM deny requires API ${API_LEVEL_SCHEDULE_EXACT_ALARM}+`
              : `Device API ${apiLevel} < ${API_LEVEL_SCHEDULE_EXACT_ALARM}; skipping SCHEDULE_EXACT_ALARM deny`,
        };
      }
    }

    const cmd = `shell appops set --uid ${shellQuote(packageName)} SCHEDULE_EXACT_ALARM ${input.mode}`;

    try {
      await perf.track(`appops.${input.mode}`, async () => {
        const execResult = await this.adb.executeCommand(cmd, undefined, undefined, true);
        const stdout = execResult.stdout ?? "";
        const stderr = execResult.stderr ?? "";
        const bad = outputLooksLikeShellFailure(stdout, stderr);

        if (input.mode === "allow") {
          if (bad) {
            const message = `${stdout}\n${stderr}`.trim() || "appops allow reported an error";
            throw new Error(message);
          }
          logger.info(
            `[SetAndroidScheduleExactAlarmAppOp] SCHEDULE_EXACT_ALARM allow ok for ${packageName}`,
          );
          return;
        }

        if (bad) {
          logger.warn(
            `[SetAndroidScheduleExactAlarmAppOp] SCHEDULE_EXACT_ALARM deny non-fatal output for ${packageName}: ${stdout}\n${stderr}`,
          );
        } else {
          logger.info(
            `[SetAndroidScheduleExactAlarmAppOp] SCHEDULE_EXACT_ALARM deny ok for ${packageName}`,
          );
        }
      });
      perf.end();
      return { success: true, appId: packageName };
    } catch (cause) {
      perf.end();
      const message = errorMessage(cause);
      if (input.mode === "allow") {
        logger.warn(
          `[SetAndroidScheduleExactAlarmAppOp] allow failed for ${packageName}: ${message}`,
        );
        return { success: false, appId: packageName, error: message };
      }
      logger.warn(`[SetAndroidScheduleExactAlarmAppOp] deny threw for ${packageName}: ${message}`);
      return { success: true, appId: packageName };
    }
  }
}
