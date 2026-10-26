import { ActionableError } from "../../models/ActionableError";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import { parseAndroidRuntimePermissions } from "./parseAndroidRuntimePermissions";
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
  userId?: number;
}

type NotificationAppOpMode = "allow" | "deny" | "ignore" | "default" | "foreground";

/** Parse the package-mode line from `cmd appops get <pkg> POST_NOTIFICATION`. */
export function parseNotificationAppOpMode(stdout: string): NotificationAppOpMode | undefined {
  if (stdout.trim() === "No operations.") {
    return "default";
  }
  const mode = stdout.match(/^\s*POST_NOTIFICATION:\s*(\w+)(?=\s*(?:;|$))/m)?.[1];
  return isNotificationAppOpMode(mode) ? mode : undefined;
}

function isNotificationAppOpMode(mode: string | undefined): mode is NotificationAppOpMode {
  return (
    mode === "allow" ||
    mode === "deny" ||
    mode === "ignore" ||
    mode === "default" ||
    mode === "foreground"
  );
}

/**
 * Toggles the POST_NOTIFICATIONS runtime permission on API 33+ (or unknown API),
 * and the POST_NOTIFICATION appop before API 33.
 */
export class SetAndroidNotificationsEnabled {
  private device: BootedDevice;

  private adb: AdbExecutor;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    private readonly readApiLevel: typeof readAndroidDeviceApiLevel = readAndroidDeviceApiLevel,
  ) {
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

    const quotedPackage = shellQuote(packageName);
    try {
      const apiLevel = await perf.track("readApiLevel", () => this.readApiLevel(this.adb));
      const usePermission = apiLevel === null || !Number.isFinite(apiLevel) || apiLevel >= 33;
      const userId = usePermission
        ? (
            await new AndroidUserTargetResolver(this.adb).resolve({
              explicitUserId: input.userId,
              packageName,
              installedOnly: true,
            })
          ).userId
        : undefined;
      const command = usePermission
        ? `shell pm ${input.enabled ? "grant" : "revoke"} --user ${userId} ${quotedPackage} android.permission.POST_NOTIFICATIONS`
        : `shell cmd appops set ${quotedPackage} POST_NOTIFICATION ${input.enabled ? "allow" : "deny"}`;
      await perf.track("setEnabled", async () => {
        const result = await this.adb.executeCommand(command, { noRetry: true });
        const stdout = result.stdout;
        const stderr = result.stderr ?? "";
        if (
          outputLooksLikeShellFailure(stdout, stderr) ||
          /unknown operation string/i.test(`${stdout}\n${stderr}`)
        ) {
          throw new Error(
            `${stdout}\n${stderr}`.trim() || "Notification state write reported an error",
          );
        }
      });
      await perf.track("verifyEnabled", async () => {
        if (userId !== undefined) {
          await this.verifyPermission(packageName, input.enabled, userId);
          return;
        }
        const result = await this.adb.executeCommand(
          `shell cmd appops get ${quotedPackage} POST_NOTIFICATION`,
          { noRetry: true },
        );
        if (outputLooksLikeShellFailure(result.stdout, result.stderr ?? "")) {
          throw new ActionableError(`${result.stdout}\n${result.stderr ?? ""}`.trim());
        }
        const mode = parseNotificationAppOpMode(result.stdout);
        const matches = input.enabled ? mode === "allow" : mode === "deny" || mode === "ignore";
        if (!matches) {
          throw new ActionableError(
            `Requested notifications enabled=${input.enabled}, but observed POST_NOTIFICATION mode: ${mode ?? `unrecognized (${result.stdout.trim() || "empty output"})`}. Read the app's notification settings and retry.`,
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
  private async verifyPermission(
    packageName: string,
    enabled: boolean,
    userId: number,
  ): Promise<void> {
    const result = await this.adb.executeCommand(
      `shell dumpsys package ${shellQuote(packageName)}`,
      { maxBuffer: DUMPSYS_MAX_BUFFER, noRetry: true },
    );
    const failed = outputLooksLikeShellFailure(result.stdout, result.stderr ?? "");
    const state = failed
      ? undefined
      : parseAndroidRuntimePermissions(result.stdout, packageName, userId)?.runtimePermissions.get(
          "android.permission.POST_NOTIFICATIONS",
        )?.state;
    const observed =
      state === "granted"
        ? "granted=true"
        : state === "denied"
          ? "granted=false"
          : "absent or unreadable permission row";
    if (state !== (enabled ? "granted" : "denied")) {
      throw new ActionableError(
        `Requested notifications enabled=${enabled}, but observed android.permission.POST_NOTIFICATIONS ${observed} for Android user ${userId}. Check the package's runtime permission and notification settings, then retry.`,
      );
    }
  }
}
