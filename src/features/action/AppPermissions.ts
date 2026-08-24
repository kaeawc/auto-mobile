import { errorMessage } from "../../utils/describeUnknownError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice } from "../../models";
import { AndroidCtrlProxyClient } from "../observe/android";
import { GrantAndroidPermissions } from "./GrantAndroidPermissions";
import { SetAndroidNotificationsEnabled } from "./SetAndroidNotificationsEnabled";
import { SetAndroidNotificationPolicyAccess } from "./SetAndroidNotificationPolicyAccess";
import {
  SetAndroidScheduleExactAlarmAppOp,
  type ScheduleExactAlarmAppOpMode,
} from "./SetAndroidScheduleExactAlarmAppOp";
import {
  IosSimulatorPermissions,
  normalizePermissions,
  type IosSimulatorPermissionAction,
  type IosSimulatorPrivacyClient,
  type TccPermissionReader,
} from "./IosSimulatorPermissions";
import {
  CtrlProxyIosPhysicalPrivacyClient,
  IosPhysicalPermissions,
  type IosPhysicalPrivacyClient,
} from "./IosPhysicalPermissions";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";

/**
 * Map requested permission names onto the runner-reported grant map.
 *
 * `granted` is decoded from the wire and `permissionNames` is caller-supplied, so the
 * membership test must be an own-property check: `permission in granted` also matches
 * inherited `Object.prototype` members, which would report a bogus permission such as
 * `toString` as "granted" (its inherited value is a truthy function) instead of
 * "unknown" (issue #4187).
 */
export function mapAndroidPermissionStates(
  permissionNames: string[],
  granted: Record<string, boolean>,
): AppPermissionStateResult[] {
  return permissionNames.map((permission) => {
    if (Object.hasOwn(granted, permission)) {
      return {
        permission,
        state: granted[permission] ? "granted" : "denied",
        source: "androidRuntime" as const,
        raw: { granted: granted[permission] },
      };
    }
    return {
      permission,
      state: "unknown" as const,
      source: "androidRuntime" as const,
    };
  });
}

export type AppPermissionAction = IosSimulatorPermissionAction;

export interface SetAppPermissionsInput {
  action?: AppPermissionAction;
  permissions?: string[];
  userId?: number;
  notificationsEnabled?: boolean;
  notificationPolicyAccess?: boolean;
  scheduleExactAlarm?: ScheduleExactAlarmAppOpMode;
}

export interface GetAppPermissionsInput {
  permissions?: string[];
}

export type AppPermissionState = "granted" | "denied" | "unknown" | "limited";

export interface AppPermissionStateResult {
  permission: string;
  state: AppPermissionState;
  service?: string;
  source: "androidRuntime" | "iosTcc";
  authValue?: number;
  raw?: Record<string, string | number | boolean | null>;
}

export interface AppPermissionOperationResult {
  operationId: string;
  success: boolean;
  changedCount: number;
  failedCount: number;
  skipped?: boolean;
  result?: unknown;
  error?: string;
}

export interface SetAppPermissionsResult {
  success: boolean;
  appId: string;
  deviceId: string;
  platform: "android" | "ios";
  action: AppPermissionAction;
  changedCount: number;
  failedCount: number;
  operations: AppPermissionOperationResult[];
  error?: string;
}

export interface GetAppPermissionsResult {
  success: boolean;
  appId: string;
  deviceId: string;
  platform: "android" | "ios";
  permissions: AppPermissionStateResult[];
  error?: string;
}

export interface AppPermissionsDependencies {
  adbFactory?: AdbClientFactory;
  simctl?: IosSimulatorPrivacyClient | null;
  tccReader?: TccPermissionReader | null;
  iosPhysicalClient?: IosPhysicalPrivacyClient | null;
}

function parseAndroidRuntimePermissions(output: string): Map<string, AppPermissionStateResult> {
  const permissions = new Map<string, AppPermissionStateResult>();
  const permissionLine = /^\s*([A-Za-z0-9_.]+):\s+granted=(true|false)\b(.*)$/;

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(permissionLine);
    if (!match) {
      continue;
    }

    const [, permission, granted, rest] = match;
    permissions.set(permission, {
      permission,
      state: granted === "true" ? "granted" : "denied",
      source: "androidRuntime",
      raw: {
        granted: granted === "true",
        flags: rest.trim() || null,
      },
    });
  }

  return permissions;
}

