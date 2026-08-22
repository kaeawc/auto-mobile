import { errorMessage } from "../../utils/describeUnknownError";
import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { BootedDevice, GrantAndroidPermissionItemResult, GrantAndroidPermissionsResult } from "../../models";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker, type PerformanceTracker } from "../../utils/PerformanceTracker";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { shellQuote } from "../../utils/shellQuote";


export type AndroidPermissionChangeAction = "grant" | "revoke" | "reset";

export interface GrantAndroidPermissionsInput {
  action?: AndroidPermissionChangeAction;
  permissions: string[];
  userId?: number;
}


export class GrantAndroidPermissions {
  private device: BootedDevice;

  private adb: AdbExecutor;

  private createPerformanceTracker: () => PerformanceTracker;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    performanceTrackerFactory: () => PerformanceTracker = createGlobalPerformanceTracker
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.createPerformanceTracker = performanceTrackerFactory;
  }

  async execute(packageName: string, input: GrantAndroidPermissionsInput): Promise<GrantAndroidPermissionsResult> {
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
    perf: PerformanceTracker
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

    const targetUserId = await perf.track("detectTargetUser", async () => {
      return (await new AndroidUserTargetResolver(this.adb).resolve({ packageName, explicitUserId: userId })).userId;
    });

    const results: GrantAndroidPermissionItemResult[] = [];

    try {
      for (const permission of permissions) {
        const trimmed = permission.trim();
        if (!trimmed) {
          results.push({
            operationId: `pm_${action}:(empty)`,
            permission,
            success: false,
            countsTowardSuccess: true,
            error: "empty permission name",
          });
          continue;
        }

        const cmd = `shell pm ${action} --user ${targetUserId} ${shellQuote(packageName)} ${shellQuote(trimmed)}`;

        try {
          await perf.track(`pm${action[0].toUpperCase()}${action.slice(1)}:${trimmed}`, async () => {
            const execResult = await this.adb.executeCommand(cmd, undefined, undefined, true);
            const stdout = execResult.stdout ?? "";
            const stderr = execResult.stderr ?? "";

            if (outputLooksLikeShellFailure(stdout, stderr)) {
              const message = `${stdout}\n${stderr}`.trim() || `pm ${action} reported an error`;
              results.push({
                operationId: `pm_${action}:${trimmed}`,
                permission: trimmed,
                success: false,
                countsTowardSuccess: true,
                error: message,
              });
              logger.warn(`[GrantAndroidPermissions] ${action} failed for ${trimmed}: ${message}`);
              return;
            }

            results.push({
              operationId: `pm_${action}:${trimmed}`,
              permission: trimmed,
              success: true,
              countsTowardSuccess: true,
            });
            logger.info(`[GrantAndroidPermissions] ${action} ${trimmed} for ${packageName} (user ${targetUserId})`);
          });
        } catch (cause) {
          const message = errorMessage(cause);
          results.push({
            operationId: `pm_${action}:${trimmed}`,
            permission: trimmed,
            success: false,
            countsTowardSuccess: true,
            error: message,
          });
          logger.warn(`[GrantAndroidPermissions] ${action} threw for ${trimmed}: ${message}`);
        }
      }
    } finally {
      perf.end();
    }

    const success = results.every(
      r => r.skipped || r.success || r.countsTowardSuccess === false
    );

    const failedRequired = results.filter(
      r => r.countsTowardSuccess && !r.skipped && !r.success
    );

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
                ? `Failed step(s): ${failedRequired.map(f => f.operationId).join(", ")}`
                : "One or more required Android permission changes failed",
        }),
    };
  }

  private async resetPermissions(
    packageName: string,
    permissions: string[],
    userId: number | undefined,
    perf: PerformanceTracker
  ): Promise<GrantAndroidPermissionsResult> {
    const resetPermissions = permissions;
    if (userId !== undefined) {
      perf.end();
      return {
        success: false,
        appId: packageName,
        userId: 0,
        results: [{
          operationId: "pm_reset_permissions",
          success: false,
          countsTowardSuccess: true,
          error: "Android reset is device-wide and does not support userId",
        }],
        error: "Failed step(s): pm_reset_permissions",
      };
    }

    if (resetPermissions.length !== 1 || resetPermissions[0] !== "all") {
      perf.end();
      return {
        success: false,
        appId: packageName,
        userId: 0,
        results: [{
          operationId: "pm_reset_permissions",
          success: false,
          countsTowardSuccess: true,
          error: "Android reset requires permissions=['all'] because pm reset-permissions is device-wide",
        }],
        error: "Failed step(s): pm_reset_permissions",
      };
    }

    try {
      await perf.track("pmResetPermissions", async () => {
        const execResult = await this.adb.executeCommand("shell pm reset-permissions", undefined, undefined, true);
        const stdout = execResult.stdout ?? "";
        const stderr = execResult.stderr ?? "";

        if (outputLooksLikeShellFailure(stdout, stderr)) {
          throw new Error(`${stdout}\n${stderr}`.trim() || "pm reset-permissions reported an error");
        }
      });
      return {
        success: true,
        appId: packageName,
        userId: 0,
        results: [{
          operationId: "pm_reset_permissions",
          success: true,
          countsTowardSuccess: true,
        }],
      };
    } catch (cause) {
      const message = errorMessage(cause);
      logger.warn(`[GrantAndroidPermissions] reset threw: ${message}`);
      return {
        success: false,
        appId: packageName,
        userId: 0,
        results: [{
          operationId: "pm_reset_permissions",
          success: false,
          countsTowardSuccess: true,
          error: message,
        }],
        error: "Failed step(s): pm_reset_permissions",
      };
    } finally {
      perf.end();
    }
  }
}
