import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import {
  type AndroidPackagePermissionState,
  parseAndroidRuntimePermissions,
} from "./parseAndroidRuntimePermissions";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { isPackageInstalledForUser } from "../../utils/android-cmdline-tools/isPackageInstalledForUser";
import {
  ActionableError,
  BootedDevice,
  GrantAndroidPermissionItemResult,
  GrantAndroidPermissionsResult,
} from "../../models";
import { logger } from "../../utils/logger";
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../../utils/PerformanceTracker";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { shellQuote } from "../../utils/shellQuote";

export type AndroidPermissionChangeAction = "grant" | "revoke" | "reset";

export interface GrantAndroidPermissionsInput {
  action?: AndroidPermissionChangeAction;
  permissions: string[];
  userId?: number;
}

/**
 * Expands a bare platform permission constant (`CAMERA`, `POST_NOTIFICATIONS`)
 * to its `android.permission.` form; dotted names pass through unchanged (#10791).
 */
export function normalizeAndroidPermissionName(permission: string): string {
  const trimmed = permission.trim();
  return /^[A-Z][A-Z0-9_]*$/.test(trimmed) ? `android.permission.${trimmed}` : trimmed;
}

export class GrantAndroidPermissions {
  private device: BootedDevice;

  private adb: AdbExecutor;