export class AppPermissions {
  private device: BootedDevice;

  private adbFactory: AdbClientFactory;

  private simctl: IosSimulatorPrivacyClient | null;

  private tccReader: TccPermissionReader | null;

  private iosPhysicalClient: IosPhysicalPrivacyClient | null;

  constructor(device: BootedDevice, dependencies: AppPermissionsDependencies = {}) {
    this.device = device;
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.simctl = dependencies.simctl ?? null;
    this.tccReader = dependencies.tccReader ?? null;
    this.iosPhysicalClient = dependencies.iosPhysicalClient ?? null;
  }

  async setPermissions(
    appId: string,
    input: SetAppPermissionsInput,
  ): Promise<SetAppPermissionsResult> {
    const action = input.action ?? "grant";
    return this.device.platform === "ios"
      ? this.setIosPermissions(appId, action, input)
      : this.setAndroidPermissions(appId, action, input);
  }

  async getPermissions(
    appId: string,
    input: GetAppPermissionsInput = {},
  ): Promise<GetAppPermissionsResult> {
    return this.device.platform === "ios"
      ? this.getIosPermissions(appId, input)
      : this.getAndroidPermissions(appId, input);
  }

  private async setIosPermissions(
    appId: string,
    action: AppPermissionAction,
    input: SetAppPermissionsInput,
  ): Promise<SetAppPermissionsResult> {
    const permissions = normalizePermissions(input.permissions);
    const unsupportedFields: string[] = [];
    if (input.notificationPolicyAccess !== undefined) {
      unsupportedFields.push("notificationPolicyAccess");
    }
    if (input.notificationsEnabled !== undefined) {
      unsupportedFields.push("notificationsEnabled");
    }
    if (input.scheduleExactAlarm !== undefined) {
      unsupportedFields.push("scheduleExactAlarm");
    }
    if (unsupportedFields.length > 0) {
      const error = `setAppPermissions does not support the following fields on iOS: ${unsupportedFields.join(", ")}`;
      return {
        success: false,
        appId,
        deviceId: this.device.deviceId,
        platform: "ios",
        action,
        changedCount: 0,
        failedCount: 0,
        operations: [],
        error,
      };
    }

    // Physical iOS devices cannot use simctl privacy; route reset through the
    // CtrlProxy XCUITest runner (grant/revoke surface a clear "reset only" failure).
    if (!isIosSimulatorUdid(this.device.deviceId)) {
      return this.setIosPhysicalPermissions(appId, action, permissions);
    }

    const iosPermissions = new IosSimulatorPermissions(this.device, this.simctl, this.tccReader);
    const result = await iosPermissions.setPermissions(action, appId, permissions);

    return {
      success: result.success,
      appId: result.appId,
      deviceId: result.deviceId,
      platform: result.platform,
      action,
      changedCount: result.changedCount,
      failedCount: result.failedCount,
      operations: result.results.map((permissionResult) => ({
        operationId: `ios_simctl_privacy:${action}:${permissionResult.permission}`,
        success: permissionResult.success,
        changedCount: permissionResult.success ? 1 : 0,
        failedCount: permissionResult.success ? 0 : 1,
        result: permissionResult,
        ...(permissionResult.error ? { error: permissionResult.error } : {}),
      })),
      ...(result.error ? { error: result.error } : {}),
    };
  }

  private async setIosPhysicalPermissions(
    appId: string,
    action: AppPermissionAction,
    permissions: string[],
  ): Promise<SetAppPermissionsResult> {
    const client = this.iosPhysicalClient ?? new CtrlProxyIosPhysicalPrivacyClient(this.device);
    const iosPermissions = new IosPhysicalPermissions(this.device, client);
    const result = await iosPermissions.setPermissions(action, appId, permissions);

    return {
      success: result.success,
      appId: result.appId,
      deviceId: result.deviceId,
      platform: result.platform,
      action,
      changedCount: result.changedCount,
      failedCount: result.failedCount,
      operations: result.results.map((permissionResult) => ({
        operationId: `ios_xcuitest_reset:${action}:${permissionResult.permission}`,
        success: permissionResult.success,
        changedCount: permissionResult.success ? 1 : 0,
        failedCount: permissionResult.success ? 0 : 1,
        result: permissionResult,
        ...(permissionResult.error ? { error: permissionResult.error } : {}),
      })),
      ...(result.error ? { error: result.error } : {}),
    };
  }

