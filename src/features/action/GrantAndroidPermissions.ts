import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { BootedDevice, GrantAndroidPermissionItemResult, GrantAndroidPermissionsResult } from "../../models";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";


export interface GrantAndroidPermissionsInput {
  permissions: string[];
  userId?: number;
}


export class GrantAndroidPermissions {
  private device: BootedDevice;

  private adb: AdbExecutor;

  constructor(device: BootedDevice, adbFactory: AdbClientFactory = defaultAdbClientFactory) {
    this.device = device;
    this.adb = adbFactory.create(device);
  }

  async execute(packageName: string, input: GrantAndroidPermissionsInput): Promise<GrantAndroidPermissionsResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("grantAndroidPermissions");

    const permissions = input.permissions ?? [];

    if (this.device.platform !== "android") {
      perf.end();
      return {
        success: false,
        appId: packageName,
        userId: input.userId ?? 0,
        results: [],
        error: "grantAndroidPermissions is only supported on Android devices",
      };
    }

    if (permissions.length === 0) {
      perf.end();
      return {
        success: false,
        appId: packageName,
        userId: input.userId ?? 0,
        results: [],
        error: "Provide at least one permission in `permissions`",
      };
    }

    const targetUserId = await perf.track("detectTargetUser", async () => {
      return (await new AndroidUserTargetResolver(this.adb).resolve({ packageName, explicitUserId: input.userId })).userId;
    });

    const results: GrantAndroidPermissionItemResult[] = [];

    try {
      for (const permission of permissions) {
        const trimmed = permission.trim();
        if (!trimmed) {
          results.push({
            operationId: "pm_grant:(empty)",
            permission,
            success: false,
            countsTowardSuccess: true,
            error: "empty permission name",
          });
          continue;
        }

        const cmd = `shell pm grant --user ${targetUserId} ${packageName} ${trimmed}`;

        try {
          await perf.track(`pmGrant:${trimmed}`, async () => {
            const execResult = await this.adb.executeCommand(cmd, undefined, undefined, true);
            const stdout = execResult.stdout ?? "";
            const stderr = execResult.stderr ?? "";

            if (outputLooksLikeShellFailure(stdout, stderr)) {
              const message = `${stdout}\n${stderr}`.trim() || "pm grant reported an error";
              results.push({
                operationId: `pm_grant:${trimmed}`,
                permission: trimmed,
                success: false,
                countsTowardSuccess: true,
                error: message,
              });
              logger.warn(`[GrantAndroidPermissions] Grant failed for ${trimmed}: ${message}`);
              return;
            }

            results.push({
              operationId: `pm_grant:${trimmed}`,
              permission: trimmed,
              success: true,
              countsTowardSuccess: true,
            });
            logger.info(`[GrantAndroidPermissions] Granted ${trimmed} to ${packageName} (user ${targetUserId})`);
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          results.push({
            operationId: `pm_grant:${trimmed}`,
            permission: trimmed,
            success: false,
            countsTowardSuccess: true,
            error: message,
          });
          logger.warn(`[GrantAndroidPermissions] Grant threw for ${trimmed}: ${message}`);
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
                : "One or more required grant steps failed",
        }),
    };
  }
}