  private createPerformanceTracker: () => PerformanceTracker;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    performanceTrackerFactory: () => PerformanceTracker = createGlobalPerformanceTracker,
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.createPerformanceTracker = performanceTrackerFactory;
  }

  async execute(
    packageName: string,
    input: GrantAndroidPermissionsInput,
  ): Promise<GrantAndroidPermissionsResult> {
    const perf = this.createPerformanceTracker();
    perf.serial("changeAndroidPermissions");

    const permissions = input.permissions ?? [];
    const action = input.action ?? "grant";

    if (this.device.platform !== "android") {
      perf.end();
      return {
        success: false,
        appId: packageName,
        userId: input.userId ?? 0,
        results: [],
        error: "Android permission changes are only supported on Android devices",
      };
    }

    if (action === "reset") {
      return this.resetPermissions(packageName, permissions, input.userId, perf);
    }

    return this.changePermissions(packageName, permissions, input.userId, action, perf);
  }

  private async changePermissions(
    packageName: string,
    permissions: string[],
    userId: number | undefined,
    action: Exclude<AndroidPermissionChangeAction, "reset">,
    perf: PerformanceTracker,
  ): Promise<GrantAndroidPermissionsResult> {
    if (permissions.length === 0) {
      perf.end();
      return {
        success: false,
        appId: packageName,
        userId: userId ?? 0,
        results: [],
        error: "Provide at least one permission in `permissions`",
      };
    }

    let targetUserId: number;
    const results: GrantAndroidPermissionItemResult[] = [];

    try {
      targetUserId = await perf.track("detectTargetUser", async () => {
        return (
          await new AndroidUserTargetResolver(this.adb).resolve({
            explicitUserId: userId,
            packageName,
            installedOnly: true,
          })
        ).userId;
      });

      // The resolver preserves the default user when no running user has the app.
      if (
        userId === undefined &&
        !(await isPackageInstalledForUser(this.adb, packageName, targetUserId))
      ) {
        throw new ActionableError(
          `App ${packageName} is not installed for Android user ${targetUserId}; install the app or specify userId for the user where it is installed`,
        );
      }

      const before = await this.readPermissionState(packageName, targetUserId);
      const attempted: Array<{ item: GrantAndroidPermissionItemResult; output: string }> = [];
      const seen = new Set<string>();
      for (const permission of permissions) {
        const item = this.classifyPermission(permission, before, {
          packageName,
          action,
        });
        results.push(item);
        if (item.error || item.skipped) {
          continue;
        }
        if (seen.has(item.permission!)) {
          item.success = true;
          item.skipped = true;
          item.skipReason = "duplicate permission";
          continue;
        }
        seen.add(item.permission!);
        const output = await this.runPermissionCommand(
          packageName,
          targetUserId,
          action,
          item,
          perf,
        );
        attempted.push({ item, output });
      }
      await this.verifyPermissions(packageName, targetUserId, action, attempted, before);
    } finally {
      perf.end();
    }

    const success = results.every((r) => r.skipped || r.success || r.countsTowardSuccess === false);

    const failedRequired = results.filter((r) => r.countsTowardSuccess && !r.skipped && !r.success);

    return {
      success,
      appId: packageName,
      userId: targetUserId,
      results,
      ...(success
        ? {}
        : {
            error:
              failedRequired.length > 0
                ? `Failed step(s): ${failedRequired.map((f) => f.stepId).join(", ")}`
                : "One or more required Android permission changes failed",
          }),
    };
  }

  private classifyPermission(
    permission: string,
    before: AndroidPackagePermissionState,
    context: { packageName: string; action: "grant" | "revoke" },
  ): GrantAndroidPermissionItemResult {
    const trimmed = normalizeAndroidPermissionName(permission);
    const { packageName, action } = context;
    const item: GrantAndroidPermissionItemResult = {
      stepId: `pm_${action}:${trimmed || "(empty)"}`,
      permission: trimmed || permission,
      success: false,
      countsTowardSuccess: true,
    };
    if (!trimmed) {
      item.error = "empty permission name";
    } else if (!before.requestedPermissions.has(trimmed)) {
      item.error = `${trimmed} is not requested by ${packageName} (not declared in its manifest); nothing was changed`;
    } else if (
      (before.runtimePermissions.get(trimmed) ?? before.installPermissions.get(trimmed))?.state ===
      (action === "grant" ? "granted" : "denied")
    ) {
      item.success = true;
      item.skipped = true;
      item.skipReason = action === "grant" ? "already granted" : "already revoked";
    }
    return item;
  }

  private async runPermissionCommand(
    packageName: string,
    userId: number,
    action: "grant" | "revoke",
    item: GrantAndroidPermissionItemResult,
    perf: PerformanceTracker,
  ): Promise<string> {
    try {
      const cmd = `shell pm ${action} --user ${userId} ${shellQuote(packageName)} ${shellQuote(item.permission!)}`;
      const result = await perf.track(
        `pm${action[0].toUpperCase()}${action.slice(1)}:${item.permission}`,
        () => this.adb.executeCommand(cmd, undefined, undefined, true),
      );
      const output = `${result.stdout}\n${result.stderr ?? ""}`.trim();
      if (outputLooksLikeShellFailure(result.stdout, result.stderr ?? "")) {
        item.error = output || `pm ${action} reported an error`;
        logger.warn(
          `[GrantAndroidPermissions] ${action} failed for ${item.permission}: ${item.error}`,
        );
      }
      return output;
    } catch (cause) {
      item.error = errorMessage(cause);
      logger.warn(
        `[GrantAndroidPermissions] ${action} threw for ${item.permission}: ${item.error}`,
      );
      return "";
    }
  }

  private async verifyPermissions(
    packageName: string,
    userId: number,
    action: "grant" | "revoke",
    attempted: Array<{ item: GrantAndroidPermissionItemResult; output: string }>,
    before: AndroidPackagePermissionState,
  ): Promise<void> {
    if (attempted.length === 0) {
      return;
    }
    try {
      const after = await this.readPermissionState(packageName, userId);
      const expected = action === "grant" ? "granted" : "denied";
      for (const attempt of attempted) {
        this.verifyPermission(attempt, before, after, userId, expected);
      }
    } catch (cause) {
      logger.warn(
        `[GrantAndroidPermissions] permission verification failed: ${errorMessage(cause)}`,
      );
      for (const { item } of attempted) {
        item.error ??= errorMessage(cause);
      }
    }
  }

  private verifyPermission(
    { item, output }: { item: GrantAndroidPermissionItemResult; output: string },
    before: AndroidPackagePermissionState,
    after: AndroidPackagePermissionState,
    userId: number,
    expected: "granted" | "denied",
  ): void {
    if (item.error) {
      return;
    }
    // Preserve the known block; missing pre-state may become runtime or install state.
    const permission = item.permission!;
    const observed =
      after.runtimePermissions.get(permission) ?? after.installPermissions.get(permission);
    const state = before.runtimePermissions.has(permission)
      ? after.runtimePermissions.get(permission)
      : before.installPermissions.has(permission)
        ? after.installPermissions.get(permission)
        : observed;
    item.success = state?.state === expected;
    if (!item.success) {
      const detail = observed
        ? `observed ${observed.state}; required state in original permission block`
        : "permission absent from runtime and install permissions";
      item.error = `Permission state verification failed for ${permission}: expected ${expected} for Android user ${userId}; ${detail}; pm output: ${output || "(empty)"}`;
      logger.warn(`[GrantAndroidPermissions] ${item.error}`);
    }
  }

  private async readPermissionState(packageName: string, userId: number) {
    try {
      const result = await this.adb.executeCommand(
        `shell dumpsys package ${shellQuote(packageName)}`,
        undefined,
        DUMPSYS_MAX_BUFFER,
        true,
      );
      if (outputLooksLikeShellFailure(result.stdout, result.stderr ?? "")) {
        throw new ActionableError(
          `Cannot read permission state for ${packageName}: ${result.stdout} ${result.stderr ?? ""}`,
        );
      }
      const state = parseAndroidRuntimePermissions(result.stdout, packageName, userId);
      if (!state) {
        throw new ActionableError(
          `Cannot parse permission state for ${packageName} (missing package or requested permissions section)`,
        );
      }
      return state;
    } catch (cause) {
      throw toActionableError(cause, `Cannot read permission state for ${packageName}`);
    }
  }

  private async resetPermissions(
    packageName: string,
    permissions: string[],
    userId: number | undefined,
    perf: PerformanceTracker,
  ): Promise<GrantAndroidPermissionsResult> {
    const resetPermissions = permissions;
    if (userId !== undefined) {
      perf.end();
      return {
        success: false,
        appId: packageName,
        userId: 0,
        results: [
          {
            stepId: "pm_reset_permissions",
            success: false,
            countsTowardSuccess: true,
            error: "Android reset is device-wide and does not support userId",
          },
        ],
        error: "Failed step(s): pm_reset_permissions",
      };
    }

    if (resetPermissions.length !== 1 || resetPermissions[0] !== "all") {
      perf.end();
      return {
        success: false,
        appId: packageName,
        userId: 0,
        results: [
          {
            stepId: "pm_reset_permissions",
            success: false,
            countsTowardSuccess: true,
            error:
              "Android reset requires permissions=['all'] because pm reset-permissions is device-wide",
          },
        ],
        error: "Failed step(s): pm_reset_permissions",
      };
    }

    try {
      await perf.track("pmResetPermissions", async () => {
        const execResult = await this.adb.executeCommand(
          "shell pm reset-permissions",
          undefined,
          undefined,
          true,
        );
        const stdout = execResult.stdout;
        const stderr = execResult.stderr ?? "";

        if (outputLooksLikeShellFailure(stdout, stderr)) {
          throw new Error(
            `${stdout}\n${stderr}`.trim() || "pm reset-permissions reported an error",
          );
        }
      });
      return {
        success: true,
        appId: packageName,
        userId: 0,
        results: [
          {
            stepId: "pm_reset_permissions",
            success: true,
            countsTowardSuccess: true,
          },
        ],
      };
    } catch (cause) {
      const message = errorMessage(cause);
      logger.warn(`[GrantAndroidPermissions] reset threw: ${message}`);
      return {
        success: false,
        appId: packageName,
        userId: 0,
        results: [
          {
            stepId: "pm_reset_permissions",
            success: false,
            countsTowardSuccess: true,
            error: message,
          },
        ],
        error: "Failed step(s): pm_reset_permissions",
      };
    } finally {
      perf.end();
    }
  }
}