  private async setAndroidPermissions(
    appId: string,
    action: AppPermissionAction,
    input: SetAppPermissionsInput,
  ): Promise<SetAppPermissionsResult> {
    const permissions = normalizePermissions(input.permissions);
    const requestedPermissions = input.permissions ?? [];
    const operations: AppPermissionOperationResult[] = [];
    const invalidResetRequest =
      action === "reset" &&
      (input.userId !== undefined ||
        requestedPermissions.length !== 1 ||
        requestedPermissions[0] !== "all");

    if (permissions.length > 0 || invalidResetRequest) {
      const permissionResult = await new GrantAndroidPermissions(
        this.device,
        this.adbFactory,
      ).execute(appId, {
        action,
        permissions: action === "reset" ? requestedPermissions : permissions,
        userId: input.userId,
      });
      const changedCount = permissionResult.results.filter(
        (result) => result.success && !result.skipped,
      ).length;
      const failedCount = permissionResult.results.filter(
        (result) => result.countsTowardSuccess && !result.success && !result.skipped,
      ).length;
      operations.push({
        operationId: `android_runtime_permissions:${action}`,
        success: permissionResult.success,
        changedCount,
        failedCount,
        result: permissionResult,
        ...(permissionResult.error ? { error: permissionResult.error } : {}),
      });
    }

    if (!invalidResetRequest && input.notificationsEnabled !== undefined) {
      const result = await new SetAndroidNotificationsEnabled(this.device, this.adbFactory).execute(
        appId,
        {
          enabled: input.notificationsEnabled,
        },
      );
      operations.push({
        operationId: "android_notifications_enabled",
        success: result.success,
        changedCount: result.success ? 1 : 0,
        failedCount: result.success ? 0 : 1,
        result,
        ...(result.error ? { error: result.error } : {}),
      });
    }

    if (!invalidResetRequest && input.notificationPolicyAccess !== undefined) {
      const result = await new SetAndroidNotificationPolicyAccess(
        this.device,
        this.adbFactory,
      ).execute(appId, {
        allowed: input.notificationPolicyAccess,
      });
      operations.push({
        operationId: "android_notification_policy_access",
        success: result.success,
        changedCount: result.success ? 1 : 0,
        failedCount: result.success ? 0 : 1,
        result,
        ...(result.error ? { error: result.error } : {}),
      });
    }

    if (!invalidResetRequest && input.scheduleExactAlarm !== undefined) {
      const result = await new SetAndroidScheduleExactAlarmAppOp(
        this.device,
        this.adbFactory,
      ).execute(appId, {
        mode: input.scheduleExactAlarm,
      });
      operations.push({
        operationId: "android_schedule_exact_alarm_appop",
        success: result.success,
        changedCount: result.success && !result.skipped ? 1 : 0,
        failedCount: result.success ? 0 : 1,
        skipped: result.skipped,
        result,
        ...(result.error ? { error: result.error } : {}),
      });
    }

    if (operations.length === 0) {
      operations.push({
        operationId: "app_permissions:no_operation",
        success: false,
        changedCount: 0,
        failedCount: 1,
        error: "Provide at least one permission or Android-specific permission option",
      });
    }

    const failedOperations = operations.filter((operation) => !operation.success);

    return {
      success: failedOperations.length === 0,
      appId,
      deviceId: this.device.deviceId,
      platform: "android",
      action,
      changedCount: operations.reduce((sum, operation) => sum + operation.changedCount, 0),
      failedCount: operations.reduce((sum, operation) => sum + operation.failedCount, 0),
      operations,
      ...(failedOperations.length > 0
        ? {
            error: failedOperations
              .map((operation) => operation.error ?? operation.operationId)
              .join("; "),
          }
        : {}),
    };
  }

  private async getIosPermissions(
    appId: string,
    input: GetAppPermissionsInput,
  ): Promise<GetAppPermissionsResult> {
    // Physical iOS devices expose no readable TCC store, so permission state
    // cannot be queried; mirror the set path's simulator/physical split and
    // surface a physical-aware failure instead of the simulator-only message.
    if (!isIosSimulatorUdid(this.device.deviceId)) {
      return {
        success: false,
        appId: appId.trim(),
        deviceId: this.device.deviceId,
        platform: "ios",
        permissions: [],
        error:
          "iOS permission state queries are not available on physical devices (no readable TCC store); use setAppPermissions with action=reset to re-arm the system prompt",
      };
    }

    const iosPermissions = new IosSimulatorPermissions(this.device, this.simctl, this.tccReader);
    const result = await iosPermissions.getPermissions(
      appId,
      normalizePermissions(input.permissions),
    );

    return {
      success: result.success,
      appId: result.appId,
      deviceId: result.deviceId,
      platform: result.platform,
      permissions: result.permissions.map((permission) => ({
        permission: permission.permission,
        service: permission.service,
        state: permission.state,
        source: "iosTcc",
        ...(permission.authValue === undefined ? {} : { authValue: permission.authValue }),
        ...(permission.raw ? { raw: permission.raw } : {}),
      })),
      ...(result.error ? { error: result.error } : {}),
    };
  }

  private async getAndroidPermissions(
    appId: string,
    input: GetAppPermissionsInput,
  ): Promise<GetAppPermissionsResult> {
    const normalizedAppId = appId.trim();
    const requestedPermissions = normalizePermissions(input.permissions);

    if (!normalizedAppId) {
      return this.androidQueryFailure(
        normalizedAppId,
        "appId must be a non-empty Android package name",
      );
    }

    // Try WebSocket PackageManager first; fall back to ADB dumpsys on failure.
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const info = await a11y.requestPackageInfo(
        normalizedAppId,
        { includePermissions: true },
        4000,
      );
      if (info.success) {
        const granted = info.grantedPermissions;
        const allKeys =
          info.requestedPermissions.length > 0 ? info.requestedPermissions : Object.keys(granted);
        const permissionNames = requestedPermissions.length > 0 ? requestedPermissions : allKeys;
        return {
          success: true,
          appId: normalizedAppId,
          deviceId: this.device.deviceId,
          platform: "android",
          permissions: mapAndroidPermissionStates(permissionNames, granted),
        };
      }
    } catch {
      // fall through to ADB
    }

    try {
      const adb: AdbExecutor = this.adbFactory.create(this.device);
      const result = await adb.executeCommand(
        `shell dumpsys package ${normalizedAppId}`,
        undefined,
        undefined,
        true,
      );
      const stdout = result.stdout ?? "";
      if (/Unable to find package/i.test(stdout)) {
        return this.androidQueryFailure(
          normalizedAppId,
          `Package not installed: ${normalizedAppId}`,
        );
      }
      const parsed = parseAndroidRuntimePermissions(stdout);
      if (parsed.size === 0 && !/Package \[/.test(stdout)) {
        return this.androidQueryFailure(
          normalizedAppId,
          `Package lookup returned no data for ${normalizedAppId}`,
        );
      }
      const permissionNames =
        requestedPermissions.length > 0 ? requestedPermissions : [...parsed.keys()];

      return {
        success: true,
        appId: normalizedAppId,
        deviceId: this.device.deviceId,
        platform: "android",
        permissions: permissionNames.map(
          (permission) =>
            parsed.get(permission) ?? {
              permission,
              state: "unknown",
              source: "androidRuntime",
            },
        ),
      };
    } catch (error) {
      return this.androidQueryFailure(normalizedAppId, errorMessage(error));
    }
  }

  private androidQueryFailure(appId: string, error: string): GetAppPermissionsResult {
    return {
      success: false,
      appId,
      deviceId: this.device.deviceId,
      platform: "android",
      permissions: [],
      error,
    };
  }
}
